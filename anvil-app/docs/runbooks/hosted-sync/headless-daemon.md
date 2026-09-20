# Headless daemon (DAEMON-01)

Runs Anvil's host services — sync runtime, mesh worker, companion server — as a plain Node process on an always-on machine. No Electron, no renderer, no IPC.

For a coordinated desktop, daemon, dashboard, and iPhone rehearsal, follow the
[four-device test plan](four-device-test-plan.md).

## Build

```sh
cd anvil-app
pnpm install            # daemon needs better-sqlite3 (native) at runtime
pnpm run build:daemon   # → dist-daemon/anvil-daemon.mjs
```

Run the local device-auth integration check before trusting a backend rollout:

```sh
pnpm run verify:daemon-device-auth
```

It uses an in-memory WorkOS-compatible provider and Worker, so it does not
send credentials or requests to the network.

If this checkout most recently built or ran Electron, run
`pnpm run rebuild:native:node` before starting the daemon. Desktop `pnpm dev`
and `pnpm build` rebuild native modules for Electron again.

The bundle stubs `electron` out entirely (`src/daemon/electron-stub.ts`): `app.getPath` resolves under the data dir, `safeStorage` becomes AES-256-GCM over a `0600` master-key file, UI surfaces are inert.

## Sign in

The hosted daemon uses WorkOS Device Authorization. It does not open a browser
and it does not bind a loopback callback; use any browser-capable device to
visit the verification URI printed by the command.

