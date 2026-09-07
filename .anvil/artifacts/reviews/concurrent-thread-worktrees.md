# Concurrent threads and worktrees

Reviewed from `main` at `01cea7e`, in `feature/worktrees--concurrent-thread-isolation`.

Ordinary chat threads are not isolated. Separate provider sessions still use the same registered checkout. Worktree support exists for automations, BA spikes, and review verification, but thread-owned checkout selection and recovery are missing. The fixes in this branch improve existing worktree safety; they do not complete ordinary-thread isolation.

## Open findings

### High: concurrent threads share files, index, and branch

`anvil-app/src/main/ipc/chat.ipc.ts:154` resolves every thread's repository IDs through `repos.path`. `src/main/services/codex-session.service.ts:778` chooses those paths' common parent as the working directory. `src/shared/types.ts:688` has provider-thread identity but no checkout binding.

Two coder threads targeting the same repository can overwrite the same file, stage each other's edits, or switch the branch under an active turn. Git's index lock only serializes individual Git operations. It does not isolate a sequence of agent edits and commands.

Resume and provider fork also use freshly resolved repository paths, at `src/main/ipc/chat.ipc.ts:285` and `src/main/services/codex-session.service.ts:296`. Creating a worktree manually during a conversation does not persist a checkout selection for later sessions.

### High: changing the agent cwd alone leaves other operations on the original checkout

All following paths are relative to `anvil-app/`:

- Git status, staging, discard, commit, and branch actions resolve only a repository ID in `src/main/ipc/git.ipc.ts:24`.
- Chat prompt construction omits the existing repository-path override argument in `src/main/services/codex-session.service.ts:155`. `src/main/services/persona.service.ts:266` consequently advertises the registered checkout, including for worktree-backed BA sessions.
- File mentions scan the registered path in `src/main/services/chat-file-mention.service.ts:105`.
- The terminal panel supplies `repo.path` in `src/renderer/components/terminal/TerminalPanel.tsx:197`.
- Workflow execution also resolves registered repository paths in `src/main/services/workflow.service.ts:391` and `:549`.

A thread checkout must be a shared application concept. Setting cwd in one session handler would leave users viewing or changing a different checkout through other controls.

### High: canvas records are thread-specific, but repository filenames are shared

`anvil-app/src/main/services/chat-artifact.service.ts:295` looks up records by thread ID and relative path. Its filesystem writer at line 168 uses only repository ID and relative path.

Two threads writing the same artifact name overwrite the same physical file while retaining separate database records. A manually created worktree does not redirect these writes. Existing symlink/path traversal checks should remain when checkout-aware resolution is introduced.

### Medium: automation setup can lose track of partial creation

`anvil-app/src/main/services/automation.service.ts:322` builds paths from a sanitized repository name. Distinct repositories with matching names can collide within one run. Setup accumulates worktrees locally and returns only after all repositories succeed, at line 333. The caller assigns and persists them at line 668.

If a later repository fails, earlier worktrees remain on disk without reaching the run's persisted worktree list. Partial cleanup can also leave persisted retention flags inaccurate. Use repository IDs in paths, record each successful creation, and track each successful removal.

## Fixes delivered

- Both repository scanners recognize `.git` files, allowing selected or nested linked worktrees to be discovered.
- Worktree creation uses `git worktree add -b`. Existing branches cause an error instead of being reset with `-B`.
- Worktree removal no longer forces deletion. Git can reject dirty or locked checkouts.
- Automation cleanup no longer recursively deletes the run directory containing sibling repository worktrees or suppresses removal errors.
- Review verification reports retained worktree paths when cleanup fails, including when command discovery returns no commands.

## Requirements for first-class thread support

1. Persist a checkout binding for every thread/repository pair, including canonical repository identity, path, branch, base commit, and whether Anvil owns it. Keep repository identity separate from checkout identity.
2. Offer an isolated worktree for new coding threads and an explicit shared-checkout choice. Preserve existing threads' work. Do not silently move dirty edits or change existing conversations' execution paths.
3. Resolve agent cwd, prompt paths, writable roots, Git actions, terminals, mentions, file access, and artifacts through the same binding. For multiple repositories, expose the intended roots rather than an arbitrary common ancestor.
4. Reuse and validate bindings on resume. If a worktree is missing or its branch has changed, surface recovery instead of falling back to the original checkout. Define fork semantics explicitly, including whether uncommitted source-thread changes are copied.
5. Show checkout path, branch, ownership, and other active users of a shared checkout. Retain worktrees across stop/restart and thread deletion until their work has been handled. Check active usage, dirty/ignored files, and unmerged commits before intentional disposal.
6. Keep locks narrow. Serialize operations that mutate shared repository metadata where needed, and protect each checkout's application-managed Git operations. Worktrees isolate working files and indexes, not repository refs, configuration, external services, or arbitrary filesystem access.

Acceptance checks must cover two live coding threads editing the same filename; stop/restart/resume; concurrent starts for one thread; forks; missing/locked/dirty worktrees; identical repository names; partial setup/cleanup; and correct checkout targeting through every listed application control. Agent-created commits and canvas artifacts must remain recoverable.

## Verification

- `pnpm test`: 108 test files, 595 tests passed.
- Focused Git, spike, review, and new worktree tests: 37 passed.
- ESLint and Prettier checks passed for every changed TypeScript file.
- `git diff --check` passed.

The new real-Git tests cover concurrent worktree creation and independent edits/indexes, source-checkout preservation, branch-collision preservation, dirty/locked removal refusal, sibling survival, and synchronous/asynchronous discovery.

No live Electron or provider-session concurrency test was performed. The application-routing findings are based on source inspection. Ordinary-thread isolation, artifact collision prevention, and automation partial-failure recovery remain open.
