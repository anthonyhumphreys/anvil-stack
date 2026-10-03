# Anvil backend conformance (BYOB-02)

A standalone runner that proves a backend speaks the frozen `anvil-backend/1`
wire contract — provider-neutral by construction. The same suite passes
against the Cloudflare Durable Object backend and the in-memory Node fixture,
and the unmodified desktop client's real network stack is exercised against
the fixture by `src/main/services/__tests__/byob-conformance.test.ts`.

## Files

- `suite.mjs` — self-contained conformance checks (no repo imports):
  discovery, enrollment-code auth, session refresh/revocation, durable
  `sync.push`/`sync.pull`/`sync.scan.*` (canonical-JSON + SHA-256 payload
  hashing re-implemented inline so canonicalization agreement is verified
  over the wire), device lifecycle ops, `data.export.*`/`data.import.*`,
  `data.operationStatus`, and `account.delete`/`account.deletionStatus`.
- `fixture-server.mjs` — the non-Cloudflare reference backend: plain
  `node:http`, in-memory state, `sync/1` only. It exists to prove the
  contract is implementable without Durable Objects, R2, or Workers — it is
  a conformance fixture, not a production backend.

## Run it

Against a deployed or `wrangler dev` backend:

```sh
node conformance/suite.mjs --url http://127.0.0.1:8787 --admin-token dev-admin-token
```

Against the fixture (spawns it, waits for readiness, tears it down):

```sh
node conformance/suite.mjs --fixture
```

or `pnpm conformance:fixture` / `pnpm conformance` from `cloud/backend`.

Exit code is non-zero on any failed check. Point `--url` at a third-party
implementation to verify compatibility claims; a backend that passes all
checks implements the `sync/1` profile correctly enough for the unmodified
desktop to enroll, sync, and manage devices.
