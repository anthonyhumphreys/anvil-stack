# Delivery readiness

Implementation started on 19 October 2026 from `develop` at `112c128`.

The intended result is a reviewable change that can move through implementation,
independent review, verification and a clean pull request. The user approved the
review recommendations, related UX fixes and automatic local verification.
Astra advises on architecture; Luna agents implement bounded areas. The primary
agent owns integration and the final evidence record.

## Implementation

- [x] Pin reviewed Git candidates and preserve unrelated index and working changes.
- [x] Separate delegated branch combination, verification and application evidence.
- [x] Support a bounded, explicit candidate source for remote review where the
      existing encrypted transport can safely carry it.
- [x] Produce honest local activation and delivery reports from recorded events.
- [x] Improve signed macOS release readiness and reconcile hosted beta documentation.
- [x] Exercise one portable-backend reference application through real local adapters.
- [x] Run combined typechecks, lint, tests, builds and a bounded UI verification pass.

Chat Commit and Open PR now review the exact current changes in selected files,
reject stale candidates, and preserve unrelated staging. Commits honor hooks and
signing; PRs use a dedicated branch against the reviewed remote base. A failed
push or provider request retains its recoverable branch and reports the outcome.

Delegation has separate combination, selected verification, retry and Apply
controls. Verification pins its tested commit/tree. Apply uses real Git locks,
persists intent before mutation, and reconciles an exact clean target after a
crash. Per-repository receipts make partial application visible.

Current-tracked remote review is read-only, bounded and encrypted. It freezes
dirty candidates, clean repository bases and the backend/account before approval.
New submission and replay check backend support; replay retains the original
ciphertext. Placement and claims require the current worker incarnation's
capabilities. This requires the updated backend and worker before use.

The local activation report measures recorded elapsed times, including the first
change-summary view and kept commit. It does not present rendered history as a
newly generated change or invent human effort, usage or quality measurements.
The portable-backend Cell and verifier exercise the built application against
real local adapters. A cross-bundle error normalization bug discovered by that
run is fixed.

See [reviewed delivery](anvil-app/docs/architecture/reviewed-delivery.md) for
behavior and [the comparison protocol](anvil-app/docs/dogfood/anv-7-delivery-comparison.md)
for the remaining human benchmark.

## External evidence

The corrected candidate preflight found a successful staging backend run
[#39230703438](https://github.com/anthonyhumphreys/anvil-stack/actions/runs/39230703438)
on the starting `112c128` SHA. An earlier read saw the preceding `44590a2`
deployment. The backend's public protocol descriptor is compatible with ordinary
Mesh, but does not advertise the new candidate capability enforcement feature.
No preview matches the current modified checkout. PR 91 and its previews refer
to the older `7f7b09b` candidate. See the
[staging evidence](anvil-app/docs/dogfood/mesh-staging-acceptance-2026-10-19.md).

Physical devices on separate WANs, authenticated hosted-device acceptance, a
fresh Mac installation, notarisation and live cloud execution remain separate
evidence. Local mocks, synthetic fixtures and loopback tests cannot pass those
gates. No production rollout or paid resource has occurred as part of this work.

The local keychain has Apple Development identities, but no Developer ID
Application identity; the production GitHub environment has no signing/notary
secret names configured. Release automation now checks the exact source tag
before building and again before uploading, and validates signed/notarized
artifacts when credentials are supplied. Automatic updates remain disabled.

Hosted Sync documentation consistently describes paid entitlement or beta-code
access, with checkout/production availability still gated. Local and self-hosted
use do not require a subscription. No entitlement policy was changed.

## Verification

Completed component checks:

- Desktop: all 333 test files passed; 2,945 tests passed and 12 were skipped.
  Node and web TypeScript checks, full ESLint, production Electron build and
  daemon build passed. The full suite ran under the normal Node runtime after
  its required native rebuild; Electron native modules were restored afterward.
- Mesh backend: 42 files, 454 tests; typecheck passed.
- macOS release target guards: 12 Node tests; staging status tooling: 8 Node tests.
- Anvil Cloud: lint, typecheck, full tests and Cloudflare preview verification
  passed. The reference Cell built and passed all 10 local acceptance checks,
  including conflict rollback, private-file access, restart recovery, duplicate
  receipts, poison-batch visibility and cleanup. `liveCloudEvidence` is false.
- Provider identity: the Cloud workspace's existing Wrangler login passed the
  read-only Cloudflare preflight for its sole accessible account; 9 injected-CLI
  tests passed. AWS STS identity lookup failed. Neither result establishes
  resource permissions, queue delivery, backup restore or migration rollback.
- Website: 101 documentation pages validated; typecheck and production build passed.
- Delivery UI: production components exercised in an explicitly synthetic replay;
  exact-diff review, cancellation, check selection, failed verification and Apply
  receipts inspected. This does not prove native, hosted or physical-device behavior.
- The final UI detector found no changed-component findings. Its shared CSS
  findings concern existing rules: the primary warning is a semantic Markdown
  blockquote border, with other existing token/style advisories. Those unrelated
  rules were left intact.
- Isolated native startup opened a fresh profile, migrated v0 to v113 and passed
  SQLite `quick_check`. Electron ABI 140 loaded successfully. The configured
  provider connection ping succeeded. Native window inspection was blocked by
  the locked Mac, so native visual acceptance remains unverified. The temporary
  app and replay server were stopped; the everyday profile was untouched.

During combined verification, concurrent `git write-tree` and status inspection
occasionally contended for the index lock and marked clean evidence stale.
Snapshot inspection now reads the pinned commit tree without writing the index;
the focused checks and subsequent full suite passed. Workflow IPC and browser
responses also strip candidate bytes and backend account authority, while the
main-process durable run retains them for replay.

This record describes the local implementation and verification before
publication. Subsequent commits are recorded in Git history. No release or
deployment was performed during that verification. Temporary verification logs
and the synthetic UI screenshot are in `/tmp/anvil-delivery-qa/`.
