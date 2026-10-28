# BACKEND-01 evidence

Local Cloudflare Workers vitest (`@cloudflare/vitest-plugin`) against the spike Worker + `AccountCoordinator`. This is not a deployed-account measurement.

## Rows written per accepted item

Each accepted `sync.push` item commits these SQLite writes inside one `this.ctx.storage.transactionSync` callback:

| Write | Table / index | Notes |
| --- | --- | --- |
| 1 upsert | `entities` | `INSERT … ON CONFLICT DO UPDATE` of the current revision, payload, and account sequence |
| 1 insert | `changes` | New account-scoped sequence row (PK) |
| 1 insert | `receipts` | `(enrollment_id, enrollment_sequence)` PK plus stored result JSON |
| 1 update | `sync_meta` | `next_sequence` advanced |
| 1 update | `enrollments` | `high_water` advanced when the sequence is new |
| index | `idx_entities_sequence` | Touched because `entities.sequence` changes |
| index | `idx_changes_entity` | Touched by the new `changes` row |
| indexes | table PKs | `entities (entity_type, entity_id)`, `changes(sequence)`, `receipts (enrollment_id, enrollment_sequence)` |

Cloudflare bills each modified index entry as an additional row write. Idempotent replays of the same `(enrollment_id, enrollment_sequence, payloadHash)` do **not** write these rows again; they return the stored receipt JSON.

A later per-item `conflict` / `rejected` / `receipt-expired` / `reset-required` still writes a receipt (and may advance `high_water`) but does **not** insert a `changes` row or bump the account sequence.

## Hibernation / duration

Idle Durable Object hibernation GB-s was **not** measured in this spike. Tests use `evictDurableObject` from `cloudflare:test` to prove SQL state (and hibernatable sockets) survive instance teardown. That is an eviction/recovery proof, not a billable duration sample. Do not treat local vitest runtime as free-tier residency evidence.

## What the tests prove

- Same enrollment sequence + same content hash returns the original receipt (lost-ack replay).
- Same sequence + different hash is rejected as `changed-content`.
- Stale `baseRevision` returns a `conflict` item with remote revision and content.
- Oversize or malformed items fail the request (`payload-too-large` / `malformed-request`) and accept none.
- Per-item conflict still commits earlier accepted items in the same batch.
- `sync.pull` honors `maxChanges`, `nextCursor` (decimal sequence string), and `hasMore`.
- Connected WebSockets receive `sync.invalidate` after an accepted push.
- After `evictDurableObject`, entities/changes/receipts and idempotent receipts are still present.
