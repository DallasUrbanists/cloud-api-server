import { ReflectionKind } from 'typedoc';
import { MarkdownTheme, MemberRouter } from 'typedoc-plugin-markdown';

function singleExportedClass(module) {
  return module?.kind === ReflectionKind.Module
    && module.children?.length === 1
    && module.children[0].kind === ReflectionKind.Class
    && !module.documents?.length
    ? module.children[0]
    : undefined;
}

export class PortalMarkdownRouter extends MemberRouter {
  buildPages(project) {
    const pages = super.buildPages(project);
    // VitePress's integration rewrites underscores in links to hyphens; explicit
    // anchors and router URLs must agree before Markdown is rendered.
    const replacements = new Map();
    const used = new Set();
    for (const [reflection, anchor] of this.anchors) {
      const url = this.fullUrls.get(reflection);
      const base = url.slice(0, url.indexOf('#'));
      const key = `${base}#${anchor}`;
      if (!replacements.has(key)) {
        const normalized = anchor.replace(/_/g, '-');
        let candidate = normalized;
        for (let suffix = 1; used.has(`${base}#${candidate}`); suffix++) candidate = `${normalized}-${suffix}`;
        replacements.set(key, candidate);
        used.add(`${base}#${candidate}`);
      }
      const normalized = replacements.get(key);
      this.anchors.set(reflection, normalized);
      this.fullUrls.set(reflection, `${base}#${normalized}`);
    }
    return pages;
  }

  buildChildPages(reflection, pages) {
    const module = reflection.parent;
    if (singleExportedClass(module) === reflection) {
      this.buildAnchors(reflection, module);
      return;
    }
    super.buildChildPages(reflection, pages);
  }
}

export class PortalMarkdownTheme extends MarkdownTheme {
  getRenderContext(page) {
    const context = super.getRenderContext(page);
    context.partials.constructor = (model, options) => model.signatures?.map(signature => {
      const anchor = context.router.getAnchor(model);
      const title = `Constructor${anchor ? ` {#${anchor}}` : ''}`;
      return `${'#'.repeat(options.headingLevel)} ${title}\n\n${context.partials.signature(signature, { headingLevel: options.headingLevel + 1 })}`;
    }).join('\n\n') ?? '';
    if (page.model.kind === ReflectionKind.Module) {
      const parts = page.model.name.split('/');
      const title = parts.pop();
      context.partials.breadcrumbs = () => parts.length ? `${parts.join('/')}/` : '';
      context.partials.pageTitle = () => title;
      const onlyClass = singleExportedClass(page.model);
      if (onlyClass) {
        const body = context.partials.body;
        context.partials.body = (model, options) => model === page.model
          ? `## ${onlyClass.name} {#${context.router.getAnchor(onlyClass)}}\n\n${context.partials.memberWithGroups(onlyClass, { headingLevel: 2 })}`
          : body(model, options);
      }
    } else if ([
      ReflectionKind.Interface,
      ReflectionKind.TypeAlias,
      ReflectionKind.Variable,
      ReflectionKind.Function,
      ReflectionKind.Class,
    ].includes(page.model.kind)) {
      context.partials.breadcrumbs = () => {
        const ancestors = [];
        let parent = page.model.parent;
        while (parent && parent.kind !== ReflectionKind.Project) {
          ancestors.unshift(`[${parent.name}](${context.urlTo(parent)})`);
          parent = parent.parent;
        }
        return ancestors.length ? `${ancestors.join(' / ')}/` : '';
      };
      context.partials.pageTitle = () => page.model.name;
    }
    return context;
  }
}

export function load(app) {
  app.renderer.defineTheme('portal', PortalMarkdownTheme);
  app.renderer.defineRouter('portal', PortalMarkdownRouter);
}
