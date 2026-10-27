# Documentation conventions

## Scope and rollout

Use these conventions for new or changed TypeScript behavior. The first pilot is the [Recommendable Actions feature](recommendable-actions.md): its model, controller, service, and router. Other existing files can be documented incrementally when touched; this is not a requirement to rewrite the entire repository.

The pilot establishes source comments and a curated feature overview. Coverage now also includes Boundaries, Boundary synchronization, Assist, Representatives, and Ideas with their immediate helpers. The [VitePress portal](index.md) renders the selected feature guides with graphical Mermaid diagrams alongside TypeDoc-generated Markdown reference; unrelated legacy modules remain outside this backfill. Guides and reference share the same navigation, theme, layout, and search. The [Documentation workflow](index.md#automated-checks) validates the build on pull requests and `main` pushes. Repository skills now guide bounded backfills and documentation synchronization; required-check branch rules and publication remain separate steps.

## One authority per concern

| Concern | Authority | What other documentation should do |
| --- | --- | --- |
| HTTP paths, authentication, request/response schemas, status codes | [OpenAPI definition](../src/docs/swagger.ts) and its imported fragments | Link to the contract; do not copy it into controller comments. |
| Executable validation | Runtime validators, such as [the candidate validator](../src/models/recommendableAction.ts) | Explain normalization and assumptions rather than copying every constraint. Check OpenAPI against behavior when changing a contract. |
| Domain semantics and implementation rationale | Comments adjacent to the relevant declarations | Link to related symbols instead of duplicating their algorithms. |
| Architecture, dependencies, and cross-layer workflows | Curated feature pages in this directory | Link to code and OpenAPI; explain relationships rather than reproduce reference documentation. |
| Verified behavior | Tests and implementation | Use both as evidence; comments do not make a guarantee true. |

OpenAPI and runtime validators are currently maintained separately. This convention reduces prose duplication but does not automatically synchronize them. Stable operation IDs and schema generation can be introduced separately when the reference tooling is selected.

## Comment format and coverage

Use `/** ... */` documentation blocks compatible with TypeDoc's TSDoc-style syntax. Do not add a separate HTTP annotation system.

- **Module/file:** begin with a short purpose statement and `@module`. Describe the layer's responsibility, important I/O dependencies or absence of I/O, and boundaries with other layers. Avoid an inventory of every declaration.
- **Exported function or method:** explain purpose and the general flow when it is not obvious. Document meaningful return semantics, side effects, failure modes, and surprising assumptions. A short wrapper may need only one sentence; it does not need boilerplate parameters and returns.
- **Exported classes, types, constants, and properties:** describe domain meaning where names and types are insufficient, such as global boundary scope or catalog versus idea identity.
- **Internal helpers:** document non-obvious normalization, algorithms, or decisions. Do not require blocks for every anonymous callback or obvious accessor.
- **Inline comments:** reserve for reasoning that cannot be conveyed clearly at declaration level. Do not narrate individual statements.

Prefer a small vocabulary:

| Syntax | Use |
| --- | --- |
| Opening summary | What the declaration accomplishes. |
| `@remarks` | General logic, assumptions, side effects, and important limits. |
| `@param name - ...` | Meaning or preconditions not already expressed by the type. |
| `@returns` | Semantic result, including null, empty, unchanged, or partial outcomes. |
| `@throws` | Meaningful thrown errors or promise rejections; omit when failure is returned as data. |
| `@example` | Simple conceptual stories in normal prose; model examples belong in their opening summary instead. Fence only actual code. |
| `{@link Symbol}` | Cross-reference a resolvable code symbol. |
| `@see` | Related symbol or relative Markdown link to a source/overview page. |
| `@module` | File-level documentation for the generated module reference. |

Do not repeat TypeScript type annotations in comment tags, list every obvious parameter, copy secrets or production records into examples, or assert unverified guarantees. Prefer semantic explanations over copied numeric limits and configuration defaults.

### Example policy

Provide examples liberally for modules, domain concepts, and functions whenever they help readers understand purpose or usage. Skip an example only when it would not add useful meaning or would repeat another example already rendered on the same page (for example, an obvious controller wrapper around a service scenario). Do not require meaningless examples on every property or constant.

- Write examples for non-technical readers, as if explaining to a child what the artifact does and why it helps. Use familiar stories and plain language, not implementation instructions, constraints, restrictions, or failure-handling guidance. Keep those technical details in remarks, parameters, and other developer-facing sections.
- Begin imagined situations naturally: "Let's imagine there's a city webpage inviting neighbors to share ideas for a park." This sets an honest tone without repeatedly calling the story "fictional", "hypothetical", or "illustrative". Do not present imagined events as real announcements or claim sources have been verified.
- For model module overviews and model types, put the story in the opening summary before `@remarks`. It should read as part of the introduction, not under a separate Example heading. Use `@example` for function and other examples where a separate section helps.
- Render example prose as ordinary paragraphs, never inside code fences. TypeDoc's `jsDocCompatibility.exampleTag` is disabled so prose-only `@example` blocks are not automatically treated as code. Fence only actual code and specify its programming language.
- Describe real-world concepts rather than IDs in prose: "The action applies to Downtown and Uptown", not "boundary IDs 10 and 20". For scope, say that an action can apply to particular neighborhoods or anywhere. Avoid database and AI-provider terminology in conceptual stories.
- Optional code snippets may illustrate the story, but are not a substitute for readable prose. Keep values natural (`sourceEvidence: 'Invitation to share park feedback.'`), without self-aware disclaimers. Use reserved example domains for sample URLs, and keep runnable snippets deterministic and free of network, database, credentials, or provider dependencies. Include imports for independently runnable snippets; short reference snippets may assume the documented function is in scope.
- Validate code examples against implementation and relevant tests. Keep technical edge cases in tests or developer-facing sections rather than burdening the story. Do not promise a model judgment or stronger behavior than the implementation provides. Do not hand-edit generated Markdown or generate new AI prose during builds.

### Comment example

```typescript
/**
 * Determines whether an action's geographic scope includes an idea.
 *
 * @remarks
 * Unrestricted actions apply globally; restricted actions need any shared ID.
 *
 * @returns Whether geographic scope matches, not whether the action is relevant.
 */
```

## Reusable documentation workflows

- [Document Existing Code](../.github/skills/document-existing-code/SKILL.md): use for a bounded backfill of existing modules or one feature. It traces implementation, callers, middleware, and tests before adding explanations and approachable examples without changing executable behavior.
- [Synchronize Documentation](../.github/skills/documentation-sync/SKILL.md): use alongside code changes or for a documentation-drift review. It checks the affected comments, HTTP contract, feature overview, and reference coverage. Review-only requests produce findings without edits; uncertain contract mismatches require a decision rather than a silent behavior change.

The [Cloud API Developer agent](../.github/agents/cloud-api-developer.agent.md) links to both workflows, and the [SQL CRUD generator](../.github/skills/sql-table-crud/SKILL.md) applies the same conventions to new code. Skills guide the agent; they do not automatically scan the repository, enforce prose quality, or replace CI and review. The standards above remain authoritative rather than being redefined in each skill.

## Updating or backfilling documentation

1. Read the implementation, callers, relevant middleware, and tests before describing behavior.
2. Add or update the module block and relevant declaration blocks. Distinguish returned errors from rejected promises, and syntactic checks from network or database guarantees.
3. Update the feature overview only if responsibility, dependencies, or workflow changed.
4. If HTTP behavior changed, update OpenAPI in the same change. Otherwise link to it without rewriting its contract in comments.
5. Keep documentation-only backfills free of behavioral refactors. Record discovered issues separately rather than quietly fixing unrelated behavior.
6. Review for accuracy and useful explanation, not comment count. Comments alone cannot prevent drift.

For source-comment backfills, verify that executable behavior is unchanged and use the smallest relevant existing tests/build. For documentation changes, run `npm run docs:build`; for a TypeDoc conversion-only check, run `npm run docs:check`. Review Mermaid edits in the browser using `npm run docs:preview` or `npm run docs:dev`, including light/dark mode and the source fallback. The build validates portal links and rejects TypeDoc warnings, but does not enforce legacy comment coverage, validate runtime diagram rendering, or synchronize OpenAPI with validators. Do not start API services or call cloud/AI providers just to validate documentation.
