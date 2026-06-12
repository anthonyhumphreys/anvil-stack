---
title: Git workflows
navTitle: Git
description: Branch management, diff review, commit preparation, and PR handover from inside Anvil Desktop.
product: Anvil Desktop
section: Working guide
order: 113
---

# Git workflows

Anvil Desktop keeps Git operations close to the workspace so context does not leak across applications.

## Repository indexing

Before Git operations are useful, the repository must be indexed:

1. Add a local checkout to the workspace.
2. Anvil scans the repo for modules, languages, and architecture context.
3. Module summaries are stored in SQLite for fast chat context lookup.

Indexing is not a full text search index. It is a structural summary: entry points, dependency graph, test locations, and notable files.

## Branch and status

The Git view shows:

- Current branch and tracking status.
- Modified, staged, and untracked files.
- Ahead/behind counts.
- Recent commit history.

Operations available:

- Checkout existing branches.
- Create new branches.
- Stage and unstage files.
- Commit with a message.
- Push and pull.
- Fetch remote updates.
- View diffs for modified files.

## Diff review

Anvil Desktop diffs are rendered with syntax highlighting and inline change markers. Use them before committing or during code review sessions.

Diff review workflow:

1. Select the file or files to review.
2. Inspect the delta with line numbers and context.
3. Open related files in the embedded editor if the change needs amendment.
4. Add review findings in a code review session.
5. Stage fixes and rerun the diff.

## Commit preparation

Good commits survive longer than good intentions. Anvil Desktop suggests:

- Keep commits scoped to one concern.
- Include test changes in the same commit as the code they test.
- Write commit messages that explain why, not just what.
- Separate mechanical changes (formatting, renaming) from behavioural changes.

The chat assistant can draft a commit message from the staged diff. Review it before accepting; models are optimistic about refactor completeness.

## Pull request handover

When a branch is ready for review, Anvil Desktop can prepare a handover pack:

- Change summary with file references.
- Test results and coverage notes.
- Security review findings if the change touched auth or data.
- Dependency changes with registry decisions.
- Unverified steps and residual risk.

The handover pack is stored in the workspace and can be copied into the PR description or shared with reviewers.

## Merge and rebase

Anvil Desktop supports merge and rebase operations:

- Merge: create a merge commit when the branch history should be preserved.
- Rebase: rewrite history for a linear history preference.

Resolve conflicts in the embedded editor or your external IDE. The terminal can run `git mergetool` if configured.

## Git provider integration

Anvil Desktop can list and clone remote repositories from:

- GitHub
- Azure DevOps

Provider tokens are stored encrypted in SQLite. The renderer never sees the raw token.

## Limitations

- Submodules are supported but not deeply integrated into the indexing model.
- Very large monorepos may slow down initial indexing.
- Git LFS files are tracked but their contents are not indexed for chat context.
- Signed commits and GPG handling depend on local Git configuration outside Anvil Desktop.

## Read next

- [Agent workflows](/docs/desktop/agent-workflows)
- [Code review and security](/docs/desktop/security-and-review)
- [Operating guide](/docs/desktop/operating-guide)
