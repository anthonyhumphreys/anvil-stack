# `@anvil-cloud/cloudflare`

Cloudflare deployment planning for Anvil Cells.

The alpha package remains intentionally plan-only at the normal CLI boundary.
It maps provider-neutral Cell capabilities to Workers, Workers Assets, D1, R2,
Queues, bindings, and observability metadata while blocking `deploy` and
`remove` until provider lifecycle smoke evidence is recorded.

The package now contains the experimental verification seam behind that gate:

- a Worker `fetch()` bridge for health, query, mutation, and endpoint requests;
- a workerd-safe runtime entrypoint and deterministic Worker artifact;
- generated Wrangler configuration with Workers Assets support;
- a Wrangler 4.102.0+ Temporary Account path that strips inherited provider
  credentials and redacts bearer claim URLs;
- an opt-in live smoke verifier for permanent or temporary accounts.

The experimental host now implements D1 records and conditional commits, private
R2 files, queue producers and consumers, Cron Trigger dispatch, and OIDC bearer
verification. Artifacts can bind existing stage-specific resources and emit the
D1 migration, retry/dead-letter configuration and observability settings.

Normal Cell deployment remains gated. Automatic resource and secret provisioning,
live lifecycle evidence, events, durable workflows, services and agent sandboxes
are incomplete. See [portable app backends](../../docs/architecture/application-backends.md)
for the shared AWS/Cloudflare contract, outbox behavior and release evidence still
required. Planned resources remain distinct from verified deployments.

Temporary Account planning is available through the CLI:

```sh
anvil-cloud plan --stage preview --adapter cloudflare --temporary --json
anvil-cloud review --adapter cloudflare --temporary --env preview --json
```

Temporary mode records provider requirements and compatibility diagnostics. It
does not create an account or expose temporary API tokens or claim URLs.

## Sync/Mesh backend deployment

The package also deploys the existing Anvil Sync/Mesh Worker directly from its
source project. `anvil-cloud mesh` supports `--mode self-hosted` and
`--mode hosted`, resource provisioning, hosted D1 migrations, secret installation,
and an optional Sandbox provisioner deployment. Hosted mode retains billing
vars, D1, cron triggers and service bindings from `wrangler.hosted.jsonc`.

```sh
anvil-cloud mesh plan --backend <path> --name <worker> --mode hosted --json
anvil-cloud mesh provision <target-options> --json
anvil-cloud mesh migrate <target-options> --json
anvil-cloud mesh apply <target-options> --dry-run --json
anvil-cloud mesh apply <target-options> --stage staging --test-deployment --json
anvil-cloud mesh secrets <target-options> --from-file <secret-json> --json
anvil-cloud mesh provisioner plan --provisioner <path> --name <worker> --json
```

Use the [deployment runbook](../../../anvil-app/docs/runbooks/hosted-sync/deploy.md)
from the monorepo for complete target options and the branch-testing sequence.
The [recipe architecture](../../docs/architecture/cloudflare-mesh-recipe.md)
documents config generation, target isolation and lifecycle behavior.

Production apply requires a provider evidence reference. Remove requires a
live evidence JSON artifact matching the Worker, stage and generated config.
Explicit `--test-deployment` is available only for a non-production stage;
dry-runs need no evidence. With `--enrollment-admin`, apply reads the required
secret from `ANVIL_MESH_ADMIN_TOKEN` and installs it after deploy. The generic
Cell adapter's plan-only gate remains unchanged.

From the workspace root, compile the generated Worker through Wrangler without
making provider calls:

```sh
pnpm verify:cloudflare-preview
```

The explicit live commands, cleanup behavior, and claim-URL handling are
documented in `examples/cloudflare-smoke/README.md`.
