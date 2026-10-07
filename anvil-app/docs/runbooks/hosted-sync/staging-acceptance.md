# Hosted Sync and Mesh staging acceptance

Use this after the backend and current desktop candidate are deployed. The
deployment sequence starts in [staging-next-steps.md](staging-next-steps.md);
this file defines the live acceptance gates. Sync and Mesh are free. Anvil
Cloud Agents are a separate future paid feature and stay off by default.

## Record the candidate

Use one clean candidate commit for the backend, desktop, daemon, website, and
any optional clients. Record the full commit SHA, desktop artifact, website
preview and commit, Worker version, and applied D1 migrations. A local dirty
tree or an older client is not the candidate. Do not place secrets, tokens,
device codes, private user data, or full logs in the record.

Record the results in the current [ANV-11 acceptance ticket](https://linear.app/anvil-stack/issue/ANV-11/run-hosted-sync-staging-acceptance-for-pr-91).

Run every live test with a disposable staging account and fresh test data.
A dedicated test account can be reused after an encrypted-data reset and
verification of its fresh generation. Do not use production credentials or
valuable data. Record each gate as `PASS`, `FAIL`, or `BLOCKED`, with a short result and
the blocker where applicable. A skipped test, local mock, or successful
deployment is not a pass.

## Deployed backend and identity

Before signing in, fetch the selected staging backend's
`/.well-known/anvil-backend` descriptor. It must identify the current
`anvil-backend/1` protocol and advertise both `sync/2` and `mesh/2`. The
staging identity flow must advertise `workos-device` and the staging public
client. Stop and mark this gate `BLOCKED` if the descriptor is stale or any
required field is missing. Do not test through an older protocol profile.

Sign in to the staging website and both devices with the same disposable user.
The account and device pages must load without configuration or service errors.
Both physical devices must appear under that website account as active. Two
local profiles on one computer do not satisfy the device gate.

## Device setup acceptance

Use the exact current candidate on both devices and its matching staging backend.
Record each path separately:

- First-run role → agent → Sync, including the visible local-only completion path.
- One hosted sign-in action, cancellation/retry, and blocked changed-service identity.
- On Linux without an OS keyring, create an encrypted vault directly in onboarding
  and continue sign-in. A mismatched confirmation stays on the form with a useful
  error. Restart and unlock the same vault without another enrollment or new
  account key. A wrong passphrase leaves saved credentials intact.
- Cancel browser sign-in and continue without Sync. A late callback must not sign
  the device in after cancellation.
- API-key setup uses the same storage prompt. A failed save keeps entered values
  and does not proceed to testing or the next step. Working OS keychain and CLI
  agent paths require no extra storage setup.
- First-device automatic connection by default, optional stricter verification,
  once-only recovery-code acknowledgement,
  explicit Sync adoption, and a new workspace remaining Local by default.
- A second same-account device connects automatically while a trusted device is online;
  it waits clearly when all trusted devices are offline, then connects when one returns.
  Before its user enables Sync, only its own device identity may be published.
- Desktop and daemon use WorkOS sign-in. Hosted account pages and advanced desktop
  settings offer no enrollment, pairing or existing-install link codes; the backend
  rejects durable code issuance and redemption, including previously issued codes.
- Code-verification mode shows the same device code on both ends. The daemon's browser
  sign-in code is clearly distinguished from that device code. Confirm the match
  on both devices. Recovery works without a peer.
- Revocation blocks delivery and retained public identities cannot restore access.
- Authentication, device connection and Sync do not enable worker execution. Opt in
  separately before a harmless Mesh job.

WorkOS sign-in alone is not device-trust acceptance. Do not store verification
or recovery codes, tokens, or keys with acceptance evidence.

## Workspace behavior

Create a workspace while signed in. It must default to **Local**. The user
must opt in to Sync explicitly; account sign-in must not adopt a local
workspace by itself.

On a second machine, check out or map the same repository separately. Confirm
Sync carries only portable workspace definitions, preferences, and bootstrap
settings. It must not copy repository bytes, Git history, or uncommitted
changes. Make one harmless portable setting change and confirm it appears on
the second machine without moving a source file or dirty change. Turn Sync off
and confirm both local workspaces and their repository checkouts remain.

## Two-device Sync and Mesh

Connect Device A and Device B over separate WANs using the same disposable
account and the exact candidate build. Sync a harmless, clearly named setting
from A to B, then make a separate change on B and confirm it reaches A.

Keep B's Mesh worker off while verifying Sync, then enable the worker
explicitly from its settings or daemon command and confirm its status. Worker
opt-in is separate from device trust and Sync.

On B, explicitly set the maximum permission mode to read-only. Submit a job
from A that requests a mutation and confirm it cannot write. Change B's
maximum to `on-request` for the approval check. Submit a harmless Mesh job
that requests a mutation. It must pause for approval and show the exact
requested action. Deny it and confirm no mutation occurred. Submit a second
job, approve it once, and confirm the expected result appears once. Keep
full-access mode off.

Disconnect or restart the client around a completed request, reconnect from
its last cursor, and confirm the request or result is not duplicated. A
timeout or lost response leaves that mutation's outcome uncertain. Show that
state to the user and do not retry automatically or submit a replacement job.
Only continue after checking the result or obtaining explicit user direction.

Revoke B from the staging account's device page. Within 60 seconds, B must
lose hosted access while its local data remains available. Enroll it again
with a fresh authorization and confirm Sync reconnects without duplicating
the earlier setting change or Mesh job.

The required physical gate passes only when both hosts used separate WANs,
Sync worked in both directions, approval and denial behaved as described,
reconnect did not duplicate work, and revocation took effect within 60
seconds. If either host or a separate WAN is unavailable, mark the gate
`BLOCKED`.

## Recovery

Before closing out the disposable account, also exercise recovery. Enroll a
fresh isolated profile using the supported device trust or recovery flow.
Confirm it reconstructs the opted-in workspace definition and latest portable
change without copying a checkout. Confirm a deleted portable item stays
deleted and a workspace opted out on the source remains local. Reconnect the
existing device with one pending portable change and check that recovery does
not discard it or apply it twice. Record any available snapshot restore and
export/import results separately; an unrun recovery flow is `BLOCKED`.

## Managed host connections

The current staging preview enables host sessions and managed HTTPS tunnels.
Record allocation, real ingress, anonymous session refusal, restart, reconnect,
revocation and DNS/tunnel cleanup. A single-host transport smoke provides early
evidence but does not pass app session authentication or physical separate-WAN
acceptance. Setup is described in [deploy.md](deploy.md) and
[host-connections.md](host-connections.md).

## Optional checks

Record optional checks separately. They do not substitute for a required
physical gate.

- **Browser dashboard:** use a fresh browser profile, request access, deny
  once, then approve read-only access. Reload the same tab, revoke the grant,
  and confirm the dashboard locks. A fresh read-only grant must reconnect
  without restoring the revoked grant.
- **Private-route discovery:** check that reachable private routes are
  preferred when available.
- **Mobile companion and Raycast:** use builds from the same candidate SHA.
  Record platform and build identity. Mobile native WebSocket stacks may
  assemble a frame before JavaScript can reject it; controlled staging
  results do not prove a native pre-assembly limit.

## Close out

Record a result for every required gate. A missing account, current build,
staging access, physical host, or separate WAN is `BLOCKED`; an observed
incorrect result is `FAIL`. Do not call staging accepted while any required
gate is failed or blocked. Keep the disposable account and its data until the
acceptance record is complete, then delete the account through the staging
account flow and confirm its hosted data is gone. Deleting the test account
does not erase either machine's local workspace or repository checkout.
