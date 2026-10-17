import test from 'node:test';
import assert from 'node:assert/strict';
import { Application, DeclarationReflection, ProjectReflection, ReflectionKind } from 'typedoc';
import { PortalMarkdownRouter, PortalMarkdownTheme } from '../scripts/typedoc-theme.mjs';

for (const [name, breadcrumb, title] of [
  ['models/recommendableAction', 'models/', 'recommendableAction'],
  ['services/research/source', 'services/research/', 'source'],
  ['standalone', '', 'standalone'],
]) {
  test(`module headers separate the containing path from ${name}`, () => {
    const context = PortalMarkdownTheme.prototype.getRenderContext.call(
      { router: {}, owner: {}, application: { options: {} } },
      { model: { kind: ReflectionKind.Module, name } },
    );
    assert.equal(context.partials.breadcrumbs(), breadcrumb);
    assert.equal(context.partials.pageTitle(), title);
  });
}

for (const [kind, name] of [
  [ReflectionKind.Interface, 'RecommendableAction'],
  [ReflectionKind.TypeAlias, 'RecommendableStatus'],
  [ReflectionKind.Variable, 'RECOMMENDABLE_STATUSES'],
  [ReflectionKind.Function, 'anyBoundaryOverlap'],
  [ReflectionKind.Class, 'RecommendableActionController'],
]) {
  test(`symbol headers show only ancestor breadcrumbs and the name ${name}`, () => {
    const project = { kind: ReflectionKind.Project, name: 'Project' };
    const module = { kind: ReflectionKind.Module, name: 'models/recommendableAction', parent: project };
    const context = PortalMarkdownTheme.prototype.getRenderContext.call(
      {
        router: { hasUrl: () => true, relativeUrl: () => '../index.md' },
        owner: {},
        application: { options: { getValue: () => undefined } },
      },
      { model: { kind, name, parent: module } },
    );
    assert.equal(context.partials.breadcrumbs(), '[models/recommendableAction](../index.md)/');
    assert.equal(context.partials.pageTitle(), name);
  });
}

test('nested symbol breadcrumbs keep each linked ancestor without repeating the current symbol', () => {
  const project = { kind: ReflectionKind.Project, name: 'Project' };
  const module = { kind: ReflectionKind.Module, name: 'models/recommendableAction', parent: project };
  const namespace = { kind: ReflectionKind.Namespace, name: 'Nested', parent: module };
  const context = PortalMarkdownTheme.prototype.getRenderContext.call(
    {
      router: { hasUrl: () => true, relativeUrl: (_current, ancestor) => `${ancestor.name}.md` },
      owner: {},
      application: { options: { getValue: () => undefined } },
    },
    { model: { kind: ReflectionKind.Interface, name: 'Example', parent: namespace } },
  );
  assert.equal(context.partials.breadcrumbs(), '[models/recommendableAction](models/recommendableAction.md) / [Nested](Nested.md)/');
  assert.equal(context.partials.pageTitle(), 'Example');
});

test('top-level symbols do not display an empty project breadcrumb', () => {
  const context = PortalMarkdownTheme.prototype.getRenderContext.call(
    { router: {}, owner: {}, application: { options: {} } },
    { model: { kind: ReflectionKind.Function, name: 'example', parent: { kind: ReflectionKind.Project } } },
  );
  assert.equal(context.partials.breadcrumbs(), '');
  assert.equal(context.partials.pageTitle(), 'example');
});

test('single-class modules render class details without an extra Classes index', () => {
  const onlyClass = { kind: ReflectionKind.Class, name: 'ExampleController' };
  const module = { kind: ReflectionKind.Module, name: 'controllers/example', children: [onlyClass] };
  const context = PortalMarkdownTheme.prototype.getRenderContext.call(
    { router: { getAnchor: () => 'symbol-examplecontroller' }, owner: {}, application: { options: {} } },
    { model: module },
  );
  context.partials.memberWithGroups = (model, options) => {
    assert.equal(model, onlyClass);
    assert.equal(options.headingLevel, 2);
    return 'Class description and methods';
  };
  assert.equal(context.partials.body(module, { headingLevel: 2 }), '## ExampleController {#symbol-examplecontroller}\n\nClass description and methods');
});

