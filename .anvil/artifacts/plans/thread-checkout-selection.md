Thread setup offers two choices:

- **Use existing checkout**: use its current branch and working files. Suitable for reviews, insight, and intentionally shared work. Show the branch and other active threads. Review sessions should use read-only execution.
- **Use isolated worktree**: create a separate checkout and feature branch. Default the base to main, with an explicit option to branch from an existing feature branch.

If the desired feature branch already has a worktree, offer to use that checkout. Joining it means sharing its files with any threads already using it. For independent work, create another branch from it.

Never automatically switch an occupied checkout's branch. Git normally prevents checking out the same branch in multiple worktrees.

Persist the chosen checkout per thread and reuse it on resume. Git actions, terminals, file mentions, prompts, and canvas artifacts must all follow that choice.

Keep existing threads on their current checkout. Worktree creation remains an explicit option.