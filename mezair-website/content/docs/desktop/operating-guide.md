---
title: Operating guide
navTitle: Operating guide
description: Set up a workspace, implement a change, review it and hand over the results in Mezair Desktop.
product: Mezair Desktop
section: Guides
journey: build
order: 210
---

# Operating guide

## Set up the workspace

1. Install and launch Mezair Desktop.
2. Choose a role to show the tools you use most.
3. Choose a primary agent for new chats, then activate any additional providers you want workflows to use. See [Chat, personas and models](/docs/desktop/chat-personas-and-llm) for provider setup and optional on-device helper models.
4. Connect delivery providers such as GitHub, Azure DevOps, Linear, Jira, Confluence, Notion, Draw.io, Figma, or Repobase.
5. Create a workspace.
6. Add and index local repositories.
7. Start a conversation in Chat.
8. Start read-only before asking for edits.

Ask Mezair to explain the current code path with file references before making edits. Check that it has found the right part of the code.

## Developer playbook: implement a scoped change

1. Open the workspace and confirm the target repo is indexed and on the right branch.
2. Open the work item or paste acceptance criteria into a new Mezair thread.
3. Ask for the current code path first.
4. Ask for the smallest safe implementation.
5. Review the diff in Git.
6. Run focused checks.
7. Run Code Review and Security if the change touches auth, data, permissions, payments, production workflows, dependencies, or release gates.
8. Prepare the PR handover with what changed, what passed, and what could not be verified.

## Keep more than one workspace moving

You can switch workspaces while a conversation or terminal is active. Use the sidebar activity centre to return to running work or a thread waiting for approval or input. When Mezair is in the background, desktop notifications can open the originating workspace and thread directly.

Closing a terminal tab stops that terminal process. Switching workspaces or hiding the terminal panel does not; Mezair reattaches to the process and replays its buffered output when you return.

## Review playbook

1. Inspect modified files and branch state.
2. Run code review with a correctness, regression, security, and test-coverage lens.
3. Separate blockers from preferences. Preferences should not be escalated as production incidents.
4. Fix blockers, rerun focused checks, and record residual risk.

## Business analyst playbook

1. Select the work item.
2. Start a BA session against the relevant indexed repo.
3. Compare acceptance criteria with current implementation behaviour.
4. Record questions, risks, dependencies, feasibility notes, and compliance gaps.
5. Create follow-up work where a finding needs ownership.

## Assurance playbook

Use Security for implementation risks, Dependencies for package risk, CI/CD for release gates, and Data and Compliance when the change touches personal data, retention, accessibility, audit, or policy.

Record skipped and unverified checks in the handover so the next person knows what still needs attention.