Before using this flow, the backend descriptor must advertise
`workos-device`, and its WorkOS AuthKit application must be a public client.
The descriptor's `auth.publicClientId` is the WorkOS public client ID. Do not
configure a client secret or WorkOS API key on the daemon. Device Authorization
must be enabled for the client; it does not need a redirect URI. See the
[WorkOS CLI Auth flow](https://workos.com/docs/authkit/cli-auth) for the
provider-side setup and polling contract.

```sh
export ANVIL_DATA_DIR=~/.anvil-daemon   # optional; this is the default
node dist-daemon/anvil-daemon.mjs sign-in --api-url https://<backend>
```

The command discovers and pins the backend, prints the public verification URI
and user code, and waits for authorization for the bounded provider lifetime.
It never prints the private device code, access token, or refresh token. Press
Ctrl-C to cancel; the command exits with status `130` and never clears saved
session state. A daemon with an existing session must be signed out before
starting a new sign-in.

Pass `--worker` only when this host should opt into Mesh execution:

```sh
node dist-daemon/anvil-daemon.mjs sign-in --api-url https://<backend> --worker
```

The worker choice is device-local and independent of authentication. Without
the flag, sign-in does not grant worker permission. The successful sign-in
command returns to the shell; start the long-running services with `run`.

After authorization, an existing trusted device may still need to approve this
enrollment. The one-shot sign-in publishes the daemon identity before it
returns, so both devices can complete the manual two-device check from their
shells. Run `security verify <enrollmentId>` on both devices and compare the
same `NNN-NNN-NNN` code. Then approve in both directions:

```sh
# Existing trusted device: authorize the new enrollment and wrap the account key.
anvil-daemon security devices
anvil-daemon security verify <new-enrollment-id>
anvil-daemon security approve <new-enrollment-id> --verification-code <NNN-NNN-NNN>

# New daemon: verify and locally accept the authenticated wrap from the old device.
anvil-daemon security devices
anvil-daemon security verify <old-enrollment-id>
anvil-daemon security approve <old-enrollment-id> --verification-code <NNN-NNN-NNN>
```

Both approvals are required: the existing device authorizes the enrollment and
sends the authenticated key wrap, while the new daemon verifies the sender and
accepts that wrap locally. Desktop **Compare & verify** performs the same
two-ended confirmation. If the account uses encrypted recovery instead, unlock
it separately with `anvil-daemon security unlock --stdin`; configure a new
recovery envelope with `anvil-daemon security setup`.

## Enrollment-code bootstrap

Enrollment codes are minted on the website (`/account/devices` → Connect a device) or any signed-in desktop:

```sh
export ANVIL_DATA_DIR=~/.anvil-daemon   # optional; this is the default
node dist-daemon/anvil-daemon.mjs enroll --api-url https://<backend> --code <CODE>
```

This discovers `<base>/.well-known/anvil-backend`, pins the backend, redeems the
code, enables sync, and stores the device session. Add `--worker` to also opt
the host in as a mesh worker. This remains the bootstrap path for compatible
self-hosted backends that do not advertise `workos-device`.

## Run

```sh
node dist-daemon/anvil-daemon.mjs run
```

Starts the live sync socket, companion server (`:47631` by default — same settings store as desktop), and endpoint advertisement (Tailscale → LAN → loopback). Reference service templates: `daemon/com.anvil.daemon.plist` (launchd) and `daemon/anvil-daemon.service` (systemd user unit).

## Operate

```sh
anvil-daemon status                              # runtime + worker + auth snapshot
anvil-daemon security status                     # trust, policy, key, and recovery metadata
anvil-daemon security devices                    # enrolled device roster
anvil-daemon security verify <enrollmentId>      # print the 9-digit SAS
anvil-daemon security approve <enrollmentId> --verification-code <NNN-NNN-NNN>
anvil-daemon security setup                      # configure recovery; prints the new code once
anvil-daemon security setup --policy auto-trust-authenticated
anvil-daemon security unlock --stdin             # read the saved recovery code from stdin
anvil-daemon security unlock --file <path>       # read an owner-only (0600) code file
anvil-daemon security policy require-approval    # change future-device trust policy
anvil-daemon security recovery-replace           # rotate recovery; prints the new code once
anvil-daemon policy list                         # per-enrollment tiers seen by this host
anvil-daemon policy set <enrollmentId> observe   # grant a tier (device must have contacted first)
anvil-daemon policy forget <enrollmentId>        # next contact re-pends
anvil-daemon policy default-tier observe         # auto-grant tier for first-seen enrollments
anvil-daemon worker on|off
anvil-daemon companion on|off
anvil-daemon sign-out
```

`security setup` defaults to `require-approval`, and the policy command only
changes how future authenticated device enrollments are trusted. Existing
trusted, pending, and revoked memberships are not rewritten by a policy
change. A new device still signs in first and then unlocks its encrypted
account data with the separately saved recovery code; WorkOS authentication
alone never decrypts account content. A recovery code is accepted only through
stdin or a regular owner-only file, so do not put it in a command argument or
environment variable. Setup and replacement print the new code once on
stdout; save it before the command exits.

Device trust does not enable the mesh worker or grant companion observe,
approve, or steer permissions. The enrollment-code command still enables sync
and the companion server immediately. WorkOS `sign-in` stores authentication
and returns to the shell; `run` enables sync and starts the companion server,
while `--worker` or the saved worker setting is required to opt this host into
mesh execution.

The destructive encrypted-account reset is deliberately not a daemon command.
Use the desktop/account security flow with its exact confirmation and account
identity guard; it preserves hosted billing continuity while discarding the
encrypted data generation. Full account deletion follows the separate
[account-deletion runbook](account-deletion.md).

## Security notes

- The data dir (`~/.anvil-daemon`) holds the device session and `.daemon-key` master key, both `0600`. Treat it like `~/.ssh` — possession is authority. Backups of the dir clone the enrollment; revoking the device on the web dashboard kills it.
- `default-tier` is a real grant, not a convenience: `observe` exposes workspace/session reads to every enrollment on the account. `steer` should essentially never be a default.
- Job kinds needing provider CLIs (codex etc.) only work if installed on the host — capability reporting reflects what exists.
- Revocation propagates on the same paths as desktop: session kill at the backend, attestation cache expiry (≤60s) on direct companion connections.
- Replacing recovery replaces the current envelope and advances the account
  security revision. New-device recovery must use the newly printed code and
  current envelope; an old cached bundle, if retained with its old code, can
  only open the historical key versions it contains.