test('router combines only sole-class exports and preserves multi-export reference pages', async () => {
  const app = await Application.bootstrapWithPlugins({ options: 'typedoc.json' });
  const project = new ProjectReflection('Router test');
  const add = (parent, name, kind) => {
    const reflection = new DeclarationReflection(name, kind, parent);
    parent.addChild(reflection);
    project.registerReflection(reflection);
    return reflection;
  };
  const single = add(project, 'controllers/example', ReflectionKind.Module);
  const onlyClass = add(single, 'ExampleController', ReflectionKind.Class);
  const method = add(onlyClass, 'submit', ReflectionKind.Method);
  const multi = add(project, 'models/example', ReflectionKind.Module);
  const separateClass = add(multi, 'ExampleModel', ReflectionKind.Class);
  const separateType = add(multi, 'ExampleInput', ReflectionKind.Interface);
  const underscored = add(separateType, 'max_characters', ReflectionKind.Property);
  const hyphenated = add(separateType, 'max-characters', ReflectionKind.Property);
  const routes = add(project, 'routes/example', ReflectionKind.Module);
  const route = add(routes, 'default', ReflectionKind.Variable);
  const router = new PortalMarkdownRouter(app);
  const pages = router.buildPages(project);
  assert.ok(pages.some(page => page.model === single));
  assert.ok(!pages.some(page => page.model === onlyClass));
  assert.ok(router.getFullUrl(onlyClass).startsWith(router.getFullUrl(single) + '#'));
  assert.ok(router.getFullUrl(method).startsWith(router.getFullUrl(single) + '#'));
  assert.ok(pages.some(page => page.model === separateClass));
  assert.ok(pages.some(page => page.model === separateType));
  assert.ok(pages.some(page => page.model === route));
  assert.ok(router.getAnchor(underscored).includes('symbol-max-characters'));
  assert.ok(!router.getAnchor(underscored).includes('_'));
  assert.notEqual(router.getAnchor(underscored), router.getAnchor(hyphenated));
  assert.ok(router.getFullUrl(underscored).endsWith('#' + router.getAnchor(underscored)));
});

test('model stories remain introductory prose and example tags preserve prose separately from code', async () => {
  const app = await Application.bootstrapWithPlugins({ options: 'typedoc.json' });
  const project = await app.convert();
  assert.ok(project);
  const model = project.getReflectionsByKind(ReflectionKind.Module)
    .find(reflection => reflection.name === 'models/recommendableAction');
  assert.ok(model?.comment);
  assert.ok(model.comment.summary.some(part => part.kind === 'text' && part.text.includes("Let's imagine")));
  assert.ok(!model.comment.blockTags.some(tag => tag.tag === '@example'));

  const overlap = project.getReflectionsByKind(ReflectionKind.Function)
    .find(reflection => reflection.name === 'anyBoundaryOverlap');
  const overlapExample = overlap?.signatures?.[0].comment?.blockTags.find(tag => tag.tag === '@example');
  assert.ok(overlapExample);
  assert.equal(overlapExample.content[0].kind, 'text');
  assert.ok(overlapExample.content[0].text.includes('Downtown and Uptown'));
  assert.ok(overlapExample.content.some(part => part.kind === 'code' && part.text.includes('anyBoundaryOverlap')));
  assert.ok(!overlapExample.content.some(part => part.kind === 'code' && part.text.includes("Let's imagine")));

  const extraction = project.getReflectionsByKind(ReflectionKind.Method)
    .find(reflection => reflection.name === 'extractCandidate');
  const story = extraction?.signatures?.[0].comment?.blockTags.find(tag => tag.tag === '@example');
  assert.ok(story);
  assert.ok(story.content.every(part => part.kind === 'text'));
  assert.ok(story.content.some(part => part.text.includes("Let's imagine")));
});

test('constructor headings publish the router anchor for inherited references', () => {
  const context = PortalMarkdownTheme.prototype.getRenderContext.call(
    { router: { getAnchor: () => 'symbol-constructor' }, owner: {}, application: { options: {} } },
    { model: { kind: ReflectionKind.Class, name: 'Example' } },
  );
  context.partials.signature = () => 'Constructor signature';
  assert.equal(context.partials.constructor({ signatures: [{}] }, { headingLevel: 3 }),
    '### Constructor {#symbol-constructor}\n\nConstructor signature');
});

test('other page kinds retain the Markdown theme partials', () => {
  const context = PortalMarkdownTheme.prototype.getRenderContext.call(
    { router: {}, owner: {}, application: { options: {} } },
    { model: { kind: ReflectionKind.Project, name: 'Project' } },
  );
  assert.equal(context.partials.breadcrumbs.name, 'breadcrumbs');
  assert.equal(context.partials.pageTitle.name, 'pageTitle');
});
