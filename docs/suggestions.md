# Suggestions

API-key validated applications can receive [real-time suggestion notices](./suggestion-notices.md) over WebSocket and refresh records through these REST endpoints.

## What this feature does

Let's imagine a neighbor wants a shady bench beside a bus stop. A suggestion gives that idea a home, with a description, a place, and photos. Next steps and a history of progress can help people turn the idea into something real.

This slice includes [saved Streetmix drawings](streetmix.md#suggestion-integration), base suggestions, JEV-assigned suggestion emojis, attached Recommended Actions, activity, image-upload signing, and integration with the existing [Recommendable Actions catalog](recommendable-actions.md). The [OpenAPI definition](../src/docs/swagger.ts) remains the HTTP contract; the [app](../src/app.ts) mounts the same router at both the public-improvements prefix and its shorter suggestions alias.

## System view

```mermaid
flowchart TD
    Request[Suggestion request] --> Routes[Application access / user policy]
    Routes --> Controller[SuggestionController]
    Controller --> Validate[Model normalization]
    Validate --> Base[SuggestionService / Firestore]
    Base --> Match[Optional reusable-action matching]
    Match --> Children[RecommendedActionService]
    Routes --> ActionController[Action and activity controller]
    ActionController --> Children
    Children --> People[Optional PostgreSQL representative check]
    Children --> History[Firestore actions and activity]
    Controller --> Signer[StorageService upload signing]
    Signer --> Browser[Browser uploads directly to Cloud Storage]
```

## Responsibilities

- [Suggestion model](../src/models/suggestion.ts): attribution, content/photos, locations, statuses, and normalized create/update fields.
- [Base service](../src/services/suggestionService.ts): Firestore reads, integer allocation, nested merging, and parent/child deletion.
- [Controller](../src/controllers/suggestionController.ts) and [router](../src/routes/suggestionRoutes.ts): filter parsing, route policies, author/staff checks, activity enrichment, and matching after creation.
- [Action model](../src/models/recommendedAction.ts), [action service](../src/services/recommendedActionService.ts), and [action controller](../src/controllers/recommendedActionController.ts): individual next steps and server-attributed activity.
- [Storage service](../src/services/storageService.ts): temporary direct-upload write URLs, not image-byte processing.

## Base suggestion lifecycle

Create validation trims known text and supplies defaults. It is not a strict unknown-property schema validator. Coordinate checks currently verify number types, not full geographic ranges, paired coordinates, or finiteness. A photo URL is a stored reference, not proof of a completed or safe image upload. Missing photo timestamps use the current clock.

Emoji candidates come from the complete Unicode Emoji 18.0 fully-qualified repertoire, including standard flags, modifier variants, and ZWJ sequences. Local ranking weights summary matches four times above detail matches. Civic keywords cover pedestrian crossings, utilities, animals, sanitation, and other playground topics; generic words such as “person” carry less weight. Country flags require a matching location name. Related skin-tone, gender, direction, and family variants share one shortlist slot; a neutral variant is preferred unless the summary explicitly names a variant. JEV now routes by meaning across groups of up to 16 emoji families from the complete catalog. The two best groups augment the 32 keyword candidates; up to 64 distinct families are evaluated in batches of at most 32. Summary remains primary and details provide context. Routing has a seven-second timeout within a shared 20-second budget; routing errors fall back to keyword candidates. Set `EMOJI_RETRIEVAL_MODE=lexical` to disable semantic retrieval. Individual reads attempt the same assignment when an emoji is absent; JEV errors are logged and do not block creation or reading. Lists do not trigger assignment. The emoji is server-managed and is not accepted through create or update validation.

The service lowercases author emails and allocates automatic integer identifiers in a transaction. Allocation and the subsequent suggestion write are separate, so failed writes can leave gaps. Explicit identifier creation uses read-before-set, not an atomic uniqueness lock. Updates use transactional patches of known fields, preserving server-managed Streetmix metadata and fencing deletion.

Creation saves the suggestion before attempting catalog matching. Matcher failures are logged without undoing the saved idea; matching may already have created some child actions before a later failure. Updates do not automatically rerun matching. Storing an address does not automatically geocode it.

Lists return base records and omit activity. Detail reads separately attach the newest activity page and pagination metadata; they are not one cross-document snapshot.

## Access and attribution

All suggestion routes use application access. Public reads, creation, and upload signing allow optional user identity. Private update/delete checks compare verified caller emails with the existing stored author or allow canonical staff. Creation attribution is supplied content, not proof of ownership. A missing suggestion can fail the initial mutation authorization check as forbidden before the service is called.

Action mutation routes require staff. Manual activity additionally allows the suggestion author, with actor details taken from verified request identity and timestamps supplied server-side. Comments explain this division; OpenAPI owns the full HTTP contract.

## Next steps and history

A **Recommended Action** belongs to one suggestion; a **Recommendable Action** is reusable catalog content. Optional matcher linkage connects the two without merging their lifecycles.

Action writes transactionally check that the suggestion exists and is not being deleted. Optional representative existence checks occur in PostgreSQL before Firestore writes, not in one cross-store transaction. Deterministic matcher action identity returns an existing action without overwriting it.

A real status transition and its activity entry commit together. Repeating the current status suppresses that transition/log and sets `noOp`; other fields in the same update can still change. Expiration hides actions from default lists without modifying status, and detail reads can still retrieve an expired action. Activity is newest-first with timestamp/document-identity tie-breaking and snapshot-based cursors.

Deletion marks the parent, recursively removes action/log children, then deletes the parent. Cleanup is not one atomic operation; failures may leave partial child cleanup and attempt to reopen the flag for retry. Base update is not guarded by the child service's deletion fence. Photo objects are not removed by suggestion deletion.

## Image upload boundaries

The signer checks declared MIME type, chooses a unique object path, and returns an expiring V4 PUT capability. It does not inspect uploaded content, sanitize SVG, upload bytes, or guarantee public readability; bucket policy and the separate browser upload determine those outcomes. Existing bucket/signing setup stays in the [README](../README.md).

## Evidence and documentation audit

[Emoji tests](../tests/suggestionEmoji.test.ts) check relevant candidate coverage for all 196 [mock descriptions](../src/data/recommendableMockDescriptions.ts), the submission 38 crossing regression, summary weighting, and variant diversity. These are retrieval checks and mocked JEV workflow checks; they do not guarantee a specific live JEV choice or service availability.

[Recommended Action tests](../tests/recommendedActions.test.ts) cover local action/log validation, expiry, and catalog boundary applicability. [Staff-claim tests](../tests/staffClaims.test.ts) also exercise shared authorization with route/service mocks. They do not constitute full live Firestore/Cloud Storage integration coverage for all suggestion lifecycle races.

The backfill removes path-only controller comments in favor of linked responsibility descriptions. It leaves existing API behavior unchanged. During the audit, the action update's same-status result was checked explicitly: `noOp` describes the status transition, not necessarily every other supplied field. The guide records the implementation's distinction rather than promising a fully unchanged record. No endpoint schema, migration, or permission is introduced here.


## Emoji diagnostics and live evaluation

Each attempt emits a `suggestion_emoji_classification` JSON log containing an attempt ID, suggestion ID when supplied by the controller, model, retrieval mode, stage timings, catalog candidate names and valid probability scores, selected emoji, and outcome. Missing or invalid scores appear as null. Outcomes distinguish configuration, no candidates, HTTP errors, malformed responses, timeouts, network errors, low confidence, and assignment. A routing failure is recorded separately when keyword fallback succeeds. Suggestion text, author information, credentials, and raw provider responses are excluded.

Run `npm run eval:emoji -- --live` to compare lexical and hybrid modes on suggestions 24, 27, 30, 32, 36, and 39. This explicitly sends fixture text to JEV, incurs provider usage, and needs `TYPESAFE_API_KEY`. It never reads or writes Firestore. Add `--all` to include the 196 synthetic mock descriptions. Ordinary tests do not make live requests. Reports are saved under `.tmp/emoji-evaluation/` and contain per-case scores, failure categories, assignment rate, expected-label match rate, candidate coverage, and p95 latency.

The expected emoji lists are deliberately non-exhaustive: a different selection needs manual review, and assignment rate alone is not quality. The six-case live baseline on 2026-10-19 assigned 4/6 in lexical mode and 5/6 in hybrid mode; both matched the narrow labels on 3/6. Candidate coverage was 6/6 in both modes; p95 latency was 442 ms and 728 ms respectively. Hybrid newly selected 🙆 for the interface confirmation example (39), which requires review; both abstained on the grammar/API example (30). This small single run does not establish a relevance improvement. Full scores remain in the local evaluation report; the compact baseline is in `data/emoji-evaluation-baseline.json`.
