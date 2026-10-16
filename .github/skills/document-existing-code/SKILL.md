---
name: document-existing-code
description: "Use when documenting existing TypeScript code, backfilling missing comments, explaining module or function purpose, adding approachable examples, or extending the developer portal to an existing feature. Inspect implementation, callers, and tests before adding documentation without changing executable behavior."
argument-hint: "[feature, module, or file paths to document]"
user-invocable: true
---

# Document Existing Code

Document one bounded feature or module using evidence from the repository. Do not expand to another feature, refactor runtime code, publish the portal, or commit unless requested.

## Read first

- [Documentation conventions and example policy](../../../docs/documentation-conventions.md)
- [Scoped TypeScript instructions](../../instructions/typescript-documentation.instructions.md)
- [Recommendable Actions pilot](../../../docs/recommendable-actions.md)
- [Portal generation and validation guide](../../../docs/index.md)

These are the policy authorities; do not introduce a competing comment standard.

## Procedure

### 1. Establish scope and preserve work

- Use the supplied feature or paths. If none are given, ask which feature to document; do not select a repository-wide backfill automatically.
- Inspect Git status and existing diffs. Preserve unrelated edits and never stage, reset, or overwrite user work.
- Identify the relevant routes, controllers, services, models, middleware, workers, and tests. Read only the dependencies needed to explain the selected slice.

### 2. Establish what the code actually does

- Trace entry points, callers, data transformations, persistence, external services, and error handling. Read tests as supporting evidence, not a guarantee of untested behavior.
- Check route mounting and middleware rather than inferring authorization from a controller name. Distinguish review state, catalog state, and downstream records when relevant.
- Check normalization, null/empty results, cancellation, partial writes, transaction boundaries, rerun behavior, and side effects before describing them. Do not promise atomicity, idempotency, network safety, or provider accuracy without evidence.
- If implementation, tests, and OpenAPI disagree, report the discrepancy. Do not invent intended behavior or silently change the implementation to match a comment. Ask when resolving the discrepancy requires a product decision.

### 3. Write the explanation beside the code

- Add a module block describing responsibility and important I/O boundaries. Explain meaningful exported declarations and non-obvious internal helpers; do not narrate every statement or require boilerplate for obvious wrappers.
- Put behavior and technical caveats in summaries, remarks, parameters, returns, or throws as appropriate. Distinguish returned validation errors from thrown/rejected failures.
- Provide useful examples liberally, aimed at basic understanding by non-technical readers. A natural opening such as "Let's imagine..." is enough to set the story's tone. Explain what and why using places and people, not IDs, provider jargon, implementation steps, or repeated fictional disclaimers.
- For model overviews and model types, put the story in the opening summary before `@remarks`. Elsewhere use `@example` where useful. Prose is always paragraph text; fence only actual code with a language name. Keep optional snippets deterministic, with natural sample values and no live service calls.
- OpenAPI owns HTTP contracts. Link to it instead of duplicating payloads, response tables, or authentication matrices in comments. Use the [documentation-sync workflow](../documentation-sync/SKILL.md) to reconcile evidence-backed documentation drift within scope.

### 4. Connect the selected feature to the portal

- Add or update a curated feature overview only when needed: purpose, responsibility map, cross-layer workflow, dependencies, important invariants, and links to source and OpenAPI. Use Mermaid when a diagram helps understanding.
- If reference coverage is requested, add only the selected modules to [TypeDoc entry points](../../../typedoc.json); do not switch to a repository-wide glob. Add authored guide navigation in [VitePress configuration](../../../docs/.vitepress/config.mts) and link the overview from existing guides where useful.
- Let the local theme generate breadcrumbs, titles, combined single-class pages, and sidebar data. Never hand-edit generated reference Markdown, the generated sidebar JSON, or site output. Do not move or rename runtime symbols to improve documentation layout.

### 5. Verify the result

- Review the diff to confirm runtime code is unchanged; separate pre-existing user edits from this backfill. For source comments, compare emitted JavaScript before/after when practical and use the smallest relevant existing tests/build. Never run deployment, migrations, or live provider calls for documentation validation.
- Run `npm run docs:build` when comments, guides, or reference coverage change. `npm run docs:check` is conversion-only and is not a substitute for the full portal build. Use the npm wrappers rather than invoking VitePress directly on Windows.
- Check generated pages for introductory model stories, paragraph-form examples, useful cross-links, and non-redundant explanations. Check internal anchors when headings change; the build does not verify every fragment.
- If diagrams, navigation, or layout changed, preview in a browser and check relevant desktop/mobile and theme behavior. Stop temporary preview processes used only for verification; do not interrupt an existing user preview server.

## Completion report

Briefly report the documented slice, reference/overview additions, checks actually run, and unresolved discrepancies or unverified claims. Do not claim automatic OpenAPI synchronization, full-system reference coverage, or live integration verification.
