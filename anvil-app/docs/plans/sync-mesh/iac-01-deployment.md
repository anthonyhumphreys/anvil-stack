# IAC-01 — Mesh backend deployment recipe

Packet: **IAC-01** — Anvil Cloud Mesh recipe, stateful Cloudflare lifecycle,
connection export.
Depends on: BACKEND-01 (the Worker/DO/R2 spike at `anvil-app/cloud/backend`),
BYOB-01 (discovery contract).
Gate from spec §15: plan/apply/retry/upgrade/retain/remove with provider
evidence.

## What landed

The recipe lives in `anvil-cloud/packages/cloudflare` (`src/mesh-recipe.ts`)
and is exposed through `anvil-cloud mesh …` in the platform CLI. It treats the
BACKEND-01 project directory as the deployable artifact: the recipe reads the
project's own `wrangler.jsonc` for Durable Object bindings (`ACCOUNT` /
`AccountCoordinator`, `SESSIONS` / `SessionCoordinator`), `new_sqlite_classes`
migration tags, the `ARTIFACTS` R2 binding, entrypoint, and compatibility date,
then renders an overlay config (`wrangler.mesh.jsonc`, or `--config-out`) with
the operator's Worker name. Wrangler builds the project source; the recipe
never re-bundles it.

```sh
anvil-cloud mesh plan --backend <backend-path> --name <worker> \
  --first-deploy --base-url <https-url> [--write] [--json]
anvil-cloud mesh apply --backend <backend-path> --name <worker> [--evidence <ref>] [--dry-run] [--json]
anvil-cloud mesh remove --backend <backend-path> --name <worker> [--evidence <ref>] [--json]
anvil-cloud mesh connection --name <worker> --base-url <url> [--out <path>] [--json]
```

- **Plan** is provider-free and stable JSON: worker name, DO bindings,
  migrations (`create` on `--first-deploy`, `existing` afterwards), R2 bucket
  (overridable via `--bucket`), filtered vars/secrets, advertised auth modes,
  diagnostics, the evidence gate, and the rendered config preview.
- **Apply/remove** are thin `wrangler deploy` / `wrangler delete` wrappers
  against the generated config with the package's existing isolation
  conventions (temporary-account credential stripping, claim-URL redaction,
  version check). Both are gated behind recorded provider evidence —
  `MESH_PROVIDER_EVIDENCE_REQUIRED`, no subprocess spawned — until the
  lifecycle smoke evidence this packet's gate requires is recorded.
  `apply --dry-run` compiles locally without evidence (no provider mutation).
- **Upgrade** is re-apply of the same generated config; migration tags are
  idempotent, and new DO classes must arrive as new tags.
- **Retain** is the default on remove: `wrangler delete` removes the Worker
  script only; DO storage and R2 objects persist under the account until
  deleted explicitly.
- **Connection export** emits the pinnable record
  `{ baseUrl, descriptorUrl: "<base>/.well-known/anvil-backend" }` — https
  only, loopback http behind an explicit opt-in — from plan inputs or the
  workers.dev URL apply reports, written via `--connection-out`/`--out` and
  surfaced in `--json` output for the desktop to pin.

Fail-closed rules match the backend's own top-level/`env.dev` split: non-dev
plans strip `ANVIL_DEV_SPIKE` and `ENROLLMENT_ADMIN_TOKEN` with a blocking
diagnostic that does not name the keys; `--dev` selects the development recipe
that may list them. Temporary Accounts are blocked because the backend
requires R2. `OIDC_ISSUER`/`OIDC_CLIENT_ID` are optional vars that must be set
together for the descriptor to advertise `oidc-pkce`.

## What is deliberately still gated

Provider evidence for apply/remove has not been recorded, so the CLI emits the
gate diagnostic by default. Recording that evidence (a live deploy, descriptor
fetch, sync push/pull round-trip, and verified cleanup against a scratch
account) is the remaining work to open the gate; `IAC-02` clean-account
rehearsal builds on it.

## References

- Recipe implementation: `anvil-cloud/packages/cloudflare/src/mesh-recipe.ts`
- Lifecycle primitives: `anvil-cloud/packages/cloudflare/src/wrangler.ts`
- Recipe contract doc: `anvil-cloud/docs/architecture/cloudflare-mesh-recipe.md`
- Backend project consumed in place: `anvil-app/cloud/backend`
