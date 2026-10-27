# Software Factories Plan

Status: first GitHub/Codex implementation complete; automated verification passed

Owner: Anvil Desktop

Date: 2026-10-26

## Goal

Let a user describe an issue-to-merged-PR process in chat, review a typed and versioned factory definition, and activate it with clear boundaries. Each issue should have one durable lifecycle from intake through implementation, validation, PR review and confirmed merge. The system should retain evidence and make blocked work easy to take over.

Example conversation: “For new `ready-for-agent` issues in the Anvil project, use the `anvil-app` repository. Have the planner clarify acceptance criteria, implement them, run the required checks, and open a draft PR. Repair CI and review feedback at most twice, then ask me to merge. Stop on a security finding or unclear scope.” The user can instead request: “Make runs visible to the delivery team and automatically merge once the required checks and reviews pass.” Anvil should turn either request into a reviewable form, show its trigger, filters, repo, graph, model choices, criteria, limits, audience, roles and publication/merge authority, and activate only after explicit confirmation.

## Implemented first slice

The working implementation now has immutable definitions and pinned graphs, a
SQLite lifecycle/receipt engine, exact-head typed GitHub delivery, manual and
standing automatic merge policies, confirmed merge/post-merge verification,
organisation access controls, and conversational/UI configuration. PATCH C8 is
the current owned behavior guide.

Automated verification passed: desktop suite (348 files, 3,177 tests; 4 files
and 12 tests skipped), full Node/web TypeScript checks, lint, production build,
hosted backend suite (43 files, 483 tests), backend typecheck, and `git diff
--check`. No live GitHub write, production migration or deployment was
performed or tested.

Execution supports local Codex app-server workflow nodes on the trusted Electron
automation daemon. Other model-provider configurations and remote worker nodes
fail activation rather than inheriting unsupported credentials or tools. The
pure runtime/store are independent of Electron; a deployed standalone headless
server is not included. The host must remain awake and connected.

Supported budgets are wall-clock duration, observed shell commands across
workers/checks, concurrency and repair rounds. Command events are observed and
workers terminated promptly at exhaustion; no hard pre-execution command
allowlist or spend/dollar ceiling is claimed. Each acceptance criterion is
explicitly bound to the verification command at its corresponding index;
subjective criteria still need appropriate human review. At least one post-merge
check is required.

Source identity is immutable per factory. Remote owner/admin revisions retain
the existing pinned workflow; graph/provider changes are prepared on the
executor. Role/source/visibility checks remain authoritative in the backend;
remote owner-local IDs never supply recipient repository authority.

## Setup and operating the first slice

1. Apply desktop migration 116 (automatic on app startup) and the accompanying
   hosted factory migration before enabling organisation factories. Deploy the
   matching backend with factory registry/access RPC support; older backends fail
   closed. No production migration or deployment is performed by this change.
2. Sign in to Codex and connect GitHub with repository access. Save a local Codex
   workflow, then describe the factory in chat or open Factories. Choose the
   exact source/label/base, ordered criterion/check bindings, post-merge checks,
   budgets, audience and merge mode. Review the concrete preview before saving
   and explicitly activating the saved revision.
3. Activation prepares the existing automation daemon on supported macOS/Linux
   hosts. Keep that trusted machine awake and online. Monitor receipt/state and
   budget details; pause/cancel/takeover remains pending when the provider has
   not confirmed a safe merge cancellation. A merged PR is verified before the
   lifecycle reports completion.
4. Organisation recipients enrol their account encryption key and need current
   GitHub source access plus the configured audience/role. Operators control
   existing runs through the designated executor. Owners/admins review policy
   revisions remotely; source identity remains immutable. Pick up a confirmed
   remote claim into a recipient workspace/agent, explicitly mapping any local
   repository by canonical GitHub identity.

Known limits: one GitHub source per factory; isolated local Codex workers only;
no standalone server deployment, spend ceiling, general shell pre-execution
allowlist, or automatic resolution of ambiguous direct asynchronous merge
requests. Required provider reviews and branch protections remain authoritative.
Missing membership, source permission, key context, backend capability or an
uncertain external result stops new writes instead of widening access.

