# Four-surface hosted Sync & Mesh test plan

This rehearsal covers the existing Mac (Device A), a second desktop running
the headless daemon (Device B), the web account/dashboard, and the iPhone
companion. Device A already has the user's data and is the trusted device.
Use harmless, clearly named test changes and keep that data intact.

The staging target is:

```text
https://anvil-sync-hosted-staging.still-glitter-7d20.workers.dev
```

The updated Worker must advertise WorkOS Device Authorization with public
client `client_01M2XPX4PF98H2P7HCNRBZATTE`. Never record API keys, service
secrets, device codes, access/refresh tokens, companion tokens, or recovery
codes in test output or this document.

## Gates before touching the devices

This feature is in the uncommitted working tree on
`feature/sync-mesh--foundations`; the remote branch and the already running
Worker do not contain it automatically. The current staging descriptor was
checked before this plan was written and advertises `enrollment-code` and
`oidc-pkce`, but not `workos-device`. Do not call a daemon `sign-in` failure
against that old descriptor a feature result. Use the updated desktop, daemon,
and backend together.

Check the descriptor without printing any secret configuration:

```sh
cd /Users/anthonyhumphreys/Code/anvil
export ANVIL_TEST_BACKEND_URL='https://anvil-sync-hosted-staging.still-glitter-7d20.workers.dev'
curl -fsS "$ANVIL_TEST_BACKEND_URL/.well-known/anvil-backend"
```

The updated JSON must contain `sync/1`, `mesh/1`, `workos-device`, issuer
`https://api.workos.com/user_management`, and the public client above. If
`workos-device` is absent, stop the live Device Authorization portion and use
the enrollment-code compatibility path only.

The local deployment records identify the intended target. Do not copy or dump
their values:

```text
anvil-app/cloud/backend/wrangler.mesh.jsonc
anvil-app/cloud/backend/.wrangler/mesh/anvil-sync-hosted-staging/connection.json
anvil-app/cloud/backend/.wrangler/mesh/anvil-sync-hosted-staging/vars.json
```

### Redeploy the existing staging backend

These commands are for your test run; they have not been executed as part of
this implementation. They use the branch's Anvil Cloud CLI, which invokes
Wrangler internally. Existing secrets and `vars.json` are retained.

```sh
export ANVIL_ROOT='/Users/anthonyhumphreys/Code/anvil'
export CLOUDFLARE_ACCOUNT_ID='715060911f9418f1df0f9de0265d8a64'
export MESH_ORIGIN='https://anvil-sync-hosted-staging.still-glitter-7d20.workers.dev'
export MESH_DIR="$ANVIL_ROOT/anvil-app/cloud/backend/.wrangler/mesh/anvil-sync-hosted-staging"

cd "$ANVIL_ROOT/anvil-cloud"
pnpm install --frozen-lockfile
pnpm --filter '@anvilstack/cloud-cli...' build
cd "$ANVIL_ROOT/anvil-app/cloud/backend"
pnpm install --ignore-workspace --frozen-lockfile

mesh() {
  node "$ANVIL_ROOT/anvil-cloud/packages/cli/dist/index.js" mesh "$@" \
    --backend "$ANVIL_ROOT/anvil-app/cloud/backend" \
    --mode hosted --name anvil-sync-hosted-staging --stage staging \
    --account-id "$CLOUDFLARE_ACCOUNT_ID" --base-url "$MESH_ORIGIN" \
    --bucket anvil-sync-hosted-staging-artifacts \
    --database anvil-sync-hosted-staging-billing \
    --managed-provisioner anvil-sync-hosted-staging-provisioner \
    --vars-file "$MESH_DIR/vars.json" \
    --config-out "$MESH_DIR/wrangler.jsonc" \
    --connection-out "$MESH_DIR/connection.json"
}

test -f "$MESH_DIR/vars.json"
mesh plan --write --json
mesh apply --dry-run --json
mesh provision --json
mesh migrate --json
mesh apply --test-deployment --json
curl -fsS "$MESH_ORIGIN/.well-known/anvil-backend"
```

Run each command only after the previous one succeeds. The final descriptor
must advertise `workos-device`. Keep the existing signed-in Wrangler session;
no new WorkOS client or redirect URI is needed for this device flow. See
[deploy.md](deploy.md) if provisioning or health checks fail.

### Build the exact source snapshot

On Device A, build from `anvil-app/`; the app's `prebuild` handles Electron's
native rebuild:

```sh
cd /Users/anthonyhumphreys/Code/anvil/anvil-app
pnpm install --frozen-lockfile
pnpm run build
pnpm run build:daemon
pnpm run verify:daemon-device-auth
pnpm test
pnpm lint
pnpm --dir mobile typecheck
pnpm --dir mobile lint
```

`verify:daemon-device-auth` is a local in-memory provider/Worker check. It does
not prove the hosted WorkOS app. Build the website separately when testing the
browser:

```sh
cd /Users/anthonyhumphreys/Code/anvil/anvil-website
pnpm install --ignore-scripts --frozen-lockfile
pnpm typecheck
pnpm build
```

Preserve the existing website environment. If another checkout needs one,
start from `.env.example` and fill it from the normal secret store. Keep the
existing names (`WORKOS_*`, `NEXT_PUBLIC_WORKOS_REDIRECT_URI`,
`ANVIL_BACKEND_ORIGIN`, `ANVIL_HOSTED_KEY_ID`,
`ANVIL_HOSTED_SERVICE_SECRET`) without displaying their values.

### Copy uncommitted source to Device B

Do not clone the remote branch. On Device A, make a source-only archive;
`--exclude-standard` omits ignored `.env`, dependencies, build output, and
generated deployment state, while `--deduplicate` avoids repeated paths:

```sh
cd /Users/anthonyhumphreys/Code/anvil
anvil_test_snapshot_dir="$(mktemp -d /tmp/anvil-working-tree.XXXXXX)"
git rev-parse HEAD > "$anvil_test_snapshot_dir/base-commit.txt"
git status --short > "$anvil_test_snapshot_dir/working-tree-status.txt"
git ls-files -co --exclude-standard --deduplicate -z |
  tar --null -czf "$anvil_test_snapshot_dir/anvil-working-tree.tgz" -T -
shasum -a 256 "$anvil_test_snapshot_dir/anvil-working-tree.tgz"
```

Transfer the archive and checksum over an already trusted path; do not copy
`node_modules`, `out`, `dist-daemon`, SQLite files, `.anvil-daemon`, or any
`.env`. On a POSIX or WSL Device B, extract with:

```sh
mkdir -p "$HOME/src/anvil"
tar -xzf "$HOME/anvil-working-tree.tgz" -C "$HOME/src/anvil"
cd "$HOME/src/anvil/anvil-app"
```

On Windows PowerShell, use OpenSSH or the approved file transfer, then:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\src\anvil" | Out-Null
tar -xzf "$env:USERPROFILE\anvil-working-tree.tgz" -C "$env:USERPROFILE\src\anvil"
Set-Location "$env:USERPROFILE\src\anvil\anvil-app"
```

Check `node --version` (must satisfy `>=22.12.0`) and `pnpm --version` (the
repository uses `10.32.1`), then install and rebuild native modules locally:

```sh
pnpm install --frozen-lockfile
pnpm run rebuild:native:node
pnpm run build:daemon
```

The source/build is the same snapshot; native modules are intentionally built
for Device B's OS and Node ABI. The daemon has portable foreground operation:
macOS/Linux may later use the supplied launchd/systemd templates. On
Windows, use WSL for this rehearsal if native dependencies do not build.

## Device A and website setup

Keep this shell open and start the existing desktop data store with the hosted
origin:

```sh
cd /Users/anthonyhumphreys/Code/anvil/anvil-app
ANVIL_HOSTED_BACKEND_URL='https://anvil-sync-hosted-staging.still-glitter-7d20.workers.dev' pnpm dev
```

In **Settings → Sync & Mesh**, select Anvil-hosted, discover and use the
service, then refresh status. Keep an existing signed-in session; enable Sync
only if it is off. Expect connected/live or working polling fallback, the
existing workflow preview, and Hosted access `Preview` (or the deployment's
actual entitlement). Do not reset encrypted data or sign out Device A.

If Device security has never been configured, set up a recovery code and save
it in the password manager. Otherwise keep the current saved code. The default
new-device policy is `require-approval`; changing policy affects future
enrollments only.

Start the local site in another terminal:

```sh
cd /Users/anthonyhumphreys/Code/anvil/anvil-website
pnpm dev
```

In a browser, sign in at `http://localhost:3000/account` and check
`/account`, `/account/devices`, `/account/billing`, `/account/data`, and
`/account/security`. They should show account state without a not-configured
or signed-service error. Use `/account/devices → Connect a device` to mint a
bare, single-use code for each new enrollment; it carries no encryption key.

