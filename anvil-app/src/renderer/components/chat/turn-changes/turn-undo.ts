import type { GitDiffResult, GitStatusResult } from '../../../../shared/types';
import {
  evaluateTurnUndo,
  targetNeedsProbe,
  type TurnUndoEligibility,
  type TurnUndoPlan,
  type TurnUndoProbe,
} from '../chat-turn-changes';

/** The slice of `window.anvil.git` the undo check reads. */
export interface TurnUndoGitReader {
  status(repoId: string): Promise<GitStatusResult>;
  diff(repoId: string, filePath: string, staged: boolean): Promise<GitDiffResult>;
}

/**
 * Reads live git state for the plan's files and decides whether "Undo turn"
 * may discard them. Read-only: never mutates the working tree. Run it again
 * right before discarding so a change made after the first check still blocks.
 */
export async function loadTurnUndoEligibility(
  git: TurnUndoGitReader,
  repoId: string,
  plan: TurnUndoPlan,
): Promise<TurnUndoEligibility> {
  if (!plan.ok) return { eligible: false, reason: plan.reason };
  try {
    const status = await git.status(repoId);
    const probes = new Map<string, TurnUndoProbe>();
    await Promise.all(
      plan.targets
        .filter((target) => targetNeedsProbe(target, status.files))
        .map(async (target) => {
          const result = await git.diff(repoId, target.path, false);
          probes.set(target.path, {
            workingDiff: result.hunks,
            currentContent: result.newContent,
          });
        }),
    );
    return evaluateTurnUndo(plan, status.files, probes);
  } catch (err) {
    const detail = err instanceof Error && err.message ? ` ${err.message}` : '';
    return { eligible: false, reason: `Couldn't read the repository's changes.${detail}` };
  }
}