Encrypted hosted factory snapshots and historical run evidence are retained in
the hosted database when a desktop account or organisation is removed; current
membership and source checks revoke access, but automated purge on account or
organisation deletion is not implemented. Recipient keys are stable per Sync
account, so additional devices can decrypt after enrolment; there is no
automated key-rotation or recovery workflow yet. Re-enrolling an account does
not rotate its key or erase previously stored ciphertext.

## Historical starting point (before this implementation)

The committed desktop code already has reusable workflow graphs and durable workflow runs. `workflow_list`, `workflow_start` and `workflow_read` let an agent inspect, launch after user approval, and follow a workflow; the launch tool explicitly says remote changes are not automatically integrated (`src/main/agent-tools/workflow-tools.ts`). Workflow templates are typed DAGs of specialist nodes and edges, can be drafted from a conversational request, validated and saved (`src/shared/types.ts`, `src/main/services/workflow.service.ts`). Workflows support human steps, bounded attempts/concurrency/time, verification, and a separately reviewed local integration flow. They do not form an issue-triggered, end-to-end remote publication and merge lifecycle.

Automations persist definitions, runs and run events; run scheduled or Watchtower triggers; use disposable worktrees; and can launch a saved graph or bounded persona loop (`src/main/services/automation.service.ts`, `src/main/services/automation-persistence.service.ts`, `src/renderer/components/automations/AutomationsView.tsx`). The existing Watchtower event set covers workflow completion/failure, PR merge/close/review-comment/head-change and pipeline completion/failure. GitHub and Azure DevOps sources are observed by the automation scheduler; **issue creation is not a supported event** (`src/shared/types.ts`, `src/main/services/watchtower-source.service.ts`). The daemon scheduler ticks every 30 seconds (`src/main/services/automation.service.ts`). Work-item connectors already cover Linear, Jira and Azure DevOps, but that does not provide issue-created triggers or factory lifecycle coordination (`src/main/services/workitem-provider.ts`).

The preceding automation change introduced an explicit `allowRemotePublishing` setting and removes the blanket manual-only feedback restriction for eligible current-head repairs. The setting authorizes branch/PR/comment publication through the existing trusted CLI workers and configured provider access; it does not create a credential-isolation boundary or grant merge authority. That automation-only baseline was a foundation; the implementation described above now adds the factory controller and typed lifecycle. The working tree also contains separate, uncommitted conversational validation work (PATCH C5); that work should be reviewed and completed before a factory depends on its per-criterion evidence gates.

## Definition and lifecycle

Represent a factory as a strict, versioned definition rather than storing its entire meaning in a prompt. Reuse a pinned workflow graph for the work; wrap it with durable trigger, scope, policy and lifecycle state. For example:

```yaml
schemaVersion: 1
name: Ready issue to reviewed PR
owner: { kind: workspace, id: anvil-app }
visibility: { mode: team-project, scopeId: delivery-team }
trigger: { provider: github, event: issue.created, repo: anvil, labels: [ready-for-agent] }
scope: { repos: [anvil-app], baseBranches: [main], maxOpenIssues: 2 }
workflow: { templateId: implementation-review, revision: 4 }
models:
  { planner: configured-default, implementer: configured-coder, reviewer: configured-reviewer }
successCriteria: [acceptance-criteria-met, required-checks-green, review-clear]
limits: { repairRounds: 2, runMinutes: 90, commands: 40, spend: user-configured }
publication: { branch: factory/<issue>, pullRequest: draft, reviewComments: allowed }
mergePolicy:
  mode: human-approved # alternative: auto-merge
  method: squash
  conditions: [acceptance-criteria-met, required-checks-green, required-reviews-approved]
```

The schema should validate providers, model availability, repo and base-branch scope, criteria, budgets, retry rules and permissions. Save immutable revisions so each issue run records exactly which definition, graph and policy it used. Workflow edits and expanded execution grants affect new issues; existing runs need an explicit migration or restart action to adopt them. Current access revocations, pauses and reductions in merge authority also apply to active runs without rewriting their historical definition. Store secrets/credentials through existing provider settings, never in the definition or workflow prompts.

