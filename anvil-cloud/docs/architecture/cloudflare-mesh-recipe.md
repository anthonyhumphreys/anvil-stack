# Cloudflare Mesh backend recipe

## Purpose

The Mesh backend recipe is a bounded deployment recipe for the Anvil Mesh
backend: a self-contained Cloudflare Worker project that serves the sync
discovery descriptor, JSON-RPC operations, and the WebSocket connect route. The
recipe lives in `@anvil-cloud/cloudflare` and is exposed through
`anvil-cloud mesh …` commands.

Unlike the Cell preview adapter, the recipe does not rebuild or re-bundle
application source. It consumes an existing Worker project directory as the
deployable artifact: it reads the project's own `wrangler.jsonc` for Durable
Object bindings, migration tags, R2 buckets, entrypoint, and compatibility
date, then renders a generated overlay configuration (default
`wrangler.mesh.jsonc`) that Wrangler builds and deploys in place.

This keeps the backend project as the single source of truth for bindings and
migrations while giving operators a reviewable plan, a generated config, a
gated lifecycle, and a pinnable connection export.

## Planning

```sh
anvil-cloud mesh plan --backend <path> --name <worker> \
  [--stage production] [--env <name>] [--account-id <id>] \
  [--base-url <url> | --subdomain <workers.dev-subdomain>] \
  [--bucket <r2-bucket>] \
  [--oidc-issuer <url> --oidc-client-id <id>] [--oidc-scopes "openid profile"] \
  [--first-deploy] [--dev] [--temporary] [--write] [--json]
```

`createMeshDeploymentPlan(options)` performs no provider calls. It reads the
backend project's Wrangler configuration and produces a stable plan shape:

- `workerName`, `stage`, `authentication`, `backendDir`;
- `durableObjects` — the `ACCOUNT` (`AccountCoordinator`) and `SESSIONS`
  (`SessionCoordinator`) bindings detected in the project config;
- `migrations` + `migrationMode` — `create` emits the project's
  `new_classes`/`new_sqlite_classes` migration tags for a first deploy;
  `existing` omits them because the classes already exist;
- `r2Buckets` — the `ARTIFACTS` binding with an optional name override;
- `vars` — non-secret Worker variables, sorted and filtered;
- `secrets` — secret _names_ the operator provisions with `wrangler secret`;
  values are never accepted or emitted;
- `advertisedAuthModes` — `enrollment-code` always, plus `oidc-pkce` when both
  `OIDC_ISSUER` and `OIDC_CLIENT_ID` vars are set;
- `diagnostics` — blocking/review/info findings about missing prerequisites;
- `gates` — the evidence gate described below;
- `connection` — the connection export preview;
- `operations` — apply/upgrade/retain/remove commands and notes;
- `config` — the generated config path and its rendered contents.

`--write` on `mesh plan` also writes the generated config. Without it, the
plan command renders the config into `plan.config.contents` without touching
the filesystem.

### Fail-closed environment rules

The backend intentionally ships no development flags in its deployed
configuration. The recipe preserves that split:

- `ANVIL_DEV_SPIKE` and `ENROLLMENT_ADMIN_TOKEN` are development-only keys. A
  non-dev recipe removes them from `vars`/`secrets` and emits a blocking
  `MESH_DEV_ONLY_VALUE` diagnostic that does not name the rejected keys.
- Passing `--dev` selects the development recipe, which may list
  `ENROLLMENT_ADMIN_TOKEN` as an optional secret and `ANVIL_DEV_SPIKE` as a
  var for local fixtures only.
- `OIDC_ISSUER` without `OIDC_CLIENT_ID` (or vice versa) produces a
  `MESH_OIDC_INCOMPLETE` review diagnostic, because the descriptor only
  advertises `oidc-pkce` when both are configured.
- `--temporary` produces a `MESH_TEMPORARY_UNSUPPORTED` blocking diagnostic:
  Temporary Accounts do not list R2 as a supported resource, and the backend
  requires the `ARTIFACTS` bucket.

## Generated configuration

`writeMeshWranglerConfig(plan)` writes `plan.config.contents` to
`plan.config.path` (default `<backend>/wrangler.mesh.jsonc`). The generated
file:

