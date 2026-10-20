# anvil-worker image

The generic OCI and Cloudflare Sandbox images run the headless Anvil daemon as
an ephemeral Mesh worker and install the runtimes needed by all six managed
cloud providers: Codex, Cursor, Devin, OpenAI, Azure, and LLMGateway. Codex,
OpenAI, Azure, and LLMGateway use the pinned Codex CLI; Cursor and Devin use
their own ACP-capable CLIs. The image build installs no provider credentials
or interactive login state.

## Layout

| File                    | Purpose                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `boot.mjs`              | Validates bootstrap, prepares unattended vault storage, enrolls with a single-use code, then runs under a TTL watchdog |
| `anvil-worker-boot`     | `/bin/sh` entrypoint provisioners invoke (`/opt/anvil/bin/anvil-worker-boot`)                                          |
| `Dockerfile`            | Generic OCI image (Vercel VCR, AWS microVM rootfs base, local dev)                                                     |
| `Dockerfile.cloudflare` | `cloudflare/sandbox:next` variant for the Cloudflare provisioner                                                       |
| `install-codex-cli.sh`  | Installs the pinned Codex CLI version and checks its reported version                                                  |
| `install-cursor-cli.sh` | Installs pinned Cursor Agent CLI for the image architecture and checks its version and ACP help                        |
| `install-devin-cli.sh`  | Installs pinned Devin CLI through its versioned installer and checks its version and ACP help                          |
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
`src/main/services/codex-runtime.service.ts`, Cursor CLI
`2026.09.10-fd3934a`, and Devin CLI `3000.11.3`. Builds check installed
versions and Cursor/Devin ACP command help without authenticating. Cursor
artifacts are pinned by release ID (the vendor installer exposes no checksum
for that package); Devin's versioned installer verifies download checksums
against Cognition's release manifest. The generic image
supports arm64 and the Cloudflare image amd64; both vendors publish Linux
packages for those architectures. Override a pin only when updating
compatibility evidence:

```sh
docker build -f Dockerfile \
  --build-arg CODEX_CLI_VERSION=0.154.0 \
  --build-arg CURSOR_CLI_VERSION=2026.09.10-fd3934a \
  --build-arg DEVIN_CLI_VERSION=3000.11.3 \
  -t anvil-worker .
```

For Cloudflare, the wrangler `containers[].image` in `cloud/provisioner`
points at `Dockerfile.cloudflare`. Run `./prepare.sh` before
`anvil-cloud mesh provisioner apply`; its `--dry-run` also builds the image.
Both image variants install Python, make, and g++ so npm can compile
`better-sqlite3` and `node-pty` when a matching prebuilt native module is not
available. Their runtime dependencies are declared in `package.json`; generic
OCI also installs Git for repository checkouts, while Cloudflare inherits Git
availability from its base image. Curl and CA certificates support CLI
downloads. See the [deployment runbook](../../../docs/runbooks/hosted-sync/deploy.md)
for hosted and self-hosted branch-testing commands.

## Agent CLI installation

Codex is installed from the official npm package at the app's managed runtime
pin and handles Codex, OpenAI, Azure, and LLMGateway provider selections. It
uses an encrypted account-auth cache copied from the launching host by default,
or an optional explicitly granted API key. The image contains no login state.
A host-cache grant is written to a private, session-scoped Codex home; subsequent
turns preserve the worker's refreshed credentials and native session files.
The source cache is never overwritten. A missing host cache fails launch early;
Codex device-code sign-in on the worker remains an explicit fallback. Cursor
Agent and Devin CLI are installed at their own pins and provide the
`cursor-agent` and `devin` ACP executables used by the desktop runtime. Their
CLI presence does not include login state or API keys; the worker must receive
credentials through the existing provider-specific credential flow. Cursor
and Devin ACP help is checked during image build, without starting an ACP
session that may require account access. All vendor package downloads require
build-time network access. The image still needs a successful build in the
target environment before a release can claim image-execution validation.

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
- Runs `anvil-daemon enroll-environment --api-url <backendUrl> --code <enrollmentCode> --worker`.
- The command is a bootstrap route, not an authorization flag: the backend binds
  the single-use code to an ephemeral environment, and the daemon rejects a
  response unless its enrolled class is `ephemeral`.
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