Add typed delivery operations for branch publication, PR creation/update, comments and merging, with scoped provider credentials and durable intent/result receipts. The current CLI publishing setting expresses the user's authorisation, while a factory controller must be able to enforce its merge policy independently of an agent's prose or shell choices. Reuse the existing reviewed Git delivery primitives where possible; a factory's standing approval needs an explicit action contract rather than silently changing the interactive review flow.

Track one lifecycle record per provider/repository/issue identity, with an idempotency key and receipts for trigger, claim, graph revision, worktree/branch, criteria evidence, checks, PR URL and head, review feedback, repair attempts, merge observation and final verification. Duplicate deliveries and restarts must resume or reconcile the same record rather than create a second branch or PR. Suggested states: received, claimed, planning, implementing, validating, awaiting publication, PR open, CI/review pending, repairing, awaiting human action, merged, verified, blocked, cancelled. Every transition records its source and evidence; ambiguous provider writes require reconcile-before-retry.

For each issue: receive and deduplicate the event; confirm it still matches filters and repo scope; capture issue content and acceptance criteria; run the pinned graph in a disposable worktree; verify each declared criterion with concrete test/check evidence; publish an allowed branch and draft PR; reconcile CI and review feedback; perform at most the configured repair rounds against the current PR head; then apply the selected human-approved or auto-merge policy. Confirm merge from the provider and run post-merge checks before reporting completion. A run that merely opened a PR is not a completed factory lifecycle.

## Organisation visibility and roles

Visibility is configurable per factory, and its run list inherits that access policy. The implemented organisation boundary now enforces these policies through the hosted registry, recipient encryption and current source checks. Production availability requires the accompanying backend migration and deployment; local code alone does not enable a remote backend.

| Visibility             | Who can see the factory and its runs                 |
| ---------------------- | ---------------------------------------------------- |
| Organisation-wide      | All current members of the owning organisation.      |
| Team/project (default) | Members authorised for the selected team or project. |
| Restricted             | Explicitly invited members.                          |

An organisation-wide factory makes its runs discoverable to all members; it does not make every factory in the organisation visible. Run details, transcripts, logs and artifacts additionally respect the source repository, ticket and artifact permissions. Summaries, search results and notifications must not expose restricted source content. Guest viewers receive only explicitly shared content and gain no factory-list or operating access from a share link.

| Role        | Allowed actions                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Viewer      | Follow progress and inspect the run details and evidence they are permitted to read.                                                      |
| Operator    | Viewer actions plus pause, resume, cancel, retry and pick up an existing run within its approved policy.                                  |
| Owner/admin | Operator actions plus edit the factory, manage visibility and roles, activate it, and authorise or change publication and merge policies. |

An operator cannot widen repository scope or enable auto-merge through a retry or takeover. Administrative control over the factory does not itself grant access to protected repository content or credentials. Execution and merge authority belong to an explicitly authorised owner or service identity with scoped connector credentials; team membership and viewing permission do not supply that authority.

Show audience and role assignments in the conversational definition preview and support later changes through the same reviewed configuration flow. Evaluate current membership and permissions on every list/read/control request, including direct run links, downloads and live subscriptions. Removing access cuts off future reads and control; retain an audit record of policy changes and run actions. Keep the original execution-policy revision on each run, while evaluating its visibility against current access rules. Widening visibility should explicitly identify whether existing run history will become visible, and narrowing it should immediately restrict existing history.

## Product boundaries and runtime

Make oversight per factory and per issue: active/paused state, current stage, last receipt, age, budget consumed, retry count and next action. Provide pause, resume, cancel, retry-after-reconcile, edit-for-future-issues and “pick up this thread” controls. A human takeover should claim/pause the live factory run before creating a normal private chat with its issue, graph, branch, evidence and missing context. The existing thread pickup imports a snapshot into a fresh private conversation; it does not claim or stop an active factory run, so that coordination boundary needs new lifecycle support.

