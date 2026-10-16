---
name: documentation-sync
description: "Use when updating documentation alongside code changes, reviewing documentation drift, reconciling comments with implementation or OpenAPI, or checking feature overviews and generated reference coverage before a pull request. Audit the requested change scope and fix evidence-backed documentation inconsistencies without unrelated behavioral changes."
argument-hint: "[feature, changed paths, or Git comparison to review]"
user-invocable: true
---

# Synchronize Documentation

Review a bounded change for documentation drift. This is an evidence-based workflow, not a schema generator or an automatic guarantee that the HTTP contract matches runtime behavior.

## Read first

- [Documentation conventions and example policy](../../../docs/documentation-conventions.md)
- [Scoped TypeScript instructions](../../instructions/typescript-documentation.instructions.md)
- [Portal generation and validation guide](../../../docs/index.md)
- [OpenAPI source](../../../src/docs/swagger.ts) and any imported fragments relevant to the change

Use [document-existing-code](../document-existing-code/SKILL.md) for a substantial backfill of previously undocumented modules. Do not duplicate the policy in new documentation systems.

## Procedure

### 1. Identify the change boundary

- Honor the requested feature, files, or Git comparison. With no explicit comparison, inspect staged and unstaged changes plus relevant untracked files; do not assume all work is staged or select an arbitrary remote/base branch.
- If there are no changes and no feature was named, ask what should be audited. For a review-only request, report findings without editing.
- Preserve unrelated edits, the staged set, and runtime behavior. Do not fetch, publish, deploy, or commit unless requested.

### 2. Trace effects, not just changed lines

- Read implementation, immediate callers, tests, route mounting, and middleware relevant to the change. Follow renamed or removed symbols into comments and guides.
- Classify the change using the table below. A changed type or service can affect the HTTP contract even if no route file changed.

| Change | Check and update when affected |
| --- | --- |
| HTTP path, verb, auth, input validation, output shape, or status code | OpenAPI paths/components/security and relevant contract tests; controller comments should link rather than copy the contract. |
| Function/domain behavior | Summary, remarks, return/failure semantics, side effects, and examples beside the declaration. |
| Cross-layer workflow, storage, worker, or external dependency | Feature overview, responsibility diagram, and directly related operational setup. |
| New, renamed, moved, or removed public module/symbol | TypeDoc entry points, authored guide navigation, references, examples, and links/anchors. |
| Formatting or internal implementation with unchanged behavior | Documentation only if explanations or source links became inaccurate; avoid unrelated rewrites. |

### 3. Resolve drift responsibly

- Keep one owner per concern: OpenAPI for the HTTP contract, validators for executable validation, source comments for domain/implementation explanations, and guides for architecture. Link between owners instead of creating competing copies.
- Fix documentation when implementation and evidence establish the intended behavior. If code, tests, and the documented contract disagree and intent is uncertain, describe the mismatch and ask for a decision. Do not silently redefine the public API to fit current code or change runtime logic as a documentation fix.
- Ensure new/changed exported behavior has useful explanations, without requiring a legacy-wide comment-coverage cleanup. Do not invent guarantees about transactions, cancellation, retries, or AI results.
- Keep conceptual examples approachable: explain what and why to non-technical readers with familiar stories, not IDs or technical restrictions. Put model stories in the opening summary; use normal paragraphs for prose and language-tagged fences only for code. Preserve technical caveats outside the story.
- When a real HTTP change is in scope, update its OpenAPI definition in the same change and use existing relevant tests. Merely documenting an existing function does not authorize rewriting endpoint contracts.
- Edit source comments and authored guides, not generated reference Markdown, generated sidebar JSON, or HTML. Preserve the local theme's selective single-class consolidation and module/symbol naming conventions.

### 4. Validate only what is needed

- Run `npm run docs:build` for changed comments, guides, TypeDoc coverage, or portal configuration. It regenerates Markdown and builds the portal with dead-page-link checking; `npm run docs:check` only validates TypeDoc conversion.
- For relevant code/HTTP changes, run the smallest existing test selection and the project build when required by that change. Do not run the full suite, add dependencies, or start the API solely for a prose edit.
- Use existing documentation-theme tests when theme behavior changes. Check generated headings, examples, cross-links, and any changed fragment anchors; inspect rendered diagrams or navigation in a browser when affected.
- No database, cloud credentials, API keys, or live provider calls are needed for a documentation build. Do not run migrations or deployment commands. Stop temporary verification previews without interrupting user-owned services.
- State limitations: the build does not prove external URL availability, every fragment anchor, browser diagram correctness, prose accuracy, comment completeness, or OpenAPI/runtime agreement.

## Completion report

Report the reviewed scope, evidence-backed documentation corrections (or no drift found), checks actually run, and any unresolved discrepancies with paths/symbols. Separate confirmed findings from uncertainties. Do not claim a clean review of unrelated code, automatic synchronization, or CI success before a run has completed.
