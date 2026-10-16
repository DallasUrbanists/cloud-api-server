# Developer documentation

Start with the [Recommendable Actions system view](recommendable-actions.md), then explore the [generated module and symbol reference](reference/index.md). Both use the same portal navigation, theme, layout, and local search. The [documentation conventions](documentation-conventions.md) describe what belongs in comments, OpenAPI, and architecture pages.

## Documentation layers

- **Feature overview:** responsibilities, dependencies, and workflows, maintained as Markdown.
- **Code reference:** generated from TypeScript declarations and TSDoc-style comments. Currently limited to the four Recommendable Actions pilot modules; this is not yet a reference for the entire system.
- **HTTP reference:** the existing Swagger UI at `/docs` on a running API server. The [OpenAPI source](../src/docs/swagger.ts) remains authoritative for HTTP contracts. This static site does not start the API or duplicate its schemas.

## Build and read locally

```powershell
npm run docs:check
npm run docs:build
npm run docs:preview
```

Open the localhost URL printed by the preview command (normally `http://localhost:4173`). Serve the site over HTTP rather than opening HTML directly, since the portal and diagrams use JavaScript modules.

`docs:check` converts and validates the TypeDoc pilot without emitting files; it does not validate portal pages. `docs:reference` uses TypeDoc, the Markdown plugin, and its VitePress integration to generate Markdown and sidebar data in `docs/reference`. `docs:build` regenerates that reference, then renders guides and code reference together through VitePress with dead-link checking. Both reject TypeDoc warnings. No database, API keys, cloud access, or CDN scripts are needed. Generated Markdown and HTML are ignored by Git; edit source comments and authored guides, not generated reference pages.

For live guide editing, use `npm run docs:dev` (normally `http://localhost:5173`). It generates TypeDoc once before starting VitePress. After changing TypeScript comments, run `npm run docs:reference` again. Restart `docs:dev` after adding or removing symbols so the generated sidebar is reloaded.

The complete static site is in `docs-site`; serve that directory at a host's URL root. The reference lives at `/reference/` as native portal pages, not a separate HTML application. Subpath hosting requires adjusting VitePress's base. Existing non-pilot Operation Groups documentation is not yet included in portal navigation.

Source links target the repository's `main` branch. Changes not yet pushed there will not appear in those links. Generated documentation includes the local comments at build time regardless.

Mermaid fences render as diagrams in the browser, adapt to light/dark mode, and retain an expandable source view. Wide diagrams scroll within their frame instead of shrinking labels to unreadable sizes; the frame is keyboard-focusable. Rendering uses the locally bundled Mermaid dependency with strict security; diagrams are not submitted to an external rendering service. Invalid diagrams show a fallback message and source, so diagram edits also need browser review.

## Automated checks

The [Documentation workflow](../.github/workflows/documentation.yml) runs on every pull request, pushes to `main`, and manual dispatch. It uses Node 24 on Ubuntu and Windows, installs the locked dependencies with `npm ci`, then runs `npm run docs:build`. Windows remains included to exercise the path-casing workaround. There are no path filters, so the checks also run when imported source types or configuration change outside the pilot.

The build fails on TypeDoc warnings (including invalid symbol references), TypeScript conversion errors, VitePress dead-page links, or rendering/build errors. Chunk-size advisories remain non-fatal. It does not check external URL availability, every fragment anchor, Mermaid browser rendering, OpenAPI/runtime agreement, or comment completeness. New/changed-code documentation remains a review requirement under the conventions; no legacy coverage gate is added.

The workflow has read-only repository permissions, requires no application secrets, and neither deploys nor publishes documentation. After committing and pushing it, review the first GitHub Actions run. To block merging on failures, a repository administrator must add `Documentation build (ubuntu-latest)` and `Documentation build (windows-latest)` as required checks in the branch ruleset; adding the workflow alone does not change branch protection.

## Reference presentation

The [local TypeDoc theme](../scripts/typedoc-theme.mjs) uses the Markdown generator's theme API to simplify reference headers. Module breadcrumbs contain only the containing folder path (for example, `models/`), and the page title contains only the module name (`recommendableAction`). Interface, type alias, variable, function, and class pages show linked ancestors only in the breadcrumb (for example, `models/recommendableAction/`), with just the symbol name in the title. The project label, current symbol repetition, and kind prefixes such as `Function:` are omitted. Module IDs and signatures are unchanged.

When a module exports exactly one class and has no additional exports or attached documents, its overview, class description, and methods render on the module page. The sidebar links directly to that combined page without an extra Classes branch. Class links resolve to an anchor on the module page; the former separate `classes/ClassName.html` page is no longer generated. Modules with multiple exports keep their index and separate symbol pages.

Nested sidebar entries use compact indentation and row spacing, with a wider desktop sidebar so symbol names stay on one line. On narrow screens or for unusually long names, the navigation scrolls horizontally rather than splitting or clipping identifiers.

Examples are authored in source comments as simple stories explaining what an artifact does and why. Model stories are part of the opening summary; other examples may use `@example`. Prose renders as regular paragraphs, while only actual code uses fenced blocks. TypeDoc's `jsDocCompatibility.exampleTag` is disabled to prevent automatic code formatting of prose-only examples. The [example policy](documentation-conventions.md#example-policy) keeps stories approachable for non-technical readers; examples are not created dynamically during builds.

## Tooling maintenance

The portal commands use [a small CLI wrapper](../scripts/docs.mjs) that canonicalizes both the repository's working directory and the VitePress CLI module URL using Node's native filesystem realpath function. The non-native realpath function can retain a lowercase drive letter on Windows, and changing the working directory alone does not normalize module imports inherited from a lowercase entry-script path. Starting VitePress 1.x with those mismatched paths can fail during page rendering with `Cannot read properties of undefined (reading 'imports')`: its page lookup compares canonical filesystem paths with differently cased Vite module IDs. Use the npm commands rather than invoking VitePress directly. The chunk-size advisory is separate from this error and does not fail the build.

VitePress 1.6 uses Vite 5 by default. The package manifest scopes an override to VitePress to use patched Vite 6.4.3 or later in that major line, avoiding the older development-server advisories while retaining compatibility with its Vue plugin. Revisit this override when upgrading VitePress; verify production builds, preview, live guide editing, and portal/reference navigation together. Node 22.13+ remains the project minimum.

Broader backfill, documentation coverage enforcement, CI publication, and schema generation are not enabled by this step.
