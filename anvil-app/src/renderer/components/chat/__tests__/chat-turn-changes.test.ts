import { describe, expect, it } from 'vitest';
import type { CodexEvent, RepoInfo } from '../../../../shared/types';
import type { ChatTurnWorkItem } from '../chat-turns';
import {
  collectTurnFileChanges,
  countDiffStats,
  formatTurnChangeSummary,
  repoRelativePath,
  resolveChangesRepoId,
  summarizeTurnChanges,
} from '../chat-turn-changes';

function workItem(event: CodexEvent, sourceIndex = 0): ChatTurnWorkItem {
  return { kind: 'event', event, sourceIndex };
}

function fileEdit(filePath: string, diff: string): CodexEvent {
  return { type: 'file_edit', filePath, diff } as CodexEvent;
}

const DIFF_A = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' line', '+added', '-removed'].join(
  '\n',
);

describe('collectTurnFileChanges', () => {
  it('deduplicates edits by path and concatenates diffs', () => {
    const items = [
      workItem(fileEdit('a.ts', DIFF_A)),
      workItem(fileEdit('b.ts', '')),
      workItem(fileEdit('a.ts', '+more')),
      workItem({ type: 'text', text: 'hi' } as CodexEvent),
    ];
    const files = collectTurnFileChanges(items);
    expect(files).toHaveLength(2);
    expect(files[0].filePath).toBe('a.ts');
    expect(files[0].editCount).toBe(2);
    expect(files[0].diff).toContain('added');
    expect(files[0].diff).toContain('more');
    expect(files[1].filePath).toBe('b.ts');
  });

  it('ignores non-file-edit events', () => {
    const items = [
      workItem({ type: 'command_exec', command: 'ls' } as CodexEvent),
      { kind: 'progress', content: 'working', sourceIndex: 1 } as ChatTurnWorkItem,
    ];
    expect(collectTurnFileChanges(items)).toHaveLength(0);
  });
});

describe('countDiffStats', () => {
  it('counts added and removed lines, ignoring headers', () => {
    const stats = countDiffStats(DIFF_A);
    expect(stats).toEqual({ additions: 1, deletions: 1 });
  });

  it('handles empty diffs', () => {
    expect(countDiffStats('')).toEqual({ additions: 0, deletions: 0 });
  });
});

describe('summarizeTurnChanges', () => {
  it('returns null when the turn changed no files', () => {
    expect(summarizeTurnChanges([workItem({ type: 'text', text: 'x' } as CodexEvent)])).toBeNull();
  });

  it('aggregates across files', () => {
    const summary = summarizeTurnChanges([
      workItem(fileEdit('a.ts', DIFF_A)),
      workItem(fileEdit('b.ts', '+x\n+y')),
    ]);
    expect(summary).not.toBeNull();
    expect(summary!.files).toHaveLength(2);
    expect(summary!.additions).toBe(3);
    expect(summary!.deletions).toBe(1);
    expect(formatTurnChangeSummary(summary!)).toBe('2 files changed · +3 −1');
  });

  it('uses the singular for one file', () => {
    const summary = summarizeTurnChanges([workItem(fileEdit('a.ts', DIFF_A))]);
    expect(formatTurnChangeSummary(summary!)).toBe('1 file changed · +1 −1');
  });
});

describe('resolveChangesRepoId', () => {
  const repos = [
    { id: 'r1', path: '/ws/one' },
    { id: 'r2', path: '/ws/two' },
  ] as RepoInfo[];

  it('prefers the thread repo when valid', () => {
    expect(resolveChangesRepoId(['/ws/two/x.ts'], repos, 'r1')).toBe('r1');
  });

  it('matches absolute file paths to the repo root', () => {
    expect(resolveChangesRepoId(['/ws/two/src/x.ts'], repos)).toBe('r2');
  });

  it('falls back to the first repo', () => {
    expect(resolveChangesRepoId(['relative/x.ts'], repos)).toBe('r1');
  });

  it('returns null without repos', () => {
    expect(resolveChangesRepoId(['x.ts'], [])).toBeNull();
  });
});

describe('repoRelativePath', () => {
  it('strips the repo root from absolute paths', () => {
    expect(repoRelativePath('/ws/one/src/a.ts', '/ws/one')).toBe('src/a.ts');
  });

  it('passes through already-relative paths', () => {
    expect(repoRelativePath('src/a.ts', '/ws/one')).toBe('src/a.ts');
  });

  it('rejects absolute paths outside the repo', () => {
    expect(repoRelativePath('/elsewhere/a.ts', '/ws/one')).toBeNull();
  });
});
