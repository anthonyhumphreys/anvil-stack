---
title: Data and background work
navTitle: Data and background work
description: Store related records safely, process small background batches, and compare AWS and Cloudflare support.
product: Mezair Cloud
section: Guides
journey: build
order: 75
---

# Data and background work

A backend often needs to save a record, update a usage counter, and arrange work
for later. Those actions need to survive overlapping requests and temporary
service failures. Mezair Cloud has shared APIs for these operations, with adapters
for AWS and Cloudflare.

## Save related records together

Use `ctx.commit(writes)` when several records must change together. Each write
includes the table, record id, expected previous record, and replacement record.
A stale expectation rejects the whole commit with `CONFLICT`. Read the latest
records before retrying.

Use `expected: null` for a new record and `record: null` to delete one. A commit
supports up to 25 writes, with JSON records up to 256 KiB and a total of 1 MiB
including expected records. Queries cannot commit changes.

For growing tables, use `ctx.db.items.page({ limit: 25 })`. Pass the returned
cursor into the next call. A page has at most 100 records. Cursors are scoped to
the table and do not freeze the dataset. Existing `all` and `where` calls can read
a whole table, so they need care as data grows.

## Arrange work without losing the request

Include `jobOutboxWrite({ id, name, payload })` in the same commit as the records
that need the job. This saves a pending job even if the queue is unavailable.
A scheduled job can call `ctx.dispatchPendingJobs(options)` to publish pending work
with leases and bounded retries. Declare both database and jobs capabilities.
Keep its cursor between passes. Failed publications
remain in the database for inspection after retries run out.

Outbox messages are limited to 64 KiB. Store larger input in files and send its key.

A queue can deliver a job more than once. The runtime preserves the logical job
id in `ctx.request.id`. Handlers should record completion under that id alongside
their database changes. External services need their own idempotency key.

Process imports in small batches. Keep large source files in private storage and
put their keys in queue messages. Save progress after each batch.

## Choose a deployment target

| Capability | AWS | Cloudflare |
| --- | --- | --- |
| Records, conditional commits and pages | DynamoDB adapter | D1 adapter |
| Private files | S3 adapter | R2 adapter |
| Background jobs | SQS | Queues |
| Recurring jobs | EventBridge | Cron Triggers |
| Signed-in requests | OIDC | OIDC |
| Deployment status | Preview | Experimental artifacts using existing resources |

The same application behavior is the target on both providers. AWS tests use SDK
fakes. Cloudflare database and file tests use real local D1 and R2 bindings.
Neither proves production readiness. Cloudflare's normal Cell deploy command
remains gated while provisioning and live lifecycle verification are incomplete.

## Run the reference import

The source project includes a small catalogue Cell that exercises this path on
Mezair Local. From `mezair-cloud/`, run:

```bash
pnpm --filter portable-backends typecheck
pnpm --filter portable-backends check
pnpm --filter portable-backends build
pnpm verify:application-backends
```

The verifier starts a local HTTP server with a JSON database and file adapter.
It checks authenticated imports, conflict rollback, private source reads,
scheduled outbox publication, persisted job ids, duplicate receipts, poison
failure records, and restart recovery. Its output says `local-acceptance` and
sets `liveCloudEvidence` to `false`. The local job store does not run a queue
consumer, so this does not verify SQS or Cloudflare Queue retries or dead-letter
handling.

Before a live rehearsal, check provider identity and access with
`pnpm preflight:application-backends -- --provider aws` or
`pnpm preflight:application-backends -- --provider cloudflare`. The Cloudflare
check delegates authentication to Wrangler. If more than one account is
accessible, select one with `--account <account-id>` or
`CLOUDFLARE_ACCOUNT_ID`; the preflight does not guess. It does not read
Wrangler's credential cache itself or include its email or credentials in the
report. These commands make read-only identity checks and create no resources;
they do not test resource permissions or Cell behavior. Record a full rehearsal
against the
[evidence schema](https://github.com/anthonyhumphreys/mezair/blob/main/mezair-cloud/scripts/application-backends-evidence.schema.json)
and follow the source project's
[live rehearsal and cleanup contract](https://github.com/anthonyhumphreys/mezair/blob/main/mezair-cloud/docs/architecture/application-backends.md#live-rehearsal-record).

See the source project's [backend contract and release checks](https://github.com/anthonyhumphreys/mezair/blob/main/mezair-cloud/docs/architecture/application-backends.md)
for configuration, failure behavior, schedule restrictions, and the live evidence
still needed before public traffic.
