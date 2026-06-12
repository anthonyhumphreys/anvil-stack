import {
  getCurrentBranch,
  branchExists,
  checkoutBranch,
  stashChanges,
  popStash,
  hasUncommittedChanges,
  autoCommit,
} from './git.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpikeState {
  workItemId: string;
  spikeBranch: string;
  originBranch: string;
  stashRef: string | null;
  intervalId: ReturnType<typeof setInterval>;
}

// ---------------------------------------------------------------------------
// In-memory state: repoPath → SpikeState
// ---------------------------------------------------------------------------

const activeSpikeStates = new Map<string, SpikeState>();

// ---------------------------------------------------------------------------
// sanitizeBranchName
// ---------------------------------------------------------------------------

/**
 * Returns `spike/<sanitized-id>`.
 *
 * Invalid git ref characters (`~`, `^`, `:`, `\`, `@{`, spaces, `..`) are
 * replaced with hyphens. Consecutive hyphens are collapsed, and leading /
 * trailing hyphens are trimmed.
 */
export function sanitizeBranchName(workItemId: string): string {
  let sanitized = workItemId
    // Multi-char sequences first so they produce a single hyphen
    .replace(/\.\./g, '-')
    .replace(/@\{/g, '-')
    // Single invalid chars
    .replace(/[~^: \\]/g, '-')
    // Collapse consecutive hyphens
    .replace(/-+/g, '-')
    // Trim leading / trailing hyphens
    .replace(/^-+|-+$/g, '');

  return `spike/${sanitized}`;
}

// ---------------------------------------------------------------------------
// setupSpikeBranch
// ---------------------------------------------------------------------------

const DRIFT_CHECK_INTERVAL_MS = 30_000;

/**
 * Prepares the repository for a BA spike session:
 * 1. Records the current (origin) branch.
 * 2. Stashes any uncommitted changes.
 * 3. Creates or checks out the `spike/<workItemId>` branch.
 * 4. Starts a 30 s drift-detection interval that calls `onDrift()` if the
 *    user has switched away from the spike branch.
 */
export async function setupSpikeBranch(
  repoPath: string,
  workItemId: string,
  onDrift: () => void,
): Promise<SpikeState> {
  const originBranch = await getCurrentBranch(repoPath);
  const spikeBranch = sanitizeBranchName(workItemId);

  // Stash uncommitted changes before switching branches
  const stashRef = await stashChanges(repoPath);

  // Create or checkout the spike branch
  const exists = await branchExists(repoPath, spikeBranch);
  await checkoutBranch(repoPath, spikeBranch, !exists);

  // Start drift-detection interval
  const intervalId = setInterval(async () => {
    const current = await getCurrentBranch(repoPath);
    if (current !== spikeBranch) {
      onDrift();
    }
  }, DRIFT_CHECK_INTERVAL_MS);

  const state: SpikeState = { workItemId, spikeBranch, originBranch, stashRef, intervalId };
  activeSpikeStates.set(repoPath, state);
  return state;
}

// ---------------------------------------------------------------------------
// teardownSpikeBranch
// ---------------------------------------------------------------------------

/**
 * Cleans up after a BA spike session:
 * 1. Auto-commits any remaining WIP on the spike branch.
 * 2. Checks out the origin branch.
 * 3. Pops the stash (if one was created during setup).
 * 4. Clears the drift-detection interval and removes the spike state.
 */
export async function teardownSpikeBranch(repoPath: string, _workItemId: string): Promise<void> {
  const state = activeSpikeStates.get(repoPath);
  if (!state) return;

  // Stop drift detection
  clearInterval(state.intervalId);

  // Auto-commit WIP if the repo is dirty
  const dirty = await hasUncommittedChanges(repoPath);
  if (dirty) {
    await autoCommit(repoPath, `WIP: BA spike session auto-commit [${state.workItemId}]`);
  }

  // Return to the origin branch
  await checkoutBranch(repoPath, state.originBranch);

  // Restore previously stashed changes
  await popStash(repoPath);

  // Remove the tracked state
  activeSpikeStates.delete(repoPath);
}

// ---------------------------------------------------------------------------
// isOnSpikeBranch
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the repository's current branch matches the stored spike
 * branch. Returns `false` when there is no active spike or the user has
 * drifted away.
 */
export async function isOnSpikeBranch(repoPath: string): Promise<boolean> {
  const state = activeSpikeStates.get(repoPath);
  if (!state) return false;

  const current = await getCurrentBranch(repoPath);
  return current === state.spikeBranch;
}

// ---------------------------------------------------------------------------
// getActiveSpikeState
// ---------------------------------------------------------------------------

/**
 * Returns the `SpikeState` for a repo, or `null` if none is active.
 */
export function getActiveSpikeState(repoPath: string): SpikeState | null {
  return activeSpikeStates.get(repoPath) ?? null;
}

// ---------------------------------------------------------------------------
// cleanupAllSpikes
// ---------------------------------------------------------------------------

/**
 * Clears all drift-detection intervals. Call this on app quit to avoid
 * dangling timers.
 */
export function cleanupAllSpikes(): void {
  for (const state of activeSpikeStates.values()) {
    clearInterval(state.intervalId);
  }
  activeSpikeStates.clear();
}
