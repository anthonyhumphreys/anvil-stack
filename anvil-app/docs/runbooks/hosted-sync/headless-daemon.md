# Headless daemon (DAEMON-01)

Runs Anvil's host services — sync runtime, mesh worker, companion server — as a plain Node process on an always-on machine. No Electron, no renderer, no IPC.

## Build

```sh
cd anvil-app
pnpm install            # daemon needs better-sqlite3 (native) at runtime
pnpm run build:daemon   # → dist-daemon/anvil-daemon.mjs
```

The bundle stubs `electron` out entirely (`src/daemon/electron-stub.ts`): `app.getPath` resolves under the data dir, `safeStorage` becomes AES-256-GCM over a `0600` master-key file, UI surfaces are inert.

## Enroll

Enrollment codes are minted on the website (`/account/devices` → Connect a device) or any signed-in desktop:

```sh
export ANVIL_DATA_DIR=~/.anvil-daemon   # optional; this is the default
node dist-daemon/anvil-daemon.mjs enroll --api-url https://<backend> --code <CODE>
```

This discovers `<base>/.well-known/anvil-backend`, pins the backend, redeems the code, enables sync, and stores the device session. Add `--worker` to also opt the host in as a mesh worker.

## Run

```sh
node dist-daemon/anvil-daemon.mjs run
```

Starts the live sync socket, companion server (`:47631` by default — same settings store as desktop), and endpoint advertisement (Tailscale → LAN → loopback). Reference service templates: `daemon/com.anvil.daemon.plist` (launchd) and `daemon/anvil-daemon.service` (systemd user unit).

## Operate

```sh
anvil-daemon status                              # runtime + worker + auth snapshot
anvil-daemon policy list                         # per-enrollment tiers seen by this host
anvil-daemon policy set <enrollmentId> observe   # grant a tier (device must have contacted first)
anvil-daemon policy forget <enrollmentId>        # next contact re-pends
anvil-daemon policy default-tier observe         # auto-grant tier for first-seen enrollments
anvil-daemon worker on|off
anvil-daemon companion on|off
anvil-daemon sign-out
```

## Security notes

- The data dir (`~/.anvil-daemon`) holds the device session and `.daemon-key` master key, both `0600`. Treat it like `~/.ssh` — possession is authority. Backups of the dir clone the enrollment; revoking the device on the web dashboard kills it.
- `default-tier` is a real grant, not a convenience: `observe` exposes workspace/session reads to every enrollment on the account. `steer` should essentially never be a default.
- Job kinds needing provider CLIs (codex etc.) only work if installed on the host — capability reporting reflects what exists.
- Revocation propagates on the same paths as desktop: session kill at the backend, attestation cache expiry (≤60s) on direct companion connections.
