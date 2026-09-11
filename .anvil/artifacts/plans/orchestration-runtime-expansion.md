# Orchestration runtime expansion

## Direction

Evolve Desktop Workflows into a runtime that coordinates agents, records decisions, and proves the integrated result.

Keep the existing workflow editor as a template authoring tool. Add a live execution view showing the graph actually running, including new tasks, attempts, blocked work, human decisions, and evidence.

Implement this incrementally on `feature/orchestration--runtime-expansion`, based on `main`.

## Existing implementation

Source inspection confirms:

| Area | Current behaviour |
|---|---|
| Graph validation | Supports branching and merging; rejects cycles. |
| Scheduling | Executes all ready nodes together, then waits for the entire batch. |
| Strategies | Focused, adaptive, parallel, and review-team add instructions to agent prompts. |
| Handoffs | Downstream prompts receive upstream output text. |
| Persistence | Stores graph and node-state JSON on each run. |
| Supervisor | Answers questions from a run snapshot; cannot mutate the graph. |
| Cancellation | Terminates tracked processes and updates persisted state. |
| Events | Workflow completion and failure feed Watchtower. |
| Provider routing | Nodes carry provider, model, and reasoning settings. |

Relevant files:

- `anvil-app/src/main/services/workflow.service.ts`
- `anvil-app/src/shared/types.ts`
- `anvil-app/src/main/ipc/workflow.ipc.ts`
- `anvil-app/src/renderer/components/workflows/WorkflowsView.tsx`
- `anvil-app/src/main/services/__tests__/workflow.service.test.ts`

The existing evidence-backed review plan defines snapshot, criteria, finding, and decision concepts. Orchestration should reference those records instead of creating competing acceptance state.

## Design decisions

### Preserve immutable execution history

Separate a logical task from its execution attempts. Retrying creates another attempt. Reopening completed work creates a new task revision and records what invalidated the earlier result.

Record runtime changes as ordered events alongside transactional state updates. Include actor, reason, run revision, and command identity.

An agent requests a change. The runtime validates and applies it.

### Keep each execution graph acyclic

Dynamic orchestration does not require arbitrary cycles in the scheduler.

Represent repair loops through new attempts or appended remediation and verification nodes. Preserve the earlier review and implementation history.

Initially permit bounded append operations. Defer arbitrary replacement of active nodes and dependencies.

### Coordinate through versioned records

Consumers receive selected references and bounded summaries for artifacts, findings, decisions, and source snapshots.

Each handoff records which versions the consumer used. Changing a referenced input can make downstream evidence stale without rewriting its historical outcome.

Shared state must not imply a shared writable checkout. Concurrent implementation needs isolated worktrees or an explicit exclusive workspace claim.

### Enforce authority outside prompts

Child workflows inherit limits that they cannot widen.

Enforce concurrency, depth, allowed templates, and available tool permissions in runtime code. Treat model confidence as a scheduling hint.

Distinguish measured usage from estimates. Do not advertise hard token or cost limits where provider adapters cannot enforce them. Reserve capacity before dispatch and account for outstanding work.

## Delivery sequence

### 1. Bounded scheduling and lifecycle correctness

Replace batch execution with scheduling that fills available slots whenever an attempt finishes.

Add a persisted concurrency setting, validated in the service and editable in the workflow UI. Existing templates receive a documented default.

Make cancellation terminal. Late provider results must not restore a cancelled run or start downstream work.

Handle dispatch failures and interrupted application sessions explicitly. Recovery must not silently rerun a write operation whose outcome is unknown.

Acceptance checks:

- Running attempts never exceed the configured limit.
- A downstream step starts when its own dependencies finish, even while an unrelated step continues.
- Failed dependencies block their descendants while independent work continues.
- Cancellation prevents further dispatch and survives late completion callbacks.
- Startup identifies interrupted runs.
- Existing templates remain readable and runnable.

This is the first implementation increment.

### 2. Attempts and durable runtime events

Add attempt identities, ordered events, transactional transitions, and command deduplication.

Expose an execution timeline with attempt history and failure reasons. Add explicit retry and recovery actions.

Acceptance checks:

- Duplicate commands do not create duplicate attempts.
- Restart preserves completed work and identifies uncertain attempts.
- A stale callback cannot complete a newer attempt.
- State changes and their audit events commit together.

### 3. Structured handoffs and integrated evidence

Introduce typed handoff references with input versions and bounded projections.

Associate implementation attempts with their worktrees and source snapshots. Create an explicit integration step that produces the candidate reviewed by downstream agents.

Connect to the planned review records for criteria, findings, verification, and acceptance.

Acceptance checks:

- Reviewers can identify the exact candidate they inspected.
- A later integration change invalidates dependent evidence.
- Missing artifacts remain visible.
- Agent-reported success cannot become runner-observed verification.

### 4. Controlled graph expansion and repair

Add runtime commands for spawning approved task templates and requesting remediation.

Validate commands against the current run revision, authority, remaining budget, maximum node count, and dependency rules.

Persist accepted and rejected requests with reasons.

Acceptance checks:

- Duplicate spawn requests create one expansion.
- Invalid dependencies and exhausted limits reject expansion.
- Concurrent requests cannot overspend reserved capacity.
- Remediation preserves the original finding and creates fresh verification work.
- Repair limits terminate in an explicit unresolved state.

### 5. Recursive workflows and human decisions

Allow a node to invoke a pinned workflow-template version.

Persist parent-child relationships. Propagate cancellation and account for child resource use within parent limits.

Add human decision nodes with durable options, responses, and the exact candidate or graph revision being approved. Desktop and mobile resolve the same record.

Acceptance checks:

- Depth and aggregate concurrency limits hold across children.
- Parent cancellation reaches active descendants.
- Restart preserves pending decisions.
- A decision for an older candidate cannot approve a newer one.

### 6. Strategy composition and event entry points

Build map/reduce, independent review, quorum, and bounded repair as compositions over the same runtime.

Define quorum behaviour precisely, including abstention, unavailable reviewers, disagreement, and stale evidence.

Extend existing automation entry points with authenticated event ingestion, deduplication, and loop prevention.

Defer auctions, tournaments, and evolutionary search until actual workflows justify their cost.

## First useful product workflow

Deliver one complete path:

1. Plan a feature against versioned acceptance criteria.
2. Run independent implementation tasks in isolated worktrees.
3. Integrate their changes into a candidate snapshot.
4. Run two reviewers against that same candidate.
5. Convert accepted findings into bounded remediation tasks.
6. Integrate and verify the new candidate.
7. Record human acceptance with the supporting evidence.

The user should be able to inspect who changed what, why new work appeared, what remains blocked, and which evidence still applies.

## Verification approach

Use controlled fake workers to exercise scheduling order, failures, cancellation, and late callbacks. Add persistence tests for restart recovery, duplicate commands, and transactional event history.

Run focused tests first, then the application test suite for implementation changes. No runtime code has changed during this initial source review.

## Scope boundaries

Keep the first implementation in `anvil-app`. No new orchestration dependency or Cloud runtime rewrite is justified yet.

Preserve existing templates and provider adapters. Add runtime capabilities through the existing shared types, service, IPC, preload, and renderer boundaries.

The long-term strategy catalogue is a roadmap. Completion of the scheduler increment must not be presented as completion of the dynamic orchestration runtime.