# anvil-worker image

The generic OCI and Cloudflare Sandbox images run the headless Anvil daemon as
an ephemeral Mesh worker and install the managed Codex CLI. Managed cloud
environments currently support Codex-backed runs. Cursor, Devin, OpenAI,
Azure, and LLMGateway remain available on enrolled desktops and BYO
environments where their provider CLI or credentials have been configured.
The image build installs no provider credentials or interactive login state.

## Layout

| File                    | Purpose                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `boot.mjs`              | Validates bootstrap, prepares unattended vault storage, enrolls with a single-use code, then runs under a TTL watchdog |
| `anvil-worker-boot`     | `/bin/sh` entrypoint provisioners invoke (`/opt/anvil/bin/anvil-worker-boot`)                                          |
| `Dockerfile`            | Generic OCI image (Vercel VCR, AWS microVM rootfs base, local dev)                                                     |
| `Dockerfile.cloudflare` | `cloudflare/sandbox:next` variant for the Cloudflare provisioner                                                       |
| `install-codex-cli.sh`  | Installs the pinned Codex CLI version and checks its reported version                                                  |
| `package.json`          | Daemon externals (`better-sqlite3`, `node-pty`) — keep versions in step with `anvil-app/package.json`                  |
| `prepare.sh`            | Copies `dist-daemon/anvil-daemon.mjs` into the build context                                                           |

## Build

```sh
cd anvil-app
pnpm build:daemon                 # produces dist-daemon/anvil-daemon.mjs
cd cloud/images/anvil-worker
./prepare.sh                      # stages the bundle into the context
docker build -f Dockerfile -t anvil-worker .
```

The image pins Codex CLI `0.154.0` to the version managed by
`src/main/services/codex-runtime.service.ts`. The build checks the installed
version and fails on a mismatch. Override the pin with a Docker build argument
only when updating the corresponding compatibility evidence:

```sh
docker build -f Dockerfile \
  --build-arg CODEX_CLI_VERSION=0.154.0 \
  -t anvil-worker .
```

For Cloudflare, the wrangler `containers[].image` in `cloud/provisioner`
points at `Dockerfile.cloudflare`. Run `./prepare.sh` before
`anvil-cloud mesh provisioner apply`; its `--dry-run` also builds the image.
Both image variants install Python and C++ build tools for native daemon
dependencies. See the [deployment runbook](../../../docs/runbooks/hosted-sync/deploy.md)
for hosted and self-hosted branch-testing commands.

## Agent CLI installation

Codex is installed from the official npm package at the app's managed runtime
pin. It is the only runner supported by managed cloud environments and uses an
encrypted account-auth cache copied from the launching host by default,
or an optional explicitly granted API key. The image contains no login state.
A host-cache grant is written to a private, session-scoped Codex home; subsequent
turns preserve the worker's refreshed credentials and native session files.
The source cache is never overwritten. A missing host cache fails launch early;
Codex device-code sign-in on the worker remains an explicit fallback. Cursor, Devin, OpenAI,
Azure, and LLMGateway remain available on enrolled desktops and BYO
environments with the required provider setup. Cursor and Devin CLIs are
deliberately absent from managed images. The Codex package download requires
network access during the image build. The image itself still needs a
successful build in the target build environment before a release can claim
image-execution validation.

## Bootstrap contract

Provisioners deliver a JSON document to the boot script, first channel wins:

1. `argv[2]` — raw JSON (AWS run-hook / generic argv injection)
2. `$ANVIL_BOOTSTRAP_JSON` — env var (Vercel env, Cloudflare exec env)
3. `$ANVIL_BOOTSTRAP_FILE` — path to a JSON file
4. `/run/anvil/bootstrap.json` — conventional mount point

```json
{
  "kind": "anvil.mesh-environment",
  "schemaVersion": "0.2",
  "environmentId": "env_…",
  "provider": "cloudflare-sandbox",
  "backendUrl": "https://sync.anvil.dev",
  "enrollmentCode": "anvil-ec-…",
  "ttlSeconds": 1800,
  "networkPolicy": { "allowOutbound": ["*"] }
}
```

`enrollmentCode` is authentication-only and single-use. Account key material
must never travel through bootstrap; task content keys arrive through wrapped
task keys after claim. Prefer env or file channels over argv, which is visible
in process listings.

Before enrolling, boot configures a key-file vault at
`$ANVIL_VAULT_KEY_FILE` (default `/run/anvil/vault/worker.key`) outside
`$ANVIL_DATA_DIR` (default `/var/lib/anvil`). The key file is created with
owner-only permissions. If storage is already configured, boot requires the
original vault key to be available and refuses enrollment when storage is
locked, invalid, or unavailable. It does not regenerate a missing key.

The source sends the selected portable workspace definition and handoff
checkpoint through the encrypted task envelope. The worker receives no account-wide
sync key. Repository cloning still requires destination access; private Git
credentials are not automatically transferred.

## Runtime behavior

- Writes `{worker: true, companion: false}` to `$ANVIL_DATA_DIR/daemon.json` —
  environments never run the companion server.
- Runs `anvil-daemon enroll --api-url <backendUrl> --code <enrollmentCode> --worker`.
- Runs `anvil-daemon run` with `ANVIL_ENVIRONMENT_ID` and
  `ANVIL_ENVIRONMENT_PROVIDER` set, advertising `ephemeral-env` and reporting
  environment enrollment on connect.
- Stops at `ttlSeconds`: SIGTERM first, then SIGKILL after 60 seconds; expiry
  exits 0.
- On Cloudflare container replacement, the provisioner obtains a fresh
  single-use enrollment code for the replacement attempt.

## Per-provider notes

- **AWS (`aws-lambda-microvm`)** — bake this image (or its rootfs) into the
  microVM image referenced by `ANVIL_AWS_AGENT_SANDBOX_IMAGE`; the run hook
  delivers bootstrap JSON as argv.
- **Cloudflare (`cloudflare-sandbox`)** — built by wrangler from
  `Dockerfile.cloudflare`; the provisioner worker `exec`s the entrypoint with
  `ANVIL_BOOTSTRAP_JSON` in env. Keep the base tag aligned with the
  `@cloudflare/sandbox@next` package line.
- **Vercel (`vercel-sandbox`)** — `imageRef` points at this image in a registry
  Vercel can pull; the adapter runs the entrypoint with bootstrap JSON in env.
- **Anvil-managed (`anvil-managed`)** — uses the Cloudflare image through the
  hosted provisioner behind the backend's `MANAGED_PROVISIONER` binding.
