# Agent Run System Plan

Status: local implementation plan  
Owner: Anvil Desktop  
Date: 2026-07-02

## Goal

Build Anvil's Agent Run System: a local-first command center where every agent, automation, review, triage, and sandbox-backed task is launched from real context, can run in an isolated branch or worktree when needed, can be steered while active, leaves evidence while it works, and hands off to review or PR without pretending the agent is the authority.

The first useful version should prove one complete path:

1. Start from a Linear issue, GitHub issue, or manual prompt.
2. Select a repository, provider, branch/worktree policy, run mode, and validation checklist.
3. Persist the run and live events into SQLite.
4. Stream terminal, plan, file, diff, and status events into the Agent Command Center.
5. Allow a user to steer, pause, resume, fork, stop, or rerun before completion where the provider supports it.
6. Produce an evidence pack with commands, test results, diffs, linked work item, skipped checks, and remaining risk.
7. Create or update a draft PR only when the user explicitly asks for it.
8. Turn a successful run into a recurring automation with a state journal.
9. Show provider, model, context, duration, and cost metadata where available.
10. Keep every write behind explicit permission and every merge behind human review.

## Market Signals

Recent Claude Code, Codex app, T3 Code, Devin, GitHub Copilot app, Jules, Cursor, and adjacent coding-agent products are converging on the same shape:

- Agent command centers instead of isolated chat boxes.
- Long-running or background work with notifications and resumability.
- Scheduled, triggered, and issue-driven sessions.
- Branch or worktree isolation for risky work.
- Browser, terminal, diff, and test evidence attached to the run.
- PR creation and review-comment follow-through.
- Provider-neutral orchestration across multiple agents.
- Cost, rate-limit, and context controls as product UX rather than billing archaeology.

The useful product lesson is not "add more chat". The useful lesson is "manage agent work like engineering work".

## Current Anvil Starting Point

Anvil already has pieces of this:

- `src/main/services/agent-run.service.ts` derives a recent run view from chat, automation, and code review data.
- `src/shared/types.ts` already defines `AgentRunSummary`, `AgentRunSource`, and `AgentRunStatus`.
- `src/main/ipc/agent-run.ipc.ts`, `src/preload/index.ts`, and `src/shared/ipc-api.d.ts` expose a small `agentRuns.list` API.
- `ChatView` already has a "Recent agent runs" control.
- Automations already persist runs and events in `automation_runs` and `automation_run_events`.
- Chat persistence already captures messages and Codex events.
- Code review already persists review reports and findings.
- Work item providers already cache Linear, Jira, Azure DevOps, and related planning context.

The missing piece is a real shared run model. Right now agent runs are mostly a projection. That is useful, but it is one feature request away from becoming haunted.

## Product Principles

- The run system is the source of truth. Chat threads, automations, code reviews, work-item starts, PR follow-ups, and sandbox tasks are projections of a run.
- Evidence beats confidence. If a run claims something passed, it links the command, output, browser check, review source, or diff.
- Steering is a first-class control, not an apology after the agent has already edited the wrong abstraction.
- Recurring work must have an owner, expiry, and state journal.
- Draft PRs are acceptable. Auto-merge is out of scope until explicit gates, policy, and owner approval exist.
- Provider adapters should be boring. The workflow, evidence, and governance are the product.
- Keep the first version local-first. Cloud handoff is a later capability, not a reason to delay the local spine.

## Milestone 1: Persisted Run Backbone

Create durable SQLite tables and service APIs for runs.

Schema:

- `agent_runs`
  - `id`
  - `workspace_id`
  - `source`
  - `status`
  - `title`
  - `summary`
  - `provider`
  - `model`
  - `mode`
  - `trigger`
  - `repo_ids_json`
  - `branch_name`
  - `worktree_path`
  - `thread_id`
  - `session_id`
  - `automation_id`
  - `review_id`
  - `work_item_provider`
  - `work_item_id`
  - `metadata_json`
  - `started_at`
  - `completed_at`
  - `updated_at`

- `agent_run_events`
  - `id`
  - `run_id`
  - `type`
  - `content`
  - `metadata_json`
  - `created_at`

- `agent_run_artifacts`
  - `id`
  - `run_id`
  - `type`
  - `title`
  - `path`
  - `content`
  - `metadata_json`
  - `created_at`

- `agent_run_links`
  - `id`
  - `run_id`
  - `type`
  - `target_id`
  - `url`
  - `metadata_json`
  - `created_at`

Implementation:

- Add schema migration in `src/main/db/schema.ts`.
- Extend shared types beyond `AgentRunSummary` with `AgentRun`, `AgentRunEvent`, `AgentRunArtifact`, `AgentRunLink`, and creation/update inputs.
- Replace `listAgentRuns()` with persisted run reads.
- Keep a compatibility projection from older chat, automation, and code review records until new runs are created natively.
- Add focused persistence tests.

## Milestone 2: Event Ingestion

Pipe existing feature events into the shared run stream.

Sources:

- Codex/chat session events.
- Automation run events.
- Code review lifecycle and findings.
- Git operations and changed-file summaries where available.
- Command execution and test output.
- Browser/simulator preview evidence when present.

Implementation:

