# Anvil Sync & Mesh v1 contract (`cloud/contract`)

Provider-neutral, frozen v1 network contract for Sync (`sync/1`) and Mesh (`mesh/1`).
Pure TypeScript + JSON only: no Electron, Node-only, or Cloudflare runtime
dependency. Validators are hand-rolled (no zod/ajv); the only crypto touchpoint
(`hashChange`) takes an injected `sha256Hex` function.

- Protocol: `anvil-backend/1` (`version.ts`)
- Profiles: `sync/1`, `mesh/1`; socket subprotocol `anvil.mesh.v1`
- Descriptor version: `1`

## Freeze policy

- **Wire-major freeze.** Anything on the wire is frozen under
  `anvil-backend/1`: envelope shape, error codes and their HTTP statuses,
  discovery fields and validation rules, operation names, per-operation
  profile/role, sync payload shapes, job/attempt/handoff/artifact states and
  transition tables, socket frame types, canonical hash serialization.
- **Additive minor only.** New optional response fields (ignored by old
  clients), new profiles, and new entity schema versions are allowed without
  a new wire major. Renaming, retyping, or reinterpreting an existing field,
  or adding a required capability to an existing operation, requires a new
  wire major and an app update.
- **Unknown policy.** Unknown optional response fields are ignored; unknown
  operations fail explicitly (`unsupported-operation`); unsupported required
  capabilities fail before execution.

## Frozen vs draft

Frozen in code: `version.ts`, `discovery.ts`, `envelope.ts`, `sync.ts`,
`operations.ts`, `jobs.ts`, `handoff.ts`, `socket.ts`, `artifacts.ts`.

Deliberately draft (boundaries, not promises): token lifetimes and
rotation/reuse semantics (AUTH-01 owns the session contract), server-side
quotas beyond the default limits, the OpenAPI/JSON-Schema rendering of these
types, and the conformance runner/fake backend (BYOB-02). Those must agree
with this directory when they land; nothing here may be silently reinterpreted.

## Layout

- `index.ts` — re-exports everything.
- `fixtures/*.json` — golden vectors: valid/invalid descriptors, push
  batch + mixed push result, pull page, oversized-payload error envelope,
  handoff path, cancel-vs-complete race.
- `__tests__/*.test.ts` — vitest coverage of validation, URL resolution,
  canonical hashing, transition tables, and status mapping.

## Spec ambiguities resolved

- `quota-exceeded` maps to HTTP 413 (it is a size/retention refusal, not rate
  limiting, which stays 429).
- `unsupported-version` / `unsupported-operation` map to 400 (protocol-level
  rejection, not HTTP-version 505).
- Domain push outcomes (`conflict`, `reset-required`, `receipt-expired`) map
  to 409 when they surface top-level, matching the 409 conditional-conflict
  rule; inside a batch they ride a successful envelope.
- `device.policy.publish` is worker-role: a device publishes only its own
  local policy, never another target's settings.
- `job.cancel` and `handoff.advance`/`handoff.cancel` are `either`-role:
  cancellation is an idempotent durable intent from either side; generation
  fencing (not the role) guards correctness.
- `data.operationStatus` is included in the inventory as the status reader
  for export/import operations.
- Cancel on a `queued`/`awaiting-approval` job (or a `claimed`/`preparing`
  attempt) may complete directly to `cancelled`: nothing is running, so no
  stop needs verifying. `running` must always pass through
  `cancel-requested`/`stopping`.
- `SyncCursor` is a branded string: opaque to clients, plain JSON on the wire.
- Relative-path validation rejects empty/dot segments (so also trailing and
  double slashes) as well as the specified leading slash, `..`, scheme,
  authority, and query forms.