For the browser dashboard, open `/account/dashboard` in a fresh browser
context. It should remain locked and create a pending request in Device A's
**Browser dashboard access** panel. Deny one request, then approve a new one
with only **Read dashboard** selected. The browser should then show only the
encrypted projection permitted by that scope. Revoke the active browser grant
from Device A and confirm the dashboard locks again. The browser never joins
the mesh or receives an account key.

## Device B: authentication and encryption

Use a distinct `ANVIL_DATA_DIR` for each independent enrollment. This avoids
reusing a session and makes the manual and recovery tests separable.

### Manual mutual SAS

On Device A, select **Require approval** before creating this enrollment.
Only run this against a descriptor that includes `workos-device`. On POSIX:

```sh
cd ~/src/anvil/anvil-app
export ANVIL_DATA_DIR="$HOME/.anvil-daemon-sync-qa-manual"
node dist-daemon/anvil-daemon.mjs sign-in \
  --api-url 'https://anvil-sync-hosted-staging.still-glitter-7d20.workers.dev'
```

On PowerShell, set `$env:ANVIL_DATA_DIR` to the same disposable directory and
run `node .\dist-daemon\anvil-daemon.mjs sign-in --api-url '<backend>'`.
The daemon prints a public verification URL and public user code. Authorise it
in the browser. It must not print the private device code or tokens. Do not
pass `--worker` yet.

Start the host in another terminal with the same data directory:

```sh
node dist-daemon/anvil-daemon.mjs run
```

From a third terminal, capture only non-secret status:

```sh
node dist-daemon/anvil-daemon.mjs status
node dist-daemon/anvil-daemon.mjs security status
node dist-daemon/anvil-daemon.mjs security devices
```

Expect signed-in, sync enabled after `run`, companion running, worker disabled,
and a new pending device. Complete the two-device check while both hosts run:

1. On Device B, run `security verify <device-a-enrollment-id>` and record the
   displayed `NNN-NNN-NNN` SAS.
2. On Device A, open **Devices → Compare & verify** for Device B. The code
   must match. Enter Device B's code and choose **Confirm matching code**.
3. On Device B, approve Device A with the matching code:
   `node dist-daemon/anvil-daemon.mjs security approve <device-a-enrollment-id> --verification-code <NNN-NNN-NNN>`.
4. Recheck both security statuses. Device B should be trusted, have its
   account key after sync, and advance pull timestamps. Change a harmless
   `sync-qa-<date>` template on Device A and confirm the pull reaches B.

The SAS check proves device identity. WorkOS authentication or a website code
does not replace it under `require-approval`.

### Automatic trust with saved recovery

On Device A, choose **Trust authenticated devices automatically**, acknowledge
the warning, and have the saved recovery code ready. Stop Device A and the
manual daemon before signing in and unlocking the fresh Device B state below.
This proves that no trusted device needs to be online:

```sh
export ANVIL_DATA_DIR="$HOME/.anvil-daemon-sync-qa-recovery"
node dist-daemon/anvil-daemon.mjs sign-in \
  --api-url 'https://anvil-sync-hosted-staging.still-glitter-7d20.workers.dev'
node dist-daemon/anvil-daemon.mjs security status
node dist-daemon/anvil-daemon.mjs security unlock --stdin
```

Paste the saved code into stdin (POSIX ends with Ctrl-D; PowerShell with
Ctrl-Z then Enter). Never put it in argv or an environment variable. Expect
`trustSource: automatic-auth`, `trustState: trusted`, and `hasAccountKey: true`.
Keep Device A stopped, run Device B, and confirm existing account state
still pulls and appears through the iPhone companion. Restart Device A
after this check. A wrong or old code must fail without changing the session.

If the old Worker is still in place, exercise only this compatibility path:

```sh
export ANVIL_DATA_DIR="$HOME/.anvil-daemon-sync-qa-code"
node dist-daemon/anvil-daemon.mjs enroll \
  --api-url 'https://anvil-sync-hosted-staging.still-glitter-7d20.workers.dev' \
  --code '<single-use-code>'
```

This proves discovery and code enrollment, not WorkOS Device Authorization or
automatic trust. A website bare code carries no key material.

## Separate Mesh worker opt-in

With a disposable signed-in daemon, keep worker off and run the host. Confirm
`status` reports worker disabled while companion access still works. Dispatch a
harmless remote job from Device A's existing workflow/remote-execution UI; B
must not claim it. Stop `run`, then opt in and restart:

```sh
node dist-daemon/anvil-daemon.mjs worker on
node dist-daemon/anvil-daemon.mjs run
```

Run `node dist-daemon/anvil-daemon.mjs status` in another terminal with the
same `ANVIL_DATA_DIR`.

