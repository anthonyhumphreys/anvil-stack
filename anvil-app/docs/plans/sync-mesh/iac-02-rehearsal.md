# IAC-02 — clean-account self-deployment + upgrade/restore rehearsal

Packet: **IAC-02** — clean-account self-deployment and upgrade/restore
rehearsal.
Depends on: IAC-01 (recipe), OPS-01 (restore drill), BYOB-02 (conformance
runner).
Gate from spec §15: no managed Anvil identity or runtime dependency.

## What landed

**Rehearsal driver** — `anvil-cloud/scripts/verify-mesh-rehearsal.mjs`
(`pnpm verify:mesh-rehearsal`). It drives the real `anvil-cloud mesh`
lifecycle commands plus the BYOB-02 conformance suite end to end, records
each step into a JSON evidence record (`evidence/mesh-rehearsal-*.json`),
and never consults an Anvil-hosted service: the only credentials are the
operator's scratch Cloudflare account and the operator-chosen
`ENROLLMENT_ADMIN_TOKEN` value.

Live sequence (`ANVIL_CLOUDFLARE_LIVE=1` + `CLOUDFLARE_ACCOUNT_ID` +
`CLOUDFLARE_API_TOKEN` + `ANVIL_MESH_ADMIN_TOKEN`):

1. `mesh plan --first-deploy --enrollment-admin` — asserted free of
   development-only keys, DO bindings + ARTIFACTS bucket present.
2. `wrangler secret put ENROLLMENT_ADMIN_TOKEN` on the new worker.
3. `mesh apply` — clean-account deploy.
4. Descriptor fetch — frozen contract advertised (`anvil-backend/1`,
   `sync/1`, `enrollment-code`).
5. `conformance/suite.mjs --url <worker>` — the same 11 checks that pass
   on the fixture.
6. Enroll via admin code → seed 3 entities → `data.export.*` backup.
7. `mesh apply` again (no `--first-deploy`, `migrationMode: existing`) —
   upgrade rehearsal; data verified intact via `sync.pull`.
8. `mesh apply --first-deploy` under `<name>-restored` →
   `data.import.preview/commit` of the backup → `sync.pull` verifies the
   restored dataset — restore rehearsal.
9. `mesh remove` both workers (state retained per recipe semantics).

Every post-deploy step is best-effort until removal: a failed check
defers its error so cleanup always runs — a rehearsal must never leak a
worker on the clean account.

Non-live mode (the default) validates everything requiring no provider
mutation: the production plan must be clean and `apply --dry-run` must
compile the Worker through wrangler. Both pass today.

## Recipe fix this packet surfaced

`ENROLLMENT_ADMIN_TOKEN` was classified as a development-only key, so a
production plan could never carry the deployment-admin credential — which
is exactly the credential that bootstraps the first device's enrollment
code on a clean deployment (spec §268) and keeps `account.deletionStatus`
reachable after device sessions are revoked. `DEV_ONLY_ENVIRONMENT_KEYS`
is now `ANVIL_DEV_SPIKE` alone; `ENROLLMENT_ADMIN_TOKEN` plans as a normal
production secret.

## Status

Harness complete and verified locally (non-live 3/3: plan clean, dry-run
compiles, evidence written). The live run is one command away and is
blocked only on scratch-account credentials — this machine has no
Cloudflare auth (`wrangler whoami`: unauthenticated) and Temporary
Accounts are correctly rejected because the backend requires R2. To run:

```sh
cd anvil-cloud
ANVIL_CLOUDFLARE_LIVE=1 \
CLOUDFLARE_ACCOUNT_ID=<scratch account id> \
CLOUDFLARE_API_TOKEN=<scoped token> \
ANVIL_MESH_ADMIN_TOKEN=<chosen admin secret> \
pnpm verify:mesh-rehearsal -- --name <worker> --subdomain <workers.dev sub>
```
