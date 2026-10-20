# Sync, mesh, and cloud execution readiness

Date: 2026-09-22
Status: implementation and local verification complete; live launch gates open
Progress log: [MARKET_READINESS_PROGRESS.md](MARKET_READINESS_PROGRESS.md)

## Intended result

A developer can understand Anvil's value, install it, optionally connect sync during first-run setup, choose whether this device accepts mesh work, and find useful status and recovery controls in Desktop and the web dashboard. Cloud execution has a provider-neutral contract that users and workflows can use without inheriting provider APIs. Marketing must distinguish implemented behavior from unverified or future capabilities.

This work includes implementation, not just recommendations. Implementation agents use `gpt-5.6-luna` with `xhigh` reasoning. Each owns separate files; the primary agent owns integration review, this plan, and the progress log. No production deployment, paid resources, release, or shared-system changes are included.

## Evidence and constraints

- Desktop settings currently put backend selection, enrollment, sync adoption, device management, security, dashboard grants, portability, and mesh activity in one large panel. Review the complete interaction before rearranging it.
- Sync carries portable workspace definitions, settings, workflows, and agent definitions. It does not automatically sync repository files or chat transcripts. Copy and onboarding must preserve this distinction.
- Mesh jobs already have durable attempts, approval, cancellation, isolation, and handoff machinery. Readiness depends on recovery and truthful terminal states, not just the happy path.
- There are two cloud paths. Mesh cloud environments already implement AWS Lambda MicroVM, Vercel Sandbox, Cloudflare Sandbox, and Anvil-managed adapters in `anvil-app/src/main/services/cloud-environment.service.ts`. They run mesh workers and are accessible through daemon commands and workflow targets. The main usability gap is bringing their connection and environment lifecycle into Desktop UI.
- Separately, `PATCH.md` C2 protects the Anvil Cloud execution control plane, credential boundaries, immutable sources, cursor recovery, bounded costs and TTL, and verified cleanup. AWS is that path's current production-target adapter and remains read-only. Do not confuse its limits with mesh environment adapter availability. Both paths need live-provider verification before production claims.
- The cloud execution architecture explicitly lists missing production work, including a compatible worker image, real-account smoke tests, concrete subscription login drivers, credential brokering, hosted concurrent persistence, and reviewed patch artifacts.
- Preserve the existing restrained Anvil visual identity. Desktop and dashboard prioritize operating tasks; public pages prioritize understanding the product and taking a useful next action.

## Work sequence

### 1. Audit and establish product truth

- [x] Trace first-run onboarding, settings, sync activation, mesh participation, remote launch, workflow execution, and dashboard access.
- [x] Inspect trust, account/workspace isolation, retry and offline behavior, device revocation, cancellation, source preparation, and cleanup.
- [x] Record concrete defects with code evidence and separate verified behavior from launch assumptions.
- [x] Establish a current provider capability matrix for manual and workflow execution.

### 2. Desktop settings and initial onboarding

- [x] Add an optional sync and mesh setup step to the actual initial onboarding path, with a skip path and later access through settings. Native acceptance remains in step 6.
- [x] Reuse the real connection/enrollment path. Never create a second setup implementation or enable remote work without an explicit user choice.
- [x] Clarify the difference between account connection, active sync, device trust, mesh participation, and cloud execution.
- [x] Organize settings around current status and the next useful action. Move uncommon operational detail out of the primary path.
- [x] Preserve inputs and provide actionable loading, failure, offline, success, and retry states. Shared status polling keeps connection badges current without overwriting drafts.
- [x] Add restrained delight at meaningful completion, such as naming the connected device or showing that setup is ready. Connected-state checks and explicit Mesh readiness replace invented progress or routine celebrations.

Acceptance: a fresh user can stay local, connect sync, and choose mesh participation; an existing user can reconnect or recover without losing context. Keyboard focus, labels, long names, and feature flags remain correct.

### 3. Sync and mesh backend

- [x] Review the implemented trust and execution lifecycle end to end.
- [x] Fix evidence-backed readiness defects with targeted regression coverage.
- [x] Preserve encrypted data boundaries, enrollment/authorization checks, generation fencing, and isolated working trees.
- [x] Ensure cancellation and lost contact never imply verified completion or cleanup.
- [x] Document any remaining live-device or hosted-environment verification.

Acceptance: focused lifecycle and failure tests pass; no claim of production readiness substitutes for real multi-device acceptance testing.

### 4. Provider-neutral cloud agents and workflows

