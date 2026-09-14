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

## Recipe fixes the live run surfaced

1. **`ENROLLMENT_ADMIN_TOKEN` misclassified dev-only** — a production plan
   could never carry the deployment-admin credential that bootstraps the
   first enrollment code (spec §268) and keeps `account.deletionStatus`
   reachable after device revocation. `DEV_ONLY_ENVIRONMENT_KEYS` is now
   `ANVIL_DEV_SPIKE` alone.
2. **Migrations gated on `--first-deploy`** — the generated config dropped
   `migrations` on the default path, so every fresh-worker or
   fresh-namespace apply was rejected by the API (`10061`). Migrations are
   cumulative, append-only history deduped by tag; the config now always
   emits them and `--first-deploy` only records plan intent.
3. **`remove` never wrote its config** — `wrangler delete` read a stale
   `wrangler.mesh.jsonc` (last apply's worker name), so remove could
   delete the wrong worker or nothing at all. `removeMeshDeployment` now
   regenerates the config for its own plan first.
4. **Secrets provisioned before first deploy** — `wrangler secret put` on
   a never-deployed worker creates a stub version the real deploy does
   not carry forward; on a truly clean account the admin route 404'd.
   The rehearsal now provisions secrets against the deployed worker and
   readiness-gates on the admin route before running checks.

Harness hardening the live run surfaced: descriptor/enroll/conformance
now tolerate workers.dev and secret-version propagation latency
(poll + bounded retry instead of single-shot), the restored worker is
only scheduled for cleanup after its apply actually lands, and the
remove step attempts each worker independently.

## Status — live run PASSED (two accounts)

`evidence/mesh-rehearsal-1789385691518.json` — 10/10 against account
`3912de85…` (workers.dev `anthony-humphreys`), and
`evidence/mesh-rehearsal-1789391438943.json` — 10/10 against account
`71506091…` (workers.dev `still-glitter-7d20`), a genuinely clean account
that had never run Anvil:

deploy `mesh-rehearsal-live2` → descriptor advertises `anvil-backend/1`
+ `sync/1` + `enrollment-code` → **11/11 conformance** on the fresh
deploy → enroll + seed + `data.export` (3 entities) → in-place
`mesh apply` upgrade with data verified intact → `mesh-rehearsal-live2
-restored` deploy + `data.import` round-trip (3/3 restored) → both
workers removed, zero residue (worker list, DO namespaces, and R2
verified clean on both accounts).

Reproduce:

```sh
cd anvil-cloud
ANVIL_CLOUDFLARE_LIVE=1 \
CLOUDFLARE_ACCOUNT_ID=<account id> \
CLOUDFLARE_API_TOKEN=<scoped token> \
ANVIL_MESH_ADMIN_TOKEN=<chosen admin secret> \
pnpm verify:mesh-rehearsal -- --name <worker> --subdomain <workers.dev sub>
```
