# Walk-audit agent handoff

Copy the prompt below into the implementation agent. It deliberately authorizes implementation when submitted; writing this prompt does not itself start implementation.

The [complete runbook](walk-audit-implementation-runbook.md) is self-contained and does not depend on the earlier conversation or session-only plan.

```text
Implement the complete walk-audit feature described in:
C:\Users\hexel\repos\DallasUrbanists\cloud-api-server\docs\walk-audit-implementation-runbook.md

Repository:
C:\Users\hexel\repos\DallasUrbanists\cloud-api-server

Read the entire runbook before editing, including its execution gates, permissions, report semantics, destructive lifecycle, validation and persistence requirements. If the repository is checked out elsewhere, resolve docs\walk-audit-implementation-runbook.md relative to that checkout. Treat the runbook as the implementation specification; no previous chat context is required.

The confirmed requirements are:
- Recreate the six walk-audit domain entities in the existing Cloud SQL PostgreSQL infrastructure.
- Use existing Firebase authentication, with ownership/staff permissions and private drafts.
- Automatically generate the OpenStreetMap network and PNG thumbnail when creating a study.
- Provide domain CRUD, transactional draft submission, deduplicated progress, and editable reports.
- Permanently delete a study and cascade to all of its audits, drafts, reports and SQL-stored thumbnail. Do not substitute archiving or immutable reports.

Start with repository instructions, relevant sql-table-crud/documentation-sync skills if available, current Git status, and current integration points. Preserve all unrelated staged, unstaged and untracked work. Use session task tracking for execution progress. Implement the runbook's dependency-ordered stages through verification; do not stop at another plan or a schema-only/route-only partial result. Ask only when an actual conflict or unavoidable architectural decision cannot be resolved from the specification and repository evidence.

Use the existing layered TypeScript ESM architecture, PostgreSQL pool, runtime validation, Firebase middleware and OpenAPI composition. Keep new dependencies minimal, honor the active lockfile convention, and update the manifest before installing selected packages. Verify source reuse rights; independently implement behavior and use original worksheet wording when copying is not authorized.

Add targeted migration, generation, service and HTTP tests. Run the smallest relevant tests, the TypeScript build and documentation build. Prove persistence across restart and permanent cascades with explicitly isolated PostgreSQL; fixture-only or skipped database tests do not establish real database concurrency/persistence. If prerequisites prevent a required acceptance check, report the precise blocker and do not claim full completion.

Do not apply production migrations, mutate production data, deploy, commit or push without a separate explicit instruction. Do not migrate the frontend or existing source database, introduce AI reports, or replace existing user/CRM APIs. Stop temporary verification services and clean up only resources created for this task.

Finish with a concise report of implemented endpoints/workflows, migration and environment requirements, exact verification commands/results, and any remaining blockers. Highlight the permanent cross-contributor effects of study deletion.
```
