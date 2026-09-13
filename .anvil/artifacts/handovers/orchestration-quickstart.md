# Agent orchestration

## Configure a team

1. Open Automate → Workflows and choose Delivery team, Review committee, or Architecture debate.
2. Open Orchestration. Configure each specialist's persona, provider, model, reasoning, and capabilities.
3. Select a graph node. Choose single-agent execution, map/reduce, independent review, debate, or autonomous delegation.
4. Assign the permitted specialists and set runtime limits.
5. Save and enter a kickoff. Starting saves the current configuration first.

Autonomous coordinators choose tasks and profiles from the approved pool. Specialists can delegate recursively. Anvil displays their work as graph nodes and returns their handoffs for synthesis.

## Inspect and intervene

Select a node to inspect its output, attempts, provider settings, and thread links. The execution timeline explains dispatch, delegation, failure, and decisions.

Pause stops new dispatch while active attempts finish. Cancellation stops managed execution. Failed or interrupted work requires inspection and an explicit retry. Human gates preserve acceptance or rejection and the accompanying note.

## Automate it

Select a saved template in an automation's Workflow execution field. Schedules and Watchtower launch the graph in automation worktrees.

Workflow mode requires write and command permissions and replaces persona-loop execution. Open the resulting graph from the automation run. Worktrees remain available when a human decision pauses execution.

Automation-generated workflow events do not trigger another automation, preventing unattended feedback loops.

## Limits and remaining work

Defaults are one concurrent agent, 64 nodes, depth three, three attempts per agent, 30 minutes, and 12,000 handoff characters. Pauses count toward elapsed time.

Agents share a run workspace. Increase concurrency only for separated edit scopes. Automatic branch integration is not implemented.

Limits cover Anvil-managed nodes. Provider-native delegation remains instruction-controlled. Handoffs are agent reports, not snapshot-bound verification evidence. Hard token/currency budgets, quorum voting, and nested saved-workflow invocation remain future work.

## Verification

619 tests pass across 110 files. Production build and lint pass. Repository-wide TypeScript checks retain unrelated errors.

Isolated Electron verification covered team persistence, navigation, human acceptance, resume, completion, and decision history. Cross-provider and recursive scheduling were tested with controlled workers; a paid multi-provider end-to-end run was not performed.

![Team configuration](../reviews/orchestration/team-configuration.png)

![Human acceptance](../reviews/orchestration/human-acceptance.png)