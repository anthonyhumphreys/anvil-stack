# Unified Agent Work View

## Recommendation

Replace the separate `Agents` and `Runs` controls with one `Work` control.

The surface should answer three questions:

1. What is running?
2. How has the work been divided?
3. What happened?

Use one execution model:

- **Run**: the user-requested unit of work.
- **Agent**: a participant in that run.
- **Subagent**: an agent with a parent agent.
- **Turn**: one prompt/response interaction belonging to an agent.
- **Event**: tool use, file edit, command, approval, status, or handoff.
- **Outcome**: summary, changed files, tests, errors, and artifacts.

This avoids the present situation where “Agents” and “Runs” sound like separate product concepts but are mostly live and historical projections of the same thing. Two popovers have been shipped where one coherent model was required. A classic.

## Information architecture

### Composer toolbar

Replace:

- Runs
- Agents

With:

- **Work · 3 active**

Opening it shows a compact workspace-wide panel:

- Active
- Needs attention
- Recent

Each row includes:

- Prompt or run title
- Source: Chat, Automation, Review
- Current phase
- Elapsed time
- Agent count
- Changed files
- Attention state
- Stop action for active work

Selecting a row opens the full run inspector.

### Run inspector

Header:

- Run title and status
- Source and repository
- Started time and duration
- Model and parent reasoning level
- Stop, resume, open thread, or reveal worktree actions

Primary tabs:

1. **Overview**
2. **Agents**
3. **Transcript**
4. **Changes**
5. **Activity**

Overview contains:

- Current objective
- Outcome or latest progress
- Validation state
- Changed files
- Errors and approvals
- Artifacts
- Run configuration

Agents contains a tree: