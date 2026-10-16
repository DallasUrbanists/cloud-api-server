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
- Provide examples liberally to explain what an artifact does and why, using simple language a child or non-technical reader could understand. Begin imagined scenarios naturally (for example, "Let's imagine..."). Describe neighborhoods and other real-world concepts, not IDs, implementation steps, constraints, or restrictions; keep technical details in remarks and parameter documentation. Avoid repeated disclaimers such as "fictional" or "illustrative", including in code values.
- For model module overviews and model types, place the example paragraph in the opening summary before `@remarks`, not a separate `@example` section. Elsewhere, use `@example` where helpful. Always write prose as normal paragraphs, never in code fences. Fence only actual code, with an explicit language; keep optional snippets deterministic and free of cloud/network calls. Omit examples only when they add no useful meaning or repeat another example on the same page. Do not imply that imagined opportunities or sources are real or verified.
- OpenAPI owns HTTP paths, auth policies, payloads, and status codes. Link to it rather than copying contract tables into comments. Update OpenAPI in the same change when HTTP behavior changes.
- Keep feature overview pages current when architecture or cross-layer workflow changes. Do not require backfilling unrelated legacy code.
- Documentation-only work must not change executable behavior. Do not imply that comments are automatically synchronized or generated before tooling exists.
