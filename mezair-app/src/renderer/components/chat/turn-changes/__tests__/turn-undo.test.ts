import { describe, expect, it, vi } from 'vitest';
import type { CodexEvent, GitDiffResult, GitStatusResult } from '../../../../../shared/types';
import { collectTurnFileChanges, planTurnUndo } from '../../chat-turn-changes';
import { nextFileListIndex } from '../file-list-navigation';
import { loadTurnUndoEligibility, type TurnUndoGitReader } from '../turn-undo';

const PATCH = '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new';

function plan(later?: string[]) {
  const files = collectTurnFileChanges([
    {
      kind: 'event',
      sourceIndex: 0,
      event: { type: 'file_edit', filePath: '/repo/a.ts', diff: PATCH } as CodexEvent,
    },
  ]);
  return planTurnUndo(files, '/repo', later);
}

function reader(
  status: GitStatusResult,
  hunks: string,
): TurnUndoGitReader & {
  diff: ReturnType<typeof vi.fn>;
} {
  return {
    status: vi.fn(async () => status),
    diff: vi.fn(async (_repoId: string, filePath: string): Promise<GitDiffResult> => ({
      filePath,
      oldContent: '',
      newContent: '',
      hunks,
    })),
  };
}

const STATUS: GitStatusResult = {
  branch: 'main',
  ahead: 0,
  behind: 0,
  files: [{ path: 'a.ts', status: 'modified', staged: false }],
};

describe('loadTurnUndoEligibility', () => {
  it('probes the unstaged diff and allows an exact match', async () => {
    const git = reader(STATUS, `diff --git a/a.ts b/a.ts\n${PATCH}`);
    await expect(loadTurnUndoEligibility(git, 'r1', plan())).resolves.toEqual({
      eligible: true,
      paths: ['a.ts'],
    });
    expect(git.diff).toHaveBeenCalledWith('r1', 'a.ts', false);
  });

  it('skips git entirely when the static plan already blocks', async () => {
    const git = reader(STATUS, PATCH);
    const result = await loadTurnUndoEligibility(git, 'r1', plan(['a.ts']));
    expect(result).toMatchObject({ eligible: false });
    expect(git.status).not.toHaveBeenCalled();
  });

  it('reports git failures as a reason instead of throwing', async () => {
    const git: TurnUndoGitReader = {
      status: async () => {
        throw new Error('not a git repository');
      },
      diff: async () => {
        throw new Error('unreachable');
      },
    };
    await expect(loadTurnUndoEligibility(git, 'r1', plan())).resolves.toEqual({
      eligible: false,
      reason: "Couldn't read the repository's changes. not a git repository",
    });
  });
});

describe('nextFileListIndex', () => {
  it('moves within bounds and ignores other keys', () => {
    expect(nextFileListIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextFileListIndex('ArrowDown', 2, 3)).toBe(2);
    expect(nextFileListIndex('ArrowUp', 0, 3)).toBe(0);
    expect(nextFileListIndex('Home', 2, 3)).toBe(0);
    expect(nextFileListIndex('End', 0, 3)).toBe(2);
    expect(nextFileListIndex('Enter', 0, 3)).toBeNull();
    expect(nextFileListIndex('ArrowDown', 0, 0)).toBeNull();
  });
});