- sets `name` to the operator-supplied Worker name;
- points `main` at the backend entrypoint, resolved relative to the config
  location so the config may live outside the project;
- reuses the project's `compatibility_date`, Durable Object bindings, new-class
  migrations (first deploy only), and R2 bucket bindings;
- emits `workers_dev: true`, an optional `account_id`, and the filtered `vars`;
- when `--env <name>` is given, adds a named environment that repeats the
  bindings under `env.<name>` (named environments do not inherit bindings) and
  derives the environment Worker name as `<worker>-<env>`.

Because Wrangler builds the project source directly, upgrades redeploy the same
generated config; migration tags already applied are skipped by the provider.

## Lifecycle and the evidence gate

Apply and remove are thin wrappers over `wrangler deploy` and
`wrangler delete` against the generated config, using the package's existing
subprocess conventions: credential sanitisation for Temporary Accounts, claim
URL redaction, and a Wrangler version check.

Both operations are gated behind recorded provider evidence, matching the
Cell-level `cloudflare-plan-only-gate` convention:

- `applyMeshDeployment` / `anvil-cloud mesh apply` without an evidence
  reference returns `MESH_PROVIDER_EVIDENCE_REQUIRED`, marks the result
  `gated: true`, and never spawns Wrangler. The same gate applies to
  `removeMeshDeployment` / `anvil-cloud mesh remove`, which has no un-gated
  path.
- Blocking plan diagnostics (invalid worker name, dev-only keys, missing
  bindings, invalid base URL, Temporary Account mode) fail closed for both
  operations even when evidence is supplied.
- `applyMeshDeployment` with `dryRun: true` runs `wrangler deploy --dry-run`
  without evidence. This is a local compile check equivalent to the package's
  existing non-live verification path and performs no provider mutation.
- When evidence is supplied, `apply` first writes the generated config, then
  deploys; on a workers.dev response it derives and — when the plan carries a
  `connectionPath` — writes the connection record. `remove` runs
  `wrangler delete --config <generated>`.

The CLI accepts an evidence reference via `--evidence <ref>`; the reference is
echoed back in the lifecycle result so review tooling can correlate the run
with the recorded smoke evidence. Until provider lifecycle smoke evidence for
this recipe is actually recorded, every apply/remove invocation reports the
gate.

### Upgrade and retain semantics

- **Upgrade** is re-apply: redeploy the same generated config. New Durable
  Object classes must arrive as new migration tags; never reuse an applied
  tag.
- **Retain** is the default on remove: `wrangler delete` deletes the Worker
  script only. Durable Object storage and R2 objects persist under the account
  and continue to bill until deleted explicitly. A full teardown deletes those
  resources separately after the operator confirms no unrecovered data
  remains.

## Connection export

The recipe exports a pinnable connection record for the desktop:

```json
{
  "schemaVersion": "0.1",
  "kind": "anvil-mesh-backend",
  "workerName": "mesh-backend",
  "stage": "production",
  "baseUrl": "https://mesh.example.com",
  "descriptorUrl": "https://mesh.example.com/.well-known/anvil-backend"
}
```

`createMeshConnectionRecord` requires an `https` base URL with no embedded
credentials; plain `http` is accepted only for loopback hosts behind the
explicit `--allow-insecure` opt-in. `descriptorUrl` is always
`<base>/.well-known/anvil-backend`, matching the backend's discovery route.

The record is produced three ways:

- at plan time when `--base-url` or `--subdomain` is supplied;
- after apply, from the workers.dev URL Wrangler reports;
- directly via `anvil-cloud mesh connection --name <worker> --base-url <url>
[--out <path>]`, which prints and optionally writes the record.

## API surface

```ts
import {
  createMeshDeploymentPlan,
  writeMeshWranglerConfig,
  applyMeshDeployment,
  removeMeshDeployment,
  createMeshConnectionRecord,
  writeMeshConnectionRecord,
} from "@anvil-cloud/cloudflare";
```

All functions are Promise-based and take an injectable
`WranglerCommandRunner` for tests; no provider SDKs are exposed.
