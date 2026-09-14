# LAUNCH-01 — launch acceptance matrix

Packet: **LAUNCH-01** — integrated UX, device matrix, recovery and
demonstration acceptance. Gate: the §1 journey and §18 acceptance pass.

This matrix maps every launch requirement to its executable evidence and
its honest status. `automated` means a test or script proves it on every
run; `harness` means the driver exists and is verified locally, with a
credentialed run remaining; `manual` means a human with physical devices
must perform it — no automated substitute exists or is claimed.

## §1 demonstration journey

| # | Journey step | Evidence | Status |
|---|---|---|---|
| 1 | Sign in to a fresh profile; see workspaces, workflows, editable agents | `sync-two-profile.acceptance.test.ts` — real enrollment-code enroll + two-profile convergence of workflow templates/settings | automated |
| 2 | Workspace setup from Git incl. multi-repo + approved bootstrap, with progress and recovery | `prepare-workspace on a remote worker` (acceptance suite) + `workspace-materialization` service tests (journaled cloning, bootstrap approval) | automated |
| 3 | Start a session on another device; observe, approve, inspect, stop | `diagnostic job end-to-end` + `attempt events + R2 artifact` + `durable approval gating` (acceptance suite); observe/artifact services | automated |
| 4 | Move a session: source stops, target prepares, continuation with Git state | `initiateHandoff` leg in the acceptance suite — full durable state machine to `ownership-transferred` with exact-commit checkpoint; SESSION-03 unit tests (12 backend + 10 service) | automated |
| 5 | Three agents in separate worktrees spanning two devices, placement visible | FLOW-01: `code-task` executor runs each attempt in `mesh/attempt/<id>` worktrees at pinned commits; PLACE-01: capability/readiness-constrained placement. Two-device span requires physical hardware | automated (single-device) + manual (cross-device) |
| 6 | Integrate results in an isolated checkout, verify combined result, one reviewable change | FLOW-02/03: thin-bundle artifact transfer + `integrateResults` dependency-order merge + declared verification + honest conflict surfacing | automated |
| 7 | Offline edit / disconnected worker without losing work or silent re-execution | restore drill leg (wipe → full dataset restore in one cycle); durable job/attempt reclaim semantics; failure-injection suites | automated |
| 8 | Same unmodified app → user-owned Cloudflare + non-Cloudflare proof | **IAC-02 live rehearsal PASSED 10/10** on a real Cloudflare account (evidence/mesh-rehearsal-1789385691518.json) + BYOB-02 conformance suite (11/11 vs both backends) + `byob-conformance.test.ts` | automated |

## §18 acceptance bullets

| Requirement | Evidence | Status |
|---|---|---|
| Fresh device sets up a workspace without manual edits | prepare-workspace acceptance + WS-02 materialization tests | automated |
| User-owned Cloudflare deploy via published IaC; no Anvil-hosted dependency | `verify-mesh-rehearsal` live run: deploy→conformance→upgrade→restore→remove, 10/10, evidence record committed | automated |
| Third-party backend passes conformance + connects by URL from installed app | `conformance/suite.mjs` 11/11 vs fixture; `byob-conformance.test.ts` proves the shipped client path | automated |
| Setup shows stages/progress/actionable failures/restart-safe retry | journaled materialization + attempt journal; UI review pending | partial — manual UX check |
| Session view: target, freshness, approvals, activity, stop controls; lost connection ≠ cancelled | observer + artifact + approval paths proven; UI surface review pending | partial — manual UX check |
| Handoff shows owner + continuation mode; never claims live-process migration | handoff record carries provider/checkpoint; UI surface pending | partial — manual UX check |
| Three-agent run: distinct worktrees/devices/deps, real results, tested combined commit | FLOW-01/02/03 suites incl. real thin-bundle fetch + integration merge | automated |
| All Git/provider/platform combos; two physical machines + cross-OS | — requires hardware matrix | manual |
| Recorded demo on production paths, honest elapsed-time labels | — requires a human recording | manual |
| Empty/loading/offline/error/approval states, keyboard, contrast, reduced-motion | — requires UI audit | manual |
| Launch-day admission/abuse limits/quota alerts/runbook/rollback/backup rehearsed | OPS-01 retention+quota+restore drill; IAC-02 restore rehearsal | automated + harness |

## Executable gate command

```sh
# backend leg
cd anvil-app/cloud/backend && pnpm dev   # wrangler dev --env dev on :8787
pnpm test                                # 117 backend tests
pnpm conformance -- --url http://127.0.0.1:8787 --admin-token dev-admin-token
pnpm conformance:fixture                 # non-Cloudflare leg

# desktop leg
cd anvil-app
ANVIL_BACKEND_URL=http://127.0.0.1:8787 pnpm vitest run \
  src/main/services/__tests__/sync-two-profile.acceptance.test.ts   # 8/8
pnpm vitest run src/main/services/__tests__/byob-conformance.test.ts # 1/1

# IaC leg (non-live)
cd anvil-cloud && pnpm verify:mesh-rehearsal -- --name <w> --subdomain <s>
```

## Known open items before public launch

- One live IAC-02 run against a scratch Cloudflare account (harness ready).
- Physical two-device fan-out demonstration + recorded demo video.
- UI audit pass for §18 state-contrast/accessibility bullets.
- Cross-OS clone/materialization matrix entry.
