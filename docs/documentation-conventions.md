# Documentation conventions

## Scope and rollout

Use these conventions for new or changed TypeScript behavior. The first pilot is the [Recommendable Actions feature](recommendable-actions.md): its model, controller, service, and router. Other existing files can be documented incrementally when touched; this is not a requirement to rewrite the entire repository.

The pilot establishes source comments and a curated feature overview. The [VitePress portal](index.md) renders these guides with graphical Mermaid diagrams alongside TypeDoc-generated Markdown reference for the four pilot modules. Guides and reference share the same navigation, theme, layout, and search. The [Documentation workflow](index.md#automated-checks) now validates the build on pull requests and `main` pushes. Required-check branch rules, publication, and dedicated backfill skills remain separate steps.

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
- **Exported classes, types, constants, and properties:** describe domain meaning where names and types are insufficient, such as global boundary scope or catalog versus suggestion identity.
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
| `@example` | Small, deterministic examples where they clarify behavior. |
| `{@link Symbol}` | Cross-reference a resolvable code symbol. |
| `@see` | Related symbol or relative Markdown link to a source/overview page. |
| `@module` | File-level documentation for the generated module reference. |

Do not repeat TypeScript type annotations in comment tags, list every obvious parameter, copy secrets or production records into examples, or assert unverified guarantees. Prefer semantic explanations over copied numeric limits and configuration defaults.

### Example

```typescript
/**
 * Determines whether an action's geographic scope includes a suggestion.
 *
 * @remarks
 * Unrestricted actions apply globally; restricted actions need any shared ID.
 *
 * @returns Whether geographic scope matches, not whether the action is relevant.
 */
```

## Updating or backfilling documentation

1. Read the implementation, callers, relevant middleware, and tests before describing behavior.
2. Add or update the module block and relevant declaration blocks. Distinguish returned errors from rejected promises, and syntactic checks from network or database guarantees.
3. Update the feature overview only if responsibility, dependencies, or workflow changed.
4. If HTTP behavior changed, update OpenAPI in the same change. Otherwise link to it without rewriting its contract in comments.
5. Keep documentation-only backfills free of behavioral refactors. Record discovered issues separately rather than quietly fixing unrelated behavior.
6. Review for accuracy and useful explanation, not comment count. Comments alone cannot prevent drift.

For source-comment backfills, verify that executable behavior is unchanged and use the smallest relevant existing tests/build. For documentation changes, run `npm run docs:build`; for a TypeDoc conversion-only check, run `npm run docs:check`. Review Mermaid edits in the browser using `npm run docs:preview` or `npm run docs:dev`, including light/dark mode and the source fallback. The build validates portal links and rejects TypeDoc warnings, but does not enforce legacy comment coverage, validate runtime diagram rendering, or synchronize OpenAPI with validators. Do not start API services or call cloud/AI providers just to validate documentation.
