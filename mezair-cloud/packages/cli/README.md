# @mezairstack/cloud-cli

CLI package for Mezair Cloud.

The CLI binary is `mezair-cloud`.

This is the only public Mezair Cloud npm package during alpha. Runtime, client,
builder, local, auth, control-plane, and AWS workspace packages are private
implementation details until their external API contracts are deliberately
stabilized.

## Install

```bash
npm install --global @mezairstack/cli
npm install --global @mezairstack/cloud-cli
mezair cloud check --json
```

The umbrella `mezair` command is the intended user-facing entrypoint. It
dispatches to the installed Cloud product CLI.

Use the direct binary when testing this package itself or debugging wrapper
dispatch:

```bash
mezair-cloud check --json
```

## Workspace usage

From a checkout, build the workspace and run the CLI through the root script:

```bash
cd mezair-cloud
pnpm install --ignore-scripts
pnpm build
pnpm mezair-cloud --help
pnpm mezair-cloud new notes
```

Inside an example Cell, use the built entrypoint directly:

```bash
node ../../packages/cli/dist/index.js check --json
```

Initial commands:

- `mezair-cloud new <name>`
- `mezair-cloud dev`
- `mezair-cloud check`
- `mezair-cloud review`
- `mezair-cloud build`
- `mezair-cloud agents discover`
- `mezair-cloud agents guardian`
- `mezair-cloud executions conformance --json`
- `mezair-cloud approvals list`
- `mezair-cloud approvals approve <id>`
- `mezair-cloud approvals reject <id>`
- `mezair-cloud approvals audit`
- `mezair-cloud inspect`
- `mezair-cloud logs`
- `mezair-cloud logs --trace <traceId>`
- `mezair-cloud usage --local`
- `mezair-cloud usage --preview`
- `mezair-cloud db list`
- `mezair-cloud db dump <table>`
- `mezair-cloud db branch <name>`
- `mezair-cloud db branches`
- `mezair-cloud db use <name>`
- `mezair-cloud db diff <name>`
- `mezair-cloud db promote <name>`
- `mezair-cloud db delete <name> --yes`
- `mezair-cloud db cleanup --expired`
- `mezair-cloud schedules list`
- `mezair-cloud schedules run <name>`
- `mezair-cloud auth test --json`
- `mezair-cloud deploy --preview [--name branch]`
- `mezair-cloud rollback --preview --dry-run`
- `mezair-cloud destroy --preview --app <name> [--name branch] --yes`

Every automation-oriented command must support `--json`.

`mezair-cloud executions conformance --json` exercises the provider-neutral
execution control plane without a cloud account: idempotent creation, approval
pause/resume, cursor replay, patch return, and verified teardown.

`mezair-cloud auth test --json` runs the local/OIDC auth conformance kit and
reports stable check ids for CI: local JWT issue/verify, runtime auth policy,
OIDC discovery/JWKS verification, issuer/audience/expiry rejection, claim
mapping, and common provider fixture configs.

See `docs/specs/cli.md` for the command contract.

## Deploy Sync/Mesh from a checkout

The branch CLI supports both `mesh --mode hosted` and `mesh --mode self-hosted`.
Use `mesh plan`, `provision`, `migrate`, `apply` and `secrets` for the backend,
and `mesh provisioner` for optional Sandbox capacity. Wrangler is an internal
deployment dependency, resolved from the selected Worker project.

Follow the [branch deployment runbook](../../../mezair-app/docs/runbooks/hosted-sync/deploy.md)
for complete commands, isolated staging configuration and end-to-end checks.
Use the built CLI when testing unreleased branch changes. Production
apply/remove requires evidence; initial non-production testing uses explicit
`--stage staging --test-deployment`.
