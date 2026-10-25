# Ideas data migration runbook

This runbook covers the physical Firestore and photo-bucket move after the bridge release has been deployed. The application can serve either Firestore layout through `IDEAS_DATA_LAYOUT`; the migration utility defaults to report-only and never provisions resources or deletes the source tree or source bucket.

## Environment matrix

| Target | Firestore database | Source collection | Destination collection | Source bucket | Destination bucket |
|---|---|---|---|---|---|
| Staging | `public-improvements-staging` | `suggestion` | `idea` | `urbanists-suggestion-photos-staging-143738155808` | `urbanists-idea-photos-staging-143738155808` |
| Production | `public-improvements` | `suggestion` | `idea` | `urbanists-suggestion-photos` | `urbanists-idea-photos` |

The production and staging projects are explicitly bound in the migration script. Staging always selects the staging database and buckets. Migration commands require an environment argument; writes additionally require both `--apply` and `--maintenance-confirmed`. Apply writes the verified old-to-new object map to `_metadata/ideaMediaManifest`; the API uses it to canonicalize later photo writes from older clients.

## Prepare the destination

1. Inventory configured consumers and identities, API clients, direct Firestore writers, maintenance scripts, presentation views, and scheduled jobs. Record application/backend commit pairs and owners. Find any manually created indexes from the Firestore console and include them in the audit.
2. Deploy the compatibility release with `IDEAS_DATA_LAYOUT=legacy`, the existing bucket selected as `IDEA_PHOTOS_BUCKET`, and `IDEAS_MAINTENANCE=false`. Keep the `SUGGESTION_PHOTOS_BUCKET` fallback only for older deployment definitions. Verify Ideas and Suggestions REST prefixes read and mutate the same source collection. Verify both socket protocols.
3. Build and stage a rollback release that understands either layout and the destination bucket. Never roll traffic to a build that can write only to the source collection after destination writes resume.
4. Create each Ideas bucket using the same reviewed location, IAM, CORS, public-read policy, retention, and lifecycle rules as its corresponding source bucket. A bucket cannot be renamed; create a new one and copy objects. Check names are available before creation. Do not grant public write access. Compare the source and destination configuration before migration.
5. Create and wait for all required `idea` collection indexes, including author email/ID composites, and reproduce any collection field settings. Confirm index readiness in the target environment. The repository has no deployable Firestore index manifest, so export the reviewed live index/field configuration and create the matching `idea` configuration with the operator's reviewed `gcloud firestore indexes` commands. Keep the `public-improvements` database name unchanged.
6. Rehearse every step in staging, including an interrupted copy and resume, a conflicting target object/document, a nested orphan, and a presentation session with a selected photo. Verify staging cannot access production resources.

The staging deploy helper requires `STAGING_IDEAS_DATA_LAYOUT=legacy` or `STAGING_IDEAS_DATA_LAYOUT=ideas` and selects the matching staged bucket. Keep it on `legacy` for bridge rehearsal; choose `ideas` only for the gated cutover rehearsal after copy verification.

## Report-only inventory

Use credentials scoped to the selected environment. No destination writes occur without both flags.

```powershell
npm run migrate:ideas -- --environment=staging
npm run migrate:ideas -- --environment=production
```

Review the report for source/destination document counts, nested descendants, source and destination media objects, checksum mismatches, existing target collisions, URL references, the counter high-water mark, and any missing bucket or permission. Resolve collisions and provision resources before apply. Report-only mode still reads the named environment, so run it only when authorized for that environment.

## Copy and verify in staging first

1. Enable the maintenance gate and drain API and presentation writes. Stop scheduled jobs, scripts, and direct writers.
2. Stop issuing upload URLs. Wait at least 15 minutes for outstanding signed URLs and transfers to expire or finish, then remove old-bucket write access.
3. Run report-only again and save the output with the release commits and change record.
4. Apply the resumable copy:

   ```powershell
   npm run migrate:ideas -- --environment=staging --apply --maintenance-confirmed
   ```

   The utility copies only `suggestion/{id}` into `idea/{id}` and maps descendants under the same document IDs. It preserves native Firestore values, nested action/log/Streetmix/request state, and provider request identity. It copies objects whose owned path starts with `suggestions/` into the corresponding `ideas/` path and verifies Cloud Storage checksums. Existing identical destinations are safe to resume; different destination data is reported as a collision and is never overwritten.
