# Consumer handoff: Suggestions to Ideas

Use the prompt below for each consumer repository. The backend bridge release supports both route vocabularies while the app migrates. Confirm that Ideas is enabled on the deployed backend before releasing a consumer. Report the tested frontend/backend commit pair and acceptance results so the backend can start the legacy-contract retirement window.

```text
Update this consumer app for the Dallas Urbanists Suggestions-to-Ideas rename.

The backend introduces canonical Ideas contracts before retiring Suggestions
compatibility. Confirm the deployed backend supports them before releasing
this app. Implement and test the consumer changes in this repository.

API changes:
- Replace /api/suggestions with /api/ideas.
- Replace /api/public-improvements/suggestions with
  /api/public-improvements/ideas.
- Apply this to CRUD, upload-url, boundaries, representatives,
  recommended-actions, activity logs, and every Streetmix operation.
- Rename domain types, functions, variables, components, props, events,
  selectors, tests, fixtures, documentation, and visible labels to Idea/Ideas.
- Use IDEA_* error codes instead of corresponding SUGGESTION_* codes.
- Follow returned Streetmix statusUrl values.

Ordinary REST record fields and envelopes remain unchanged, including numeric
id, data, statuses, timestamps, and pagination. Preserve request methods,
authentication, App Check, permissions, and recommendation behavior.
Presentation endpoints already use ideas and retain their existing protocol
and string IDs.

If this app consumes notices, connect to /api/ideas/ws, require ready protocol
version 2, and handle idea.created, idea.updated, and idea.deleted with numeric
ideaId. Keep current first-frame authentication and refresh REST data after
every ready/reconnect. Do not subscribe to both legacy and canonical streams.

Update application deep links to /idea/:id where applicable. Preserve old
/suggestion/:id links through redirects, retaining query parameters and
fragments. Update sharing metadata and every generated link.

Migrate browser persistence safely:
- Rename suggestion-named cache keys and persisted properties using a
  versioned, idempotent migration that prefers existing new-format data.
- Preserve bookmarks, drafts, local actions, saved map/detail state,
  and record IDs.
- Preserve pending Streetmix request IDs, request bodies, idempotency keys,
  and ETags while translating stored route prefixes and suggestionId fields.
  Never replace a pending operation with a new publication.
- Keep legacy persistence readable during the transition, and retain old
  data until the transformed data is successfully written and validated.
- Refresh stale cached media references from the API. Treat media URLs as
  opaque; use returned uploadUrl/publicUrl/filePath values rather than
  constructing bucket URLs.

For Improvement Map, inspect API and Streetmix services, router/share
metadata, storage, bookmarks, local actions, density helpers, map components,
detail/submission views, and presentation integrations. Existing persisted
bookmark entries and Streetmix operations contain suggestion-named fields.

Preserve unrelated autocomplete “suggestions,” source quotations, and
historical evidence. Search semantically rather than replacing every match.

Run the repository’s checks and add upgrade coverage using legacy persisted
data and old deep links. Verify browsing, submission with photos, detail,
bookmarks, actions, Streetmix recovery, and presentation flows.

Deliver the changes with verification results, intentional legacy references,
and the tested frontend/backend commit pair. Report acceptance for this app
so the backend can begin its legacy-contract retirement window. Backend
storage migration belongs to the backend rollout.
```