Use a trusted, always-on daemon and provider polling for the first vertical slice. The existing Electron automation daemon already offers a restartable user service and 30-second polling, but its scheduler is inside the Electron-bound automation service. Extract a plain-Node scheduler/runtime boundary for a headless server deployment; the existing Electron daemon can support an initial desktop-hosted pilot. Sync alone cannot construct new private jobs while all trusted endpoints are offline: the factory runner needs the authorised definition, keys and connector credentials. Add webhook delivery later, retaining periodic reconciliation for missed events and uncertain writes. Keep issue content, credentials and factory state private, preserving the existing Sync/Mesh encryption model. An organisation share link does not establish a shared factory owner, role model, audit authority or credential authority; shared factories require those explicit concepts before cross-user activation.

## Merge options

Every factory exposes two explicit merge modes in chat and its configuration preview:

- **Human-approved:** wait for an authorised person's approval of the current PR head before requesting merge.
- **Auto-merge:** request merge automatically when all configured acceptance criteria, required CI checks and required reviews are satisfied for the current head. The user authorises this standing policy when activating the factory; eligible runs require no additional Anvil merge confirmation.

Record the permitted repositories and target branches, merge method, required conditions and merge identity in the versioned definition. Auto-merge includes the transition out of draft status when its readiness conditions pass, followed by the provider's normal merge or merge-queue flow. Respect branch protections and required human reviews; an agent's favourable review alone cannot satisfy a provider-required approval. Revalidate the head and conditions immediately before requesting merge, invalidate stale evidence after new commits, and record the resulting receipt. An accepted request or queue entry is not proof of merge; observe the final provider state before completing the run. GitHub's [merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously) supports an expected head SHA and distinguishes queued from merged outcomes.

Only an authorised owner/admin can enable auto-merge or widen its scope. The existing `allowRemotePublishing` option grants no merge authority. Ticket text, reviewer comments and operator retries cannot change merge policy. Disabling auto-merge or pausing a factory must stop new merge requests for active runs as well as future runs; reconcile and cancel any queued merge where supported, and report if the provider has already merged it. Missing conditions, exhausted repair budgets or ambiguous outcomes leave the run waiting or needing attention, with its context available for human takeover.

## Original first-slice plan and estimate (historical)

Choose one issue provider, one repository, one label filter and one workflow graph. Deliver issue-created polling with durable dedupe/reconciliation; conversational draft and typed preview; immutable versions; explicit publication permission; issue-to-draft-PR lifecycle; CI/review repair with bounded current-head checks; both human-approved and opt-in auto-merge modes; and confirmed merge/post-merge receipts. A pilot can initially exercise human-approved mode, but auto-merge is a required planned option before claiming fully autonomous issue-to-merged-PR delivery. Test duplicate events, daemon restart at every stage, lost/ambiguous publish responses, changing PR heads, required-review failures, exhausted budgets, pause/takeover, disabling auto-merge while queued, and merge confirmation.

Design the ownership, visibility and role contracts in the first slice so organisation access is not retrofitted into run records. Follow the single-owner pilot with organisation-wide, team/project and restricted visibility, role management and shared credential authority before enabling organisation factories. Acceptance checks must cover all three audiences, denied direct links and subscriptions, membership removal, viewer/operator/owner boundaries, protected source details, guest sharing, history visibility changes, and attempts to enable auto-merge without owner/admin authority. Multiple issue providers remain a later expansion.

Provisional estimate: **4–6 engineering weeks for a narrow single-provider pilot**, assuming existing workflow/worktree/provider pieces can be reused and one engineer owns the vertical slice with normal review support. Re-estimate against the complete auto-merge gate before committing to that range; it originally assumed a human-approved pilot. **8–12+ weeks** remains an initial planning range for a broader release with several provider adapters, robust lifecycle recovery, auto-merge, organisation visibility/roles, notifications and expanded UX. These are planning ranges, not commitments; provider API behavior, enforceable merge authority and organisation access integration are the main uncertainties.