5. Review and archive the old-to-new object/URL manifest. The tool rewrites matching media URL fields in the copied Ideas tree and in other Firestore documents. It leaves the source `suggestion` tree untouched. Presentation snapshots with changed photo URLs have their photo album IDs remapped, selected album item preserved, content version recalculated, and session revision advanced; selected idea, session IDs, and presentation protocol remain unchanged.
6. Verify all source document IDs and descendant paths have equivalents, compare transformed source/destination values and media checksums, check `lastIdeaId >= max(lastSuggestionId, every migrated numeric id)`, inspect unresolved Streetmix requests, and confirm no publication was initiated. Run both route families against the same destination layout before reopening.
7. Switch every staging instance and job together to `IDEAS_DATA_LAYOUT=ideas` and the Ideas bucket. Refresh presentation snapshots and reconnect affected clients, then reopen traffic. Run the consumer acceptance cases in the [handoff](ideas-consumer-handoff.md).

## Production maintenance cutover

Repeat the complete, successful staging rehearsal against production; do not use production results as a first rehearsal.

1. Announce the maintenance window. Set `IDEAS_MAINTENANCE=true` on all serving instances. Both route vocabularies and affected presentation REST calls must return retryable `503`; all affected Idea and presentation sockets must close with `1013`. Confirm this on every serving revision.
2. Pause scheduled and manual writers. Stop URL signing and wait out the 15-minute upload capability window and active transfers. Remove source-bucket write access. Drain in-flight requests and Streetmix workflows; retain their Firestore workflow state.
3. With source still authoritative, take and verify an exact Firestore backup and export source/destination bucket configuration. Perform final reconciliation, including source deletions since the earlier copy. Resolve every collision before applying. The source remains the rollback point until destination writes are reopened.
4. Copy and verify Firestore and media with the production apply command. Check collection/document paths, transformed data, descendants, counter, manifests/checksums, presentation snapshots and album selection, indexes, and zero active source writers.
5. Deploy all serving instances and writers against the Ideas layout and new bucket while maintenance remains enabled. Verify canonical and legacy API requests both operate on `idea`, and run Streetmix receipt replay and ETag checks without generating a new publication.
6. Force client socket reconnection and REST baseline refresh so the collection move is not interpreted as mass creation/deletion. Reopen maintenance only after every verification passes. Record release commits and acceptance.

Before destination writes resume, rollback may restore the legacy layout. After they resume, rollback must use the compatibility build against the Ideas store; never direct traffic to the stale source collection.

## Resume, retirement, and retained resources

The migration is idempotent: rerunning with the same explicit environment rechecks copies and continues missing work. `_metadata/ideaMigration` records the environment, current phase, and checkpoint time. A separate migration ledger tracks destination document hashes; final reconciliation removes a destination document only when the source document is gone and its unchanged hash proves the migration created it. Untracked or changed destination data is a collision and stops the run. Keep the archived command output and manifest with the backup. Do not force-replace destination data to get past a collision.

Track legacy usage from the structured `ideas_legacy_rest_request` and `ideas_legacy_socket_connected` log events. These logs contain method, route template, status, or event only; they exclude credentials and user content. Start the 30-consecutive-day retirement clock after every known consumer passes acceptance. Any legacy REST request or socket connection resets the clock. Only then remove legacy routes, socket serialization, schema aliases, environment fallback, and layout selection in a later release.

Archive and retain the verified migration report and exact backup. After the retirement gate, separately approve and execute deletion of the obsolete Firestore tree, old counter field, unused indexes, and the temporary `_metadata/ideaMigration`, `_metadata/ideaMigrationDocuments`, and `_metadata/ideaMediaManifest` records. Keep the old buckets and original media objects read-only indefinitely so existing shared URLs continue to work. Do not remove historical deployment evidence or unrelated `public-improvements` database names.

## Intentional legacy-name allowlist

- `suggestion/{id}`, `lastSuggestionId`, and the source bucket names identify the rollback/source layout until migration completes; the deploy-time layout selector removes these after contract retirement.
- `/api/suggestions`, `/api/public-improvements/suggestions`, `suggestionId`, protocol-v1 `suggestion.*` notices, `SUGGESTION_*` error/config aliases, and `examples/suggestion-notices.js` exist only for the measured compatibility window.
- The source objects under `suggestions/` and their original bucket URLs remain readable indefinitely for shared-link compatibility. Migration manifests and historical deployment evidence remain archived.
- Google Places autocomplete `suggestions` are provider response fields, and Dallas 311 source wording, quotations, and authored prose retain their original language. They are unrelated to the Idea domain rename.
