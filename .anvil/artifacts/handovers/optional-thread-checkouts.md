# Optional thread checkouts

Implemented on `feature/worktrees--concurrent-thread-isolation`, following the worktree safety review. Shared checkouts remain the default. This iteration adds optional worktrees for ordinary desktop chat threads.

## Using it

Open **Context → Checkouts** in the chat composer before starting a thread. For each selected repository, either use an existing checkout or create an isolated worktree with a new branch. The base defaults to `main`, then `origin/main` when available; another available local or remote branch can be selected explicitly.

Choosing an existing feature checkout shares its files, including uncommitted edits. Creating a worktree starts at the selected branch's committed revision. Neither action switches the original checkout's branch. The picker shows checkout paths, branches, and active threads; the thread subtitle also shows its selected branches.

Once a thread has messages or a provider session, its repository selection is fixed. Start a new thread to choose another checkout. Forks intentionally share their source thread's checkout. They do not create an isolated copy of uncommitted changes.

## How it works

Anvil already identifies registered repositories by checkout path. A worktree gets its own repository entry and workspace membership, while the thread stores that checkout's repository ID. Existing repo-scoped Git actions, terminals, file mentions, prompt context, and canvas writes therefore resolve the worktree path through their existing APIs. Other workspace panels still require selecting the corresponding repository entry; they do not automatically follow the chat tab.

Schema version 62 adds `thread_checkouts`, recording each thread's repository ID, source repository ID, checkout path, expected branch, base commit, and ownership. Existing threads retain their repository IDs. On their next start, Anvil records the current checkout without moving files or switching branches.

Startup and subsequent turns validate the binding. Missing checkouts, mismatched repository selections, and branch drift fail with a recovery message rather than falling back to the original checkout. Concurrent starts or checkout setup for the same thread are rejected. Git create/switch-branch and create-PR controls refuse to change the branch while a chat session uses the checkout. External Git commands remain outside those application guards.

For multi-repository sessions, the first selected checkout supplies cwd, and workspace-write turns name the selected repository paths as writable roots. Prompt path overrides also correct the pre-existing BA worktree prompt mismatch.

Worktrees remain on disk when threads are deleted. Failed creation/registration reports the retained path. No automatic worktree deletion or branch reset was added. New checkout entries are connected but not automatically indexed; repository analysis can be run explicitly.

Repository canvas writes reject paths already owned by another thread in the same checkout. Separate worktrees can use the same relative artifact name. File-reference artifacts can still refer to an existing file without overwriting it.

## Verification

- Full suite: 111 files and 614 tests passed.
- Production Electron build passed.
- ESLint passed for the changed services, IPC handlers, renderer components, and new tests.
- Main-process and renderer typechecks still report the same diagnostics as pre-change commit `b94d9f5`; no new diagnostic locations/codes were introduced.
- Real-Git tests cover simultaneous independent creation, shared feature-checkout reuse, branch bases/collisions, same-thread setup races, missing paths, branch drift, symlink identity, fork retention, migration, and canvas targeting/collisions.
- Session-start and Git IPC tests cover duplicate starts and refusing branch changes while occupied.
- Native Electron UI verification used a disposable profile and Git fixture. Creating a worktree through the picker succeeded, the selected branch/path appeared, and the choice survived a full renderer reload. The new picker had no mechanical design-detector findings.

## Remaining limits

No live concurrent provider conversation was stress-tested. Worktrees provide separate files and indexes, not a security boundary against an agent with full filesystem access. Review/Plan behaviour still follows existing provider and persona policies.

Worktree disposal and recovery remain manual. This iteration retains the original review's separate automation issues: same-name repository path collisions and persistence of partially created/removed automation worktrees. They are not part of the new thread checkout service.
