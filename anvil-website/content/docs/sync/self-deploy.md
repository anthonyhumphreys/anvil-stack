---
title: Self-deploy the backend
navTitle: Self-deploy the backend
description: Deploy the official Sync & Mesh backend to your own Cloudflare account with the anvil-cloud mesh commands — plan, apply, connection, remove.
product: Anvil Sync & Mesh
section: Guides
journey: build
order: 90
---

# Self-deploy the backend

The backend is provider-neutral and the deployment story is honest about it:
you run the same worker the Anvil-hosted option runs, on your own Cloudflare
account, with the `anvil-cloud` CLI. Backend source lives in the desktop repo
at `anvil-app/cloud/backend`; the CLI that deploys it lives in `anvil-cloud`.

Four commands cover the lifecycle: `plan`, `apply`, `connection`, `remove`.
All accept `--json` for automation.

## `mesh plan`

```sh
anvil-cloud mesh plan --backend <path> --name <worker> \
  [--stage production] [--env <name>] [--account-id <id>] \
  [--base-url <url> | --subdomain <sub>] [--bucket <name>] \
  [--oidc-issuer <url> --oidc-client-id <id>] [--first-deploy] [--json]
```

`plan` computes the deployment and writes a generated `wrangler.mesh.jsonc`:

- **Durable Object bindings** for the coordination objects the backend uses;
- **cumulative SQLite migrations** — a deployable config always carries its
  full migration history, so `--first-deploy` records intent only and does
  not change what gets emitted;
- the **R2 artifact bucket** for sealed artifact bytes.

`--base-url` and `--subdomain` are the addressing choice (a real URL or a
`workers.dev` subdomain); `--oidc-issuer`/`--oidc-client-id` pin the identity
the deployment advertises. Point `--backend` at the worker source —
`anvil-app/cloud/backend` in the monorepo.

## Provision, migrate, apply, and secrets

`plan` only computes configuration. For a real non-production deployment, run
the lifecycle commands with the same target options on every invocation:

```sh
anvil-cloud mesh provision --backend <path> --mode self-hosted --name <worker> \
  --account-id <id> --base-url <url> --bucket <name> --json
anvil-cloud mesh migrate --backend <path> --mode self-hosted --name <worker> \
  --account-id <id> --base-url <url> --bucket <name> --json
anvil-cloud mesh apply --backend <path> --mode self-hosted --name <worker> \
  --account-id <id> --base-url <url> --bucket <name> \
  --stage staging --test-deployment --json
anvil-cloud mesh secrets --backend <path> --mode self-hosted --name <worker> \
  --account-id <id> --base-url <url> --bucket <name> \
  --from-file <secret-json> --json
```

`provision` creates or reuses the selected R2 bucket. `migrate` applies any
declared database migrations (self-hosted mode has no hosted billing D1).
`apply` deploys through Wrangler; it does not install secrets or claim that a
live backend is healthy. Install secrets after the Worker exists because the
Worker must exist before Wrangler can attach them. `--dry-run` performs local
checks without deploying. Production apply/remove requires `--evidence
<ref>`; initial staging checks use `--test-deployment`.

## `mesh connection`

```sh
anvil-cloud mesh connection --name <worker> --base-url <url> \
  [--stage production] [--out <path>] [--allow-insecure] [--json]
```

Writes the **discovery file** the desktop app's Sync & Mesh settings consume
— the descriptor a "Your Cloudflare" or "Compatible backend" mode reads to
learn endpoints, protocols, auth issuer, and negotiated limits.
`--allow-insecure` exists for non-TLS development URLs; do not point a real
backend at it.

## `mesh remove`

```sh
anvil-cloud mesh remove --backend <path> --name <worker> \
  [--evidence <ref>] [--json]
```

`remove` **regenerates its own plan before deleting** — it never targets
whatever config happened to be generated last, so teardown deletes the worker
you named, not a stale one.

## Rehearsal and verification

The full lifecycle rehearsal — deploy, conformance, upgrade, restore, remove —
is scripted in `anvil-cloud/scripts/verify-mesh-rehearsal.mjs`. Run it before
you trust a deployment for real devices; it is the same rehearsal the hosted
path has been through.

After deploy, prove the backend speaks the contract with the conformance
suite — see [Backend conformance](/docs/sync/conformance):

```sh
pnpm conformance -- --url <backend> --admin-token <token>
```

## Wiring the desktop app

1. `mesh plan` + `mesh apply` → worker live, secrets provisioned, admin ready.
2. `mesh connection` → discovery file.
3. Desktop: Settings → Sync & Mesh → **Your Cloudflare** (or **Compatible
   backend**) → paste the base URL or load the discovery file → sign in and
   enable.

Nothing uploads until you sign in and enable — pinning stores the association
only. See [Connection modes](/docs/sync/overview) for the full model.

## Self-host account page

A self-hosted Worker serves an operator page at `/account`. It is deliberately
not the hosted WorkOS account area: hosted deployments return no account page
there and keep account management on the website. On a self-hosted Worker,
enter the deployment admin token and an account id at `/account` to issue the
first device enrollment code. The token is entered and used in the browser tab
only. After the first device is enrolled, use Anvil Desktop's normal device
management and in-app pairing for additional devices. The page's inspection
control is an operator convenience, not a replacement for device auth.

## Current limits

- Rehearsed on real Cloudflare deployments; not yet demoed end-to-end on
  physical multi-device hardware.
- `plan` emits generated config — hand-edits to `wrangler.mesh.jsonc` will be
  regenerated away. Treat it as build output.
- The full flag surface, exit codes, and JSON shapes are in the
  [CLI reference](/docs/cloud/cli-reference). Backend internals and the rest
  of the Anvil Cloud CLI live in [Anvil Cloud](/docs/cloud/overview).
