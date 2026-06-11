---
title: Operating guide
navTitle: Operating guide
description: Set up Anvil Desktop and run delivery workflows with real evidence.
product: Anvil Desktop
section: Working guide
order: 110
---

# Operating guide

## Set up the workspace

1. Install and launch Anvil Desktop.
2. Choose a role so the navigation starts from the surfaces you actually use.
3. Configure AI execution through Codex CLI, OpenAI API, Azure AI Foundry, or local assists where available.
4. Connect delivery providers such as GitHub, Azure DevOps, Linear, Jira, Confluence, Notion, Draw.io, Figma, or Repobase.
5. Create a workspace.
6. Add and index local repositories.
7. Start read-only before asking for edits.

The read-only step is not ceremony. Ask Anvil to explain the current code path with file references before asking it to change code. Ambition is cheaper after context exists.

## Developer playbook: implement a scoped change

1. Open the workspace and confirm the target repo is indexed and on the right branch.
2. Open the work item or paste acceptance criteria into a new Anvil thread.
3. Ask for the current code path first.
4. Ask for the smallest safe implementation.
5. Review the diff in Git.
6. Run focused checks.
7. Run Code Review and Security if the change touches auth, data, permissions, payments, production workflows, dependencies, or release gates.
8. Prepare the PR handover with what changed, what passed, and what could not be verified.

## Review playbook

1. Inspect modified files and branch state.
2. Run code review with a correctness, regression, security, and test-coverage lens.
3. Separate blockers from preferences. Preferences are not production incidents in cosplay.
4. Fix blockers, rerun focused checks, and record residual risk.

## Business analyst playbook

1. Select the work item.
2. Start a BA session against the relevant indexed repo.
3. Compare acceptance criteria with current implementation behaviour.
4. Record questions, risks, dependencies, feasibility notes, and compliance gaps.
5. Create follow-up work where a finding needs ownership.

## Assurance playbook

Use Security for implementation risks, Dependencies for package risk, CI/CD for release gates, and Data and Compliance when the change touches personal data, retention, accessibility, audit, or policy.

Put unverified steps in the handover. Silence is not a test strategy.