- Add `createAgentRun`, `appendAgentRunEvent`, `completeAgentRun`, `failAgentRun`, and `linkAgentRun` APIs.
- Attach a run id when starting a chat implementation/review/docs/handover session.
- Attach a run id when creating an automation run.
- Attach a run id when starting a code review.
- Keep existing tables as feature-owned detail records; use `agent_runs` as the cross-feature index and evidence stream.

## Milestone 3: Agent Command Center

Build a proper workspace-level surface instead of only the current compact chat dropdown.

UI:

- Active runs list grouped by workspace, repository, source, and status.
- Status filters: queued, running, blocked, needs input, failed, completed, cancelled.
- Run detail panel with event timeline, linked work item, repo/branch/worktree, provider/model, files changed, commands, tests, and artifacts.
- Actions: open thread, open automation, open review, open repo, open worktree, stop/cancel, rerun.
- Provider-supported actions: steer, pause, resume, fork.

Implementation path:

- Add shared IPC methods for list, get, list events, list artifacts, and supported actions.
- Add renderer components under `src/renderer/components/agent-runs/`.
- Promote the sidebar activity center and chat "Runs" dropdown to use the same run detail route/panel.
- Keep controls disabled with plain reasons when the underlying provider or source cannot support them.

## Milestone 4: Work Item To Run Intake

Start runs from planning context.

Flow:

1. Select Linear, GitHub, Jira, Azure DevOps, or manual prompt.
2. Choose target repo and branch/worktree policy.
3. Choose mode: plan, implement, review, security, docs, handover.
4. Choose provider and model.
5. Attach acceptance criteria and validation checklist.
6. Start the run and persist source links.

Implementation:

- Add a run-start form that can be launched from Work Items and Agent Command Center.
- Reuse existing work item provider cache instead of adding another ticket abstraction with a tiny hat.
- Attach work-item metadata as links and run metadata.
- Produce an initial run event containing the selected constraints.

## Milestone 5: Evidence Packs

Generate compact, reviewable handover output from the run.

Pack contents:

- Original prompt or work item.
- Plan and major steering events.
- Files read and changed.
- Commands run.
- Tests and verification results.
- Browser/app evidence where present.
- Security or dependency findings.
- Linked issue, branch, worktree, PR, automation, or review.
- Skipped checks and residual risk.

Implementation:

- Add `generateEvidencePack(runId)` service.
- Store generated packs as `agent_run_artifacts`.
- Make the pack reusable in handover text, PR descriptions, and review summaries.
- Add tests for evidence extraction and stable formatting.

## Milestone 6: Recurring Runs With State

Extend Automations from command scheduling into reusable agent run scheduling.

Add:

- Owner.
- Expiry.
- State journal.
- Last-seen cursor.
- Notification policy.
- Retained worktree policy.
- "Create recurring run from this successful run."

Implementation:

- Extend automation definition schema carefully.
- Keep backwards compatibility for command/script automations.
- Add a state-journal artifact or table linked to the recurring run.
- Surface stale, ownerless, or expired runs clearly.

## Milestone 7: PR Follow-Through

Wire completed runs into draft PR creation and review loops.

First version:

- Create a draft PR from a completed run.
- Use the evidence pack as the PR body source.
- Link the PR back to the run.
- Start a follow-up run from failed checks or review comments.

Out of scope for v1:

- Auto-merge.
- Silent branch pushes.
- Provider-specific PR magic that bypasses Anvil evidence.

## Milestone 8: Provider Metadata And Adapters

Track provider behavior without making the UI vendor-shaped.

Add:

- Provider.
- Model.
- Session/thread ids.
- Context size where available.
- Duration.
- Cost estimate where available.
- Rate-limit or quota warnings where available.

Provider order:

1. Codex, because Anvil already has the deepest integration.
2. Claude, behind the same run contract.
3. ACP-compatible agents if the contract proves useful in practice.

## Milestone 9: Cloud Sandbox Handoff

Some work should leave the laptop: long tests, isolated untrusted work, OS-specific work, or multi-agent sweeps.

First version:

- Add "handoff to Anvil Cloud Agent Sandbox" as an explicit run action.
- Require capability, secret, network, and TTL policy before handoff.
- Link local run and sandbox run evidence.
- Keep local review as the final authority.

## Documentation Plan

Do not publish the market review.

After implementation lands, update `anvil-website` with user-facing documentation only:

- Agent Runs overview.
- Agent Command Center usage.
- Starting runs from work items.
- Evidence packs and PR handoff.
- Recurring runs and ownership rules.
- Current limitations.

Keep the public docs focused on what exists, how to use it, and where the limits are. No competitor mentions, no roadmap confetti, no product-pamphlet nonsense.

## Suggested First Slice

Implement Milestones 1 and 2 first.

Acceptance criteria:

- New persisted run tables and migrations exist.
- Chat, automation, and code review can create or link an `agent_run`.
- Agent run events can be appended and listed.
- Existing recent-runs UI still works.
- New data is visible through IPC and preload.
- Focused service tests cover creation, listing, event ordering, completion, and legacy projection fallback.

Useful checks:

```bash
pnpm test -- src/main/services/__tests__/agent-run.service.test.ts
pnpm test -- src/main/services/__tests__/automation-persistence.service.test.ts
pnpm lint
pnpm build
```