- [x] Expose existing mesh provider connections and environment request/list/terminate APIs through typed Desktop IPC and a useful settings panel.
- [x] Make existing workflow environment targeting understandable, with usable provider and environment choices.
- [x] Review execution lifecycle and how callers discover usable providers and authentication modes.
- [x] Implement the highest-value missing manual/workflow integration through the shared execution contract.
- [x] Preserve idempotent creation, durable event cursors, explicit approvals, immutable source identity, bounded execution, and cleanup receipts. Live-provider verification remains a launch gate.
- [x] Keep provider choice honest and fail clearly for unsupported capability combinations before provisioning.
- [x] Update architecture documentation and `PATCH.md` when owned behavior changes.
- [x] Record what is needed for Vercel and Cloudflare adapters and live conformance. Do not ship decorative provider choices backed by no executor.

Acceptance: a tested caller can start and inspect execution through a provider-neutral API; workflow retries do not duplicate work. Supported providers and remaining deployment requirements are explicit.

### 5. Website and dashboard

- [x] Rewrite weak public copy around real developer jobs, product evidence, and a clear next action.
- [x] Strengthen homepage and sync-page composition while retaining the established typography, palette, and technical visual language.
- [x] Remove generic claims and unsupported maturity or provider promises.
- [x] Make dashboard access, connection state, jobs, approvals, and device context understandable using real backend capabilities.
- [x] Provide useful empty, expired-access, loading, and failure states; maintain keyboard and responsive behavior. Authenticated dashboard behavior still needs live acceptance.
- [x] Apply Impeccable clarify, delight, and polish after the information hierarchy is sound. Web visual checks completed; authenticated dashboard remains a live acceptance gate.

Acceptance: visitors can explain what Anvil does and choose a working setup route; dashboard users can identify work needing attention and act without deciphering protocol terminology.

### 6. Integration and verification

- [x] Inspect combined diffs and resolve cross-project contract or copy drift.
- [x] Run focused regression tests first, then required project checks appropriate to the changed scope.
- [x] Desktop: TypeScript, lint, relevant tests, and build where appropriate. Cloud: changed-package typechecks/tests and execution conformance. Website: typecheck and production build.
- [x] Perform batched visual inspection, fix findings, and confirm. Anth's additional screenshot feedback prompted a narrow flattening pass on nested cloud cards.
- [x] Record test results, visual limitations, outstanding launch gates, and exact next steps in the progress log.

## Launch gates

Do not call the feature ready to market as generally available until live evidence covers device enrollment and revocation, offline catch-up, interrupted execution, approval and cancellation, dashboard grant expiry, and cleanup. Hosted billing/identity, worker image availability, subscription login, provider credentials, and multi-process persistence require their own verified environment. A source-code improvement or fake-provider test does not clear those gates.

## Provider and execution matrix

This is a source-code inventory, not a claim that an account or provider is deployed.

| Path | Adapter code | User/workflow entry | Proof still needed |
| --- | --- | --- | --- |
| Mesh on another device | Desktop/daemon worker | Existing mesh dispatch and workflow device/automatic placement | Physical-device acceptance, interruption and recovery |
| Mesh on AWS Lambda MicroVM | Desktop provider adapter | Daemon environment commands and workflow cloud target; Desktop setup being added | Compatible image, account credentials, bootstrap, job, teardown |
| Mesh on Vercel Sandbox | Desktop provider adapter | Same mesh environment contract | Image compatibility, subscription/API permissions, live lifecycle |
| Mesh on Cloudflare Sandbox | Desktop adapter plus `cloud/provisioner` | Same mesh environment contract | Deployed provisioner, token, image, live lifecycle |
| Anvil-managed mesh worker | Backend provisioner binding | Managed environment request | Hosted identity/entitlement, service binding, D1, quotas and teardown |
| Anvil Cloud execution control plane | AWS transport plus fake conformance provider | Optional Desktop Cloud panel and CLI | Worker/login drivers, hosted persistence, credential broker, real-account smoke test |

Desktop must explain that provisioning a cloud worker prepares capacity; assigning a job or workflow gives it work. A submitted request is not an enrolled worker, and requested cleanup is not verified teardown.

## Implementation ownership

| Workstream | Owned files |
| --- | --- |
| Desktop experience | `anvil-app/src/renderer/`, narrow shared UI helpers |
| Sync and mesh reliability | `anvil-app/src/main/`, `anvil-app/cloud/backend/`, associated tests |
| Cloud execution | `anvil-cloud/`, relevant `PATCH.md` entry |
| Mesh cloud environments | Desktop cloud environment service, typed IPC, new settings panel, workflow target UI |
| Desktop remote execution | Desktop cloud execution service, its renderer panel and tests |
| Website and dashboard | `anvil-website/` |
| Integration and readiness record | Root plan and progress documents, combined review |

Revise this plan as inspection establishes narrower defects or required dependencies. Record scope decisions in the progress log instead of silently dropping requested work.
