---
description: "Use when generating, changing, or documenting TypeScript modules, functions, models, controllers, routes, and services. Defines comment conventions and OpenAPI ownership."
applyTo: "src/**/*.ts"
---

# TypeScript documentation

Follow [documentation conventions](../../docs/documentation-conventions.md). Use the [Recommendable Actions pilot](../../docs/recommendable-actions.md) as the example.

- For new modules, add a `/** ... */` module block explaining purpose, layer responsibility, and important I/O boundaries with `@module`.
- For new or changed exported functions/methods, document purpose and non-obvious flow, return semantics, side effects, and failures. Keep obvious wrappers concise; avoid boilerplate tags and repeated TypeScript types.
- Explain domain semantics on types/properties where necessary. Comment internal helpers and inline logic only when clarification is useful.
- Use TSDoc-style summaries, `@remarks`, and meaningful `@param`, `@returns`, `@throws`, `@example`, `@see`, or resolvable `{@link ...}` references. Verify descriptions against implementation, callers, and tests.
- OpenAPI owns HTTP paths, auth policies, payloads, and status codes. Link to it rather than copying contract tables into comments. Update OpenAPI in the same change when HTTP behavior changes.
- Keep feature overview pages current when architecture or cross-layer workflow changes. Do not require backfilling unrelated legacy code.
- Documentation-only work must not change executable behavior. Do not imply that comments are automatically synchronized or generated before tooling exists.
