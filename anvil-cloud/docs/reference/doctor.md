# Anvil Cloud Doctor Diagnostics

`anvil-cloud doctor --json` is the read-only preflight command for local Cell
work, generated artifacts, local runtime state, AWS preview prerequisites, and
auth smoke-test setup.

Every check returns the same top-level shape:

```json
{
  "id": "node.version",
  "status": "ok",
  "message": "Node 20.11.0 satisfies >=20.11.0.",
  "docs": "/docs/cloud/doctor#nodeversion",
  "hint": "Install Node 20.11.0 or newer.",
  "details": {}
}
```

`hint` is the remediation field. It is omitted when there is nothing useful to
do. `details` is intentionally check-specific, so automation should key on
`id`, `status`, and documented fields rather than parsing prose.

## Status Values

| Status    | Meaning                                                                          |
| --------- | -------------------------------------------------------------------------------- |
| `ok`      | The check passed.                                                                |
| `info`    | Optional setup is absent; useful to know, not a blocker.                         |
| `warning` | Something is missing, stale, occupied, or not configured for a broader workflow. |
| `error`   | The local environment cannot run the expected workflow safely.                   |

`doctor` exits with code `5` when any check reports `error`. Warnings and info
items keep the command successful because alpha workflows often check optional
preview/auth setup on machines that are only running local Cells.

## Diagnostic IDs

### node.version

Verifies the active Node.js version is at least `20.11.0`.

Remediation: install Node 20.11.0 or newer.

### pnpm.version

Checks that `pnpm` is available and satisfies the workspace version floor.

Remediation: install pnpm 9.x or newer before running workspace builds or
example verification.

### cli.built

Checks whether the built CLI entrypoint exists.

Remediation: run `pnpm build` in `anvil-cloud` before testing packaged CLI
flows.

### packages.publicBoundary

Checks that only intentional packages are public and that published packages do
not depend on `workspace:` ranges.

Remediation: update `docs/contributing/package-publishing.md` and the package
boundary tests before changing which packages are public.

### project.config

Looks for `anvil.json` in the current directory.

Remediation: run `doctor` inside a Cell project when checking local runtime
state.

### project.build

Looks for `.anvil/dist/manifest.json`.

Remediation: run `anvil-cloud build --json`.

### project.generatedClient

Checks `.anvil/generated/client.ts` exists and its generated query/mutation
metadata matches the built manifest.

Remediation: run `anvil-cloud build --json` to refresh generated client output.

### local.state

Checks for local runtime state under `.anvil/local`, including auth users,
database, logs, jobs, workflows, and services snapshots.

Remediation: run `anvil-cloud dev` or the notes verifier to create local state.

### local.runtime

Checks `GET /_anvil/health` on the configured runtime port.

Warning `details.reason` values:

| Reason             | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `invalid-json`     | Something answered on the port, but not with JSON.   |
| `not-anvil-health` | JSON came back, but not an Anvil health payload.     |
| `http-status`      | The health route returned a non-success HTTP status. |

Connection failures include the thrown error message in `details.error`.

Remediation: start `anvil-cloud dev`, pass `--port`, or stop the process using
the runtime port.

### ports.runtime

Checks whether the runtime port is available, or confirms it is occupied by the
expected Anvil Local runtime.

Remediation: pass `--port` to `anvil-cloud dev` or stop the process using that
port.

### ports.client

Checks whether the client dev-server port is available.

Remediation: pass `--client-port` to `anvil-cloud dev` or stop the process
using that port.

### sandbox.docker

Checks whether Docker is installed, running, and reachable on `PATH`.

This is an informational check because local Cell development does not require
Docker today, but Docker-backed sandbox providers use it when configured.

Remediation: install and start Docker before using Docker-backed local sandbox
providers.

### aws.region

Checks whether `AWS_REGION` or `AWS_DEFAULT_REGION` is configured.

Remediation: set one before AWS preview verification.

### aws.artifactBucket

Checks whether `ANVIL_AWS_ARTIFACT_BUCKET` is configured.

Remediation: set it before `anvil-cloud deploy --preview`.

### aws.deploymentMetadataTable

Checks whether `ANVIL_AWS_DEPLOYMENT_METADATA_TABLE` is configured.

Remediation: set it before remote `inspect` and `logs`.

### auth.oidc

Checks whether OIDC preview verification has enough configuration:
`ANVIL_AUTH_ISSUER` plus either `ANVIL_AUTH_AUDIENCE` or
`ANVIL_AUTH_JWKS_URI`.

`details.claims` reports the effective user id, email, and roles claim names
plus whether each was explicitly configured.

Remediation: configure issuer and audience or JWKS URI before authenticated AWS
preview smoke tests.

### auth.smokeToken

Checks whether `ANVIL_AWS_SMOKE_TOKEN` is configured for authenticated preview
query/mutation smoke coverage.

Remediation: set a short-lived smoke token scoped to the preview app.

### auth.expiredSmokeToken

Optional info check for `ANVIL_AWS_EXPIRED_SMOKE_TOKEN`.

Remediation: set this only when proving expired-token rejection in
`verify:aws-preview`.

### auth.wrongIssuerSmokeToken

Optional info check for `ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN`.

Remediation: set this only when proving issuer rejection in
`verify:aws-preview`.

### auth.wrongAudienceSmokeToken

Optional info check for `ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN`.

Remediation: set this only when proving audience rejection in
`verify:aws-preview`.

## Automation Notes

- Treat `id` as the stable key.
- Treat `status` as the machine decision.
- Show `hint` to humans and agents as the next action.
- Link `docs` when a tool needs more context.
- Do not parse `message`; it is for display.
