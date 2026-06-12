import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock git helper functions from git.service.ts
// ---------------------------------------------------------------------------
vi.mock('../git.service.js', () => ({
  getCurrentBranch: vi.fn(),
  branchExists: vi.fn(),
  checkoutBranch: vi.fn(),
  stashChanges: vi.fn(),
  popStash: vi.fn(),
  hasUncommittedChanges: vi.fn(),
  autoCommit: vi.fn(),
}));

import {
  sanitizeBranchName,
  setupSpikeBranch,
  teardownSpikeBranch,
  isOnSpikeBranch,
  getActiveSpikeState,
  cleanupAllSpikes,
} from '../spike-guard.service.js';

import {
  getCurrentBranch,
  branchExists,
  checkoutBranch,
  stashChanges,
  popStash,
  hasUncommittedChanges,
  autoCommit,
} from '../git.service.js';

// ---------------------------------------------------------------------------
// sanitizeBranchName
// ---------------------------------------------------------------------------

describe('sanitizeBranchName', () => {
  it('prepends spike/ prefix to a clean work item id', () => {
    expect(sanitizeBranchName('TASK-123')).toBe('spike/TASK-123');
  });

  it('handles numeric-only ids', () => {
    expect(sanitizeBranchName('12345')).toBe('spike/12345');
  });

  it('handles another clean id format', () => {
    expect(sanitizeBranchName('ENG-456')).toBe('spike/ENG-456');
  });

  it('replaces spaces with hyphens', () => {
    expect(sanitizeBranchName('my task')).toBe('spike/my-task');
  });

  it('replaces ~ with a hyphen', () => {
    expect(sanitizeBranchName('a~b')).toBe('spike/a-b');
  });

  it('replaces ^ with a hyphen', () => {
    expect(sanitizeBranchName('a^b')).toBe('spike/a-b');
  });

  it('replaces : with a hyphen', () => {
    expect(sanitizeBranchName('a:b')).toBe('spike/a-b');
  });

  it('replaces .. with a hyphen', () => {
    expect(sanitizeBranchName('a..b')).toBe('spike/a-b');
  });

  it('replaces @{ with a hyphen', () => {
    expect(sanitizeBranchName('a@{b')).toBe('spike/a-b');
  });

  it('collapses consecutive hyphens from multiple invalid chars', () => {
    expect(sanitizeBranchName('a~~b')).toBe('spike/a-b');
  });

  it('trims leading hyphens', () => {
    expect(sanitizeBranchName('~start')).toBe('spike/start');
  });

  it('trims trailing hyphens', () => {
    expect(sanitizeBranchName('end~')).toBe('spike/end');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle tests
// ---------------------------------------------------------------------------

const REPO = '/repo/test';

beforeEach(() => {
  vi.clearAllMocks();
  cleanupAllSpikes();
});

afterEach(() => {
  vi.useRealTimers();
  cleanupAllSpikes();
});

describe('setupSpikeBranch', () => {
  it('creates a new branch when it does not exist', async () => {
    vi.mocked(stashChanges).mockResolvedValue(null);
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(checkoutBranch).mockResolvedValue(undefined);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');

    await setupSpikeBranch(REPO, 'TASK-1', vi.fn());

    expect(branchExists).toHaveBeenCalledWith(REPO, 'spike/TASK-1');
    expect(checkoutBranch).toHaveBeenCalledWith(REPO, 'spike/TASK-1', true);
  });

  it('checks out an existing spike branch without creating', async () => {
    vi.mocked(stashChanges).mockResolvedValue(null);
    vi.mocked(branchExists).mockResolvedValue(true);
    vi.mocked(checkoutBranch).mockResolvedValue(undefined);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');

    await setupSpikeBranch(REPO, 'TASK-2', vi.fn());

    expect(checkoutBranch).toHaveBeenCalledWith(REPO, 'spike/TASK-2', false);
  });

  it('stashes uncommitted changes before switching branch', async () => {
    vi.mocked(stashChanges).mockResolvedValue('stash@{0}');
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(checkoutBranch).mockResolvedValue(undefined);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');

    await setupSpikeBranch(REPO, 'TASK-3', vi.fn());

    expect(stashChanges).toHaveBeenCalledWith(REPO);
    // stash is called before checkout
    const stashOrder = vi.mocked(stashChanges).mock.invocationCallOrder[0];
    const checkoutOrder = vi.mocked(checkoutBranch).mock.invocationCallOrder[0];
    expect(stashOrder).toBeLessThan(checkoutOrder);
  });

  it('records the active spike state after setup', async () => {
    vi.mocked(stashChanges).mockResolvedValue(null);
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(checkoutBranch).mockResolvedValue(undefined);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');

    await setupSpikeBranch(REPO, 'TASK-4', vi.fn());

    const state = getActiveSpikeState(REPO);
    expect(state).not.toBeNull();
    expect(state?.spikeBranch).toBe('spike/TASK-4');
  });

  it('fires drift callback when branch changes externally', async () => {
    vi.useFakeTimers();

    vi.mocked(stashChanges).mockResolvedValue(null);
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(checkoutBranch).mockResolvedValue(undefined);
    // First call (during setup) returns the spike branch; subsequent calls drift
    vi.mocked(getCurrentBranch).mockResolvedValueOnce('main').mockResolvedValue('main'); // used inside interval

    const onDrift = vi.fn();
    await setupSpikeBranch(REPO, 'TASK-5', onDrift);

    // Simulate drift: branch is no longer the spike branch
    vi.mocked(getCurrentBranch).mockResolvedValue('main');

    await vi.advanceTimersByTimeAsync(30_000);

    expect(onDrift).toHaveBeenCalled();
  });
});

describe('teardownSpikeBranch', () => {
  it('auto-commits WIP, checks out origin branch, and pops stash', async () => {
    // Setup first
    vi.mocked(stashChanges).mockResolvedValue('stash@{0}');
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(checkoutBranch).mockResolvedValue(undefined);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    await setupSpikeBranch(REPO, 'TASK-6', vi.fn());

    // Now teardown
    vi.mocked(hasUncommittedChanges).mockResolvedValue(true);
    vi.mocked(autoCommit).mockResolvedValue(undefined);
    vi.mocked(checkoutBranch).mockResolvedValue(undefined);
    vi.mocked(popStash).mockResolvedValue(undefined);

    await teardownSpikeBranch(REPO, 'TASK-6');

    expect(autoCommit).toHaveBeenCalledWith(REPO, expect.any(String));
    expect(checkoutBranch).toHaveBeenLastCalledWith(REPO, 'main');
    expect(popStash).toHaveBeenCalledWith(REPO);
  });

  it('skips auto-commit when repo is clean', async () => {
    // Setup first
    vi.mocked(stashChanges).mockResolvedValue(null);
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(checkoutBranch).mockResolvedValue(undefined);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    await setupSpikeBranch(REPO, 'TASK-7', vi.fn());

    // Teardown with clean repo
    vi.mocked(hasUncommittedChanges).mockResolvedValue(false);
    vi.mocked(checkoutBranch).mockResolvedValue(undefined);
    vi.mocked(popStash).mockResolvedValue(undefined);

    await teardownSpikeBranch(REPO, 'TASK-7');

    expect(autoCommit).not.toHaveBeenCalled();
    expect(checkoutBranch).toHaveBeenCalledWith(REPO, 'main');
  });

  it('clears the spike state after teardown', async () => {
    vi.mocked(stashChanges).mockResolvedValue(null);
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(checkoutBranch).mockResolvedValue(undefined);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    await setupSpikeBranch(REPO, 'TASK-8', vi.fn());

    vi.mocked(hasUncommittedChanges).mockResolvedValue(false);
    vi.mocked(popStash).mockResolvedValue(undefined);

    await teardownSpikeBranch(REPO, 'TASK-8');

    expect(getActiveSpikeState(REPO)).toBeNull();
  });
});

describe('isOnSpikeBranch', () => {
  it('returns true when current branch matches the stored spike branch', async () => {
    vi.mocked(stashChanges).mockResolvedValue(null);
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(checkoutBranch).mockResolvedValue(undefined);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    await setupSpikeBranch(REPO, 'TASK-9', vi.fn());

    vi.mocked(getCurrentBranch).mockResolvedValue('spike/TASK-9');
    expect(await isOnSpikeBranch(REPO)).toBe(true);
  });

  it('returns false when no spike is active', async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    expect(await isOnSpikeBranch(REPO)).toBe(false);
  });

  it('returns false when current branch does not match', async () => {
    vi.mocked(stashChanges).mockResolvedValue(null);
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(checkoutBranch).mockResolvedValue(undefined);
    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    await setupSpikeBranch(REPO, 'TASK-10', vi.fn());

    vi.mocked(getCurrentBranch).mockResolvedValue('main');
    expect(await isOnSpikeBranch(REPO)).toBe(false);
  });
});
