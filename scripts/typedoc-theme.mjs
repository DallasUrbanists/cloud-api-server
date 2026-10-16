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
    if (page.model.kind === ReflectionKind.Module) {
      const parts = page.model.name.split('/');
      const title = parts.pop();
      context.partials.breadcrumbs = () => parts.length ? `${parts.join('/')}/` : '';
      context.partials.pageTitle = () => title;
      const onlyClass = singleExportedClass(page.model);
      if (onlyClass) {
        const body = context.partials.body;
        context.partials.body = (model, options) => model === page.model
          ? `## ${onlyClass.name}\n\n${context.partials.memberWithGroups(onlyClass, { headingLevel: 2 })}`
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
