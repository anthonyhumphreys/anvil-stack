# anvil-worker image

The container image every cloud agent environment boots. It runs the headless
Anvil daemon (`dist-daemon/anvil-daemon.mjs`) as an **ephemeral Mesh worker** —
there is no second execution protocol; the image enrolls, connects, advertises
capabilities, and claims jobs exactly like a desktop daemon.

## Layout

| File | Purpose |
| --- | --- |
| `boot.mjs` | Bootstrap driver: parse payload → enroll `--pair` → `run` under a TTL watchdog |
| `anvil-worker-boot` | `/bin/sh` entrypoint provisioners invoke (`/opt/anvil/bin/anvil-worker-boot`) |
| `Dockerfile` | Generic OCI image (Vercel VCR, AWS microVM rootfs base, local dev) |
| `Dockerfile.cloudflare` | `cloudflare/sandbox:next`-based variant for the CF provisioner |
| `package.json` | Daemon externals (`better-sqlite3`, `node-pty`) — keep versions in step with `anvil-app/package.json` |
| `prepare.sh` | Copies `dist-daemon/anvil-daemon.mjs` into the build context |

## Build

```sh
cd anvil-app
pnpm build:daemon                 # produces dist-daemon/anvil-daemon.mjs
cd cloud/images/anvil-worker
./prepare.sh                      # stages the bundle into the context
docker build -f Dockerfile -t anvil-worker .
```

For Cloudflare, the wrangler `containers[].image` in `cloud/provisioner`
points at `Dockerfile.cloudflare`; run `./prepare.sh` before
`wrangler deploy` / `wrangler containers build`.

## Bootstrap contract

Provisioners deliver a JSON document to the boot script, first channel wins:

1. `argv[2]` — raw JSON (AWS run-hook / generic argv injection)
2. `$ANVIL_BOOTSTRAP_JSON` — env var (Vercel `env`, Cloudflare `exec` env)
3. `$ANVIL_BOOTSTRAP_FILE` — path to a JSON file
4. `/run/anvil/bootstrap.json` — conventional mount point

```json
{
  "kind": "anvil.mesh-environment",
  "schemaVersion": "0.1",
  "environmentId": "env_…",
  "provider": "cloudflare-sandbox",
  "backendUrl": "https://sync.anvil.dev",
  "pairing": "anvil-pair-…",
  "ttlSeconds": 1800,
  "networkPolicy": { "allowOutbound": ["*"] }
}
```

`pairing` is the consume-once `anvil-pair-…` enrollment payload minted by the
user's source device (BYO) or staged via `environment.bootstrap` (managed).
Prefer the env/file channels over argv — argv is visible in process listings.

## Runtime behavior

- Writes `{worker: true, companion: false}` to `$ANVIL_DATA_DIR/daemon.json`
  (default `/var/lib/anvil`) — environments never run the companion server.
- `anvil-daemon enroll --api-url <backendUrl> --pair <pairing> --worker`
- `anvil-daemon run` with `ANVIL_ENVIRONMENT_ID` / `ANVIL_ENVIRONMENT_PROVIDER`
  set — the worker service reads these to advertise the `ephemeral-env`
  capability and self-report `environment.report` `enrolled` on connect.
- TTL watchdog: SIGTERM at `ttlSeconds`, SIGKILL 60s later; exits 0 on expiry.
- On container replacement (Cloudflare) the provisioner re-invokes boot with
  the same bootstrap document — enrollment codes are single-use, so a fresh
  payload is staged per attempt by the backend's internal claimer.

## Per-provider notes

- **AWS (`aws-lambda-microvm`)** — bake this image (or its rootfs) into the
  microVM image referenced by `ANVIL_AWS_AGENT_SANDBOX_IMAGE`; the run hook
  delivers the bootstrap JSON as argv.
- **Cloudflare (`cloudflare-sandbox`)** — built by wrangler from
  `Dockerfile.cloudflare`; the provisioner worker `exec`s the entrypoint with
  `ANVIL_BOOTSTRAP_JSON` in env. Keep `Dockerfile.cloudflare`'s base tag on the
  same `@cloudflare/sandbox@next` line as the provisioner package.
- **Vercel (`vercel-sandbox`)** — `imageRef` points at this image pushed to a
  registry Vercel can pull; the adapter runs the entrypoint with the bootstrap
  JSON in env.
- **Anvil-managed (`anvil-managed`)** — same Cloudflare image, bootstrapped by
  the hosted provisioner behind the backend's `MANAGED_PROVISIONER` binding.
