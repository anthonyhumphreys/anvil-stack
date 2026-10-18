# Portable app backends

Anvil Cloud should support data-backed HTTP apps, scheduled imports, private files,
and reliable background jobs on both AWS and Cloudflare. The acceptance target is
an app that ingests a catalogue, serves authenticated searches, tracks usage, and
connects to external services. Product-specific matching rules and source formats
belong in the app.

This is a compatibility target, not a production-readiness declaration.

## Data changes that must succeed together

`ctx.commit(writes)` conditionally replaces or deletes up to 25 records across
logical tables. Every condition succeeds and every write applies, or nothing
changes. Use records returned by `get` as `expected`. Use `expected: null` to
require absence, and `record: null` to delete. Records must include the matching
string `id`. A stale condition returns `CONFLICT`, HTTP 409. Read again before
retrying. Do not retry authentication or validation failures.

```ts
const previous = await ctx.db.usage.get(userId);
const used = Number(previous?.used ?? 0);
if (used >= allowance) throw new Error("Usage allowance reached");
await ctx.commit([
  {
    table: "usage",
    id: userId,
    expected: previous,
    record: { id: userId, used: used + 1 },
  },
  jobOutboxWrite({ id: importId, name: "importBatch", payload: { importId } }),
]);
```

Declare the database capability. Queries cannot call `commit`. This operation
covers database records only. File uploads, HTTP calls and queue publication
happen separately. JSON records are limited to 256 KiB each and a commit to 1 MiB,
including expected records. Table names are limited to 255 UTF-8 bytes and ids to
1024 UTF-8 bytes. The commit limit includes any outbox or receipt writes.

The in-memory host stages changes before applying them. The local JSON host
serializes writers within one process and atomically renames the database file.
Use one local server per state directory. It is not a multi-process database.
AWS uses strongly consistent reads and DynamoDB conditional transactions.
Cloudflare uses a D1 batch with a failing SQL constraint when any condition is
stale, so the database rolls back the whole batch.

`ctx.db.items.page({ limit: 25, cursor })` returns `records` and a continuation
`cursor`, or `null` at the end. Limits are 1 to 100. Cursors are record ids for
that table, not a snapshot or a filtered search token. Concurrent inserts behind
a cursor require another pass. Existing `all` and `where` methods can load a whole
table. Use bounded pages and application indexes for growing datasets.

## Pending work and duplicate delivery

`jobOutboxWrite` creates a conditional record for a job. Commit it alongside the
records that require that job. `ctx.dispatchPendingJobs(options)` publishes one bounded page from a scheduled
Cell job. Declare both database and jobs capabilities. Platform integrations can
also use `dispatchJobOutbox(host, options)`. Run recovery periodically, persist its
returned cursor, and restart at
the beginning after a `null` cursor. It claims each record with a lease and token,
recovers expired claims, and retains exhausted publications with `state: failed`.
Outbox messages are limited to 64 KiB. Default publication attempts are five. Inspect and explicitly reset failed records
after correcting the cause. Failed entries are not silently discarded.

Queues can redeliver a message. A process can also stop after publication but
before deleting its outbox record. Both paths retain the same logical job id in
`ctx.request.id`. A handler should commit a receipt under that id together with
its database changes, treating an existing receipt as completed work. External
side effects need their own idempotency key. There is no exactly-once promise.

Keep each import batch small enough for the provider's execution limits. Store
large source files privately, put only their keys in job payloads, and commit
progress between batches. Provider dead-letter queues cover consumer failures;
outbox failed records cover publication failures. Operators must monitor both.

## Provider support and release evidence

| Requirement                           | AWS                                                                  | Cloudflare                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Conditional commits and bounded pages | DynamoDB adapter, SDK-level tests                                    | D1 adapter, real local binding tests                                                       |
| Private files                         | S3 adapter, SDK-level tests                                          | R2 adapter, real local binding tests                                                       |
| Queued work                           | SQS consumer with per-message failures                               | Queue consumer with per-message acknowledgements and retries                               |
| Scheduled imports                     | EventBridge, including five-field UTC cron with unrestricted weekday | Cron Trigger enqueues matching jobs; five-field UTC cron                                   |
| Bearer identity                       | OIDC verifier                                                        | Same Web Platform OIDC verifier; issuer and audience required                              |
| Configuration and secrets             | Environment and secret binding support                               | Runtime reads bindings; existing secret names can be acknowledged during artifact creation |
| Deployment lifecycle                  | Preview deployment and cleanup                                       | Normal Cell deploy remains gated; artifacts accept existing stage-specific resources       |

Cloudflare artifacts accept `resources` in `createCloudflareWorkerArtifacts` for
existing D1, private R2, queues and OIDC configuration. Apply the generated D1
migration and install secrets before deployment. The config includes a queue
consumer, bounded retries, a dead-letter queue and observability. It does not
create those resources or prove that a deployment succeeded. Temporary-account
restrictions remain in place. Events and durable workflows remain unsupported
on the Cloudflare host.

Before promoting either adapter for this class of app, record a live rehearsal
of authenticated HTTP, database conflicts, private file access, scheduled jobs,
duplicate deliveries, poison messages, outbox crash recovery, secrets redaction,
backup restore, migrations, rollback and cleanup. AWS SDK tests are not live AWS
evidence. Local D1/R2 tests are not live Cloudflare evidence. Test production-scale
indexed lookups and quotas against real data volumes. Review provider costs and
limits before enabling public traffic. These release checks remain open.