The worker should become enabled/connected and claim the same bounded test job.
Worker opt-in does not approve the iPhone, deliver encryption keys, or change
companion permissions.

## iPhone companion and network paths

From `anvil-app/`, build the phone from the same snapshot. `--device` selects a
connected iPhone; Xcode signing and camera permission are required:

```sh
pnpm --dir mobile typecheck
pnpm --dir mobile lint
pnpm --dir mobile ios --device
```

### Local LAN pairing

On the Mac (Device A), enable **Settings → Devices & system → Mobile Companion** and
choose **Create QR code**. Put the Mac/host and iPhone on the same trusted,
non-guest Wi-Fi. In iPhone **Settings**, name the phone, choose **Scan QR
Code**, and scan once before the short-lived ticket expires. Expect a Live host,
one Paired hosts row, and readable Home/Approvals/Work data. Local QR bearer
tokens intentionally have legacy full companion access; use account mode for
policy testing.

### Account-connected mode and policy tiers

Mint a fresh bare code on `/account/devices`. In iPhone **Settings → Anvil
account**, enter the exact backend URL and code, tap **Connect account**, then
**Refresh devices**. Presence should show online enrolled hosts and save an
account-mode connection. The first contact creates a pending policy on the
host. Set the tier on Device A's **Account-connected devices** section, or on
headless B:

```sh
node dist-daemon/anvil-daemon.mjs policy list
node dist-daemon/anvil-daemon.mjs policy set <phone-enrollment-id> observe
node dist-daemon/anvil-daemon.mjs policy set <phone-enrollment-id> approve
node dist-daemon/anvil-daemon.mjs policy set <phone-enrollment-id> steer
node dist-daemon/anvil-daemon.mjs policy set <phone-enrollment-id> denied
```

Expected behavior is: `pending` and `denied` reject all account-mode calls;
`observe` permits reads only; `approve` permits reads and approval endpoints;
`steer` permits those plus chat/workflow steering. A denied or lower-tier 403
must not silently fall back to another endpoint. Use **Forget this device** or
`policy forget <phone-enrollment-id>` to prove the next contact is pending.

### Secure LAN/Tailscale route

Never port-forward port `47631`. The companion uses private HTTP addresses;
Tailscale supplies the encrypted private transport. Sign in to the same
tailnet on the host and iPhone. On macOS/Linux, `tailscale ip -4` should show
the host's `100.x.y.z`; on Windows use the Tailscale app.

With Wi-Fi on, verify the host advertises LAN and Tailscale addresses. To prove
Tailscale, leave the iPhone's Tailscale VPN connected, turn off iPhone Wi-Fi,
refresh account devices, and expect the account-mode connection to become Live
through `100.x.y.z:47631`. To produce a QR containing Tailscale, create it
while the host's LAN interface is unavailable so Tailscale is the available
private address. Restore Wi-Fi after the check. For LAN, use the same trusted
Wi-Fi and confirm the QR/base URL is a private address, never loopback or a
public host.

## Expected evidence and bounded troubleshooting

The final evidence should show: Device A's existing data intact; updated
descriptor and public client; manual SAS trust/key delivery; automatic trust
plus local recovery unlock with Device A offline; worker off before `worker on`
and connected afterward; browser scope approval/revocation; local LAN pairing;
Tailscale account-mode access; and each companion tier's expected result.

- **No `workos-device`:** staging is old; use `enroll --code` only until the
  matching backend is deployed.
- **Native load failure:** on the affected machine run
  `pnpm install --frozen-lockfile` and `pnpm run rebuild:native:node`; do not
  copy `node_modules` across machines. Device A's Electron rebuild is handled
  by its app build.
- **Daemon already signed in:** use a disposable `ANVIL_DATA_DIR`; never sign
  out Device A.
- **QR expired/unreachable:** create a new one-use ticket; check the same
  non-guest LAN, private firewall access to TCP `47631`, Tailscale membership,
  and that the daemon is still in `run`.
- **Phone pending/denied or read-only:** inspect the host policy row. Account
  enrollment is not companion authorization; allow up to 60 seconds for the
  documented attestation cache to expire after revocation.
- **Missing encrypted data:** inspect `security status` for trust,
  `hasAccountKey`, and pull timestamps. Manual mode needs matching SAS;
  automatic mode needs the current saved recovery code. Never reset the account
  to repair a test.
- **Website not configured/service-auth error:** inspect only variable names,
  backend origin, and key-id pairing; keep secret values out of logs and let
  the environment owner repair the signed channel.
