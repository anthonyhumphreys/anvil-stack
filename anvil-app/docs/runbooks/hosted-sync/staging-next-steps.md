# Stage Sync and Mesh

Start here for PR91. The [decision record](../../plans/sync-mesh/decisions.md)
defines the product and architecture. The [implementation review](../../plans/sync-mesh/host-local-implementation-review.md)
records the local checks, security fixes and remaining limits.

## 1. Check the candidate

From this checkout:

```sh
cd /Users/anthonyhumphreys/Code/anvil/anvil-app
pnpm staging:status
```

This command reads GitHub and the public staging descriptor. It does not deploy,
change credentials or sign in. It distinguishes checks on an older PR head from
checks on your current commit. A matching descriptor establishes protocol
compatibility; the successful staging workflow establishes the candidate deployed.
Neither establishes signed-in or physical-device acceptance.

The core staging target uses existing Worker, D1 and R2 resources. Sync and Mesh
are free, checkout is disabled, and Anvil Cloud Agents are disabled. It deploys
no Cloud Agent provisioner or container image. The current rehearsal includes
managed host endpoints. Private routes are preferred where reachable; a managed
HTTPS tunnel provides reachability across separate networks.

Before enabling the Worker, save `ANVIL_MESH_MANAGED_ENDPOINTS=true` and
`MACHINE_ENDPOINT_DOMAIN=anvilstack.dev` in the protected staging configuration,
and install the three tunnel secrets described in [deploy.md](deploy.md).
`pnpm staging:status` treats those secrets and the managed setting as required
for this rehearsal. It checks secret names and domain syntax, not token
permissions or live connectivity.

## 2. Deploy and obtain the desktop preview

The agent can complete these steps with the existing GitHub staging access.
Pushing `feature/sync-mesh--foundations` automatically deploys the backend and
starts PR checks and the website preview. For a later candidate:

```sh
cd /Users/anthonyhumphreys/Code/anvil
git status --short
git push origin feature/sync-mesh--foundations
gh pr checks 91 --repo anthonyhumphreys/anvil-stack
```

Wait for the backend workflow and PR checks to pass for that exact commit.
Do not treat earlier green checks as acceptance of a new candidate.
Then build the isolated macOS arm64 preview:

```sh
anvil_candidate_sha="$(git rev-parse HEAD)"
gh workflow run app-candidate-preview.yml \
  --repo anthonyhumphreys/anvil-stack \
  --ref feature/sync-mesh--foundations \
  -f pull_request=91 -f head_sha="$anvil_candidate_sha"
```

The [candidate workflow](https://github.com/anthonyhumphreys/anvil-stack/actions/workflows/app-candidate-preview.yml)
retains a DMG, ZIP and checksum manifest for 14 days. Use the artifact from the
matching SHA. The preview has separate application data, embeds both host
connection flags, targets staging, and has no update publishing. No tester
flag setup is required.
It is unsigned; macOS installation acceptance remains part of the rehearsal.

Use the [backend workflow](https://github.com/anthonyhumphreys/anvil-stack/actions/workflows/sync-backend-staging.yml)
to inspect deployment progress. Automatic pushes preserve the saved staging
managed endpoint setting; they do not silently disable it.
The website preview is linked from [PR91](https://github.com/anthonyhumphreys/anvil-stack/pull/91).
Confirm its commit and staging account environment before signing in.
The staging WorkOS callback returns to `staging.anvilstack.dev`. For this
rehearsal, pin that staging hostname to the verified candidate website deployment
so sign-in returns to the same build. Record the previous deployment for restoring
the alias. A later `develop` deployment may replace that pin; recheck the website
SHA before continuing. Leave production hostnames untouched.

## 3. Anth's physical-device rehearsal

Use one disposable staging account and two physical machines. The candidate
preview provides an isolated desktop profile. Give a daemon its own protected
`ANVIL_DATA_DIR`; keep your everyday profile and repositories out of this test.
Use a disposable repository for commands that write files.

Follow [staging acceptance](staging-acceptance.md) in order. The required results are:

- [ ] Website and both machines sign in to the same personal account without a
      purchase or organization.
- [ ] A new workspace starts Local. Opting it into Sync transfers its portable
      definition and preferences. The other machine links or clones its own
      checkout; repository files, Git history and uncommitted changes are not
      uploaded by workspace Sync. Opt-out leaves local work intact.
- [ ] Device trust and host access approval are understandable. A device becomes
      a Mesh worker only after its separate opt-in.
- [ ] A harmless job completes on the second machine. Approval, denial,
      cancellation and the worker's maximum permission mode behave as shown.
- [ ] With a trusted `cloudflared` installation on each test host, confirm
      managed allocation and first connection. Test host sessions across
      separate WANs, disconnect, sleep/resume and reconnect without duplicate
      commands or silently lost output. A separate private network is not
      required for the managed route. Daemons still need the flags described
      in [host connections](host-connections.md).
- [ ] Revoking a device closes its access within the documented maximum
      60-second trust window; a fresh enrollment reconnects.
- [ ] Restore and deletion work on the disposable account. Record any failed or
      unavailable gate as FAIL or BLOCKED, with its cause.

Record the candidate SHA, backend run/version, website URL, artifact checksum and
results. [ANV-11](https://linear.app/anvil-stack/issue/ANV-11/run-hosted-sync-staging-acceptance-for-pr-91)
is the existing acceptance ticket. Store no recovery codes, tokens or secret
values in the record. The [four-surface checks](four-device-test-plan.md) cover
browser, mobile and Raycast tests when those clients are included in the pilot.

## 4. Managed endpoint evidence and cleanup

This is host reachability, separate from Anvil Cloud Agents. It needs an
operator-controlled domain, three protected staging tunnel secrets and a trusted
`cloudflared` executable on each test host. The selected account owns
`anvilstack.dev`. Allocated hosts use a single subdomain beneath it, so this
setup does not need a deeper wildcard certificate.

Prepare the [managed setup and acceptance](host-connections.md#managed-endpoint-setup),
then deploy the candidate with the saved staging rollout flag. The optional
`managed_endpoint_pilot=true` dispatch can enable a single run, but does not
persist that choice. Preflight rejects missing configuration or credentials.
Record real allocation, connection, failure, cleanup and provider cost evidence.
After stopping each host, verify both its DNS record and tunnel are gone.
Process exit alone does not establish provider cleanup. A single-host smoke
test is useful early evidence; it does not pass the physical separate-WAN gate.

For an operator's transport check, `scripts/managed-endpoint-smoke.mjs` creates
one disposable synthetic account and host, starts the trusted Homebrew
`cloudflared`, and verifies a marker through the public HTTPS tunnel. It then
stops the connector, releases the endpoint, checks Cloudflare for the DNS record
and tunnel's absence, clears the host advertisement and revokes the enrollment.
The empty synthetic account namespace remains. It does not test the app's
session authentication, sign-in UX or two physical networks.

Run it only after the managed staging deployment succeeds. Supply an
owner-only JSON file with mode `0600` containing `enrollmentAdminToken`,
`cloudflareApiToken`, `cloudflareAccountId`, `cloudflareZoneId` and `domain`.
These values must target the staging account, zone and `anvilstack.dev` domain.
The script rejects other targets and never prints credentials or host URLs:

```sh
cd /Users/anthonyhumphreys/Code/anvil/anvil-app
node scripts/managed-endpoint-smoke.mjs --credentials-file /protected/path/staging-smoke.json
```

Use a temporary `ENROLLMENT_ADMIN_TOKEN` on the staging Worker for this check.
Preserve any existing admin secret, remove the temporary secret afterwards and
verify its removal. Delete the local credential file after the check. Save the
sanitized JSON result with the candidate's staging acceptance record. A failed
cleanup result needs investigation before another allocation.

To disable staging managed allocation, save the rollout flag as `false` and
deploy. Release active hosts first and verify provider cleanup. Production and
ordinary release builds remain off.

## 5. Merge and public rollout

Merge only after current-candidate CI, review dispositions and core staging
acceptance pass. The [launch checklist](launch-checklist.md) separates those
gates from public rollout. Production resources and flags are a later operator
action.

Managed reachability still needs provider capacity, permitted-traffic and billing
evidence. Mobile native WebSocket buffering still needs a bounded transport or
an explicit rollout decision backed by physical-device resource tests. Keep
Anvil Cloud Agents disabled throughout this release.
