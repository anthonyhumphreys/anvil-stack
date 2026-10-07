import { describe, expect, it } from 'vitest';
import type { WorkspaceScaffoldSession } from '../../../../shared/types';
import { isRepoRemovalBlocked, repoUsedOutsideWorkspace } from '../RemoveRepoDialog';

function scaffold(status: WorkspaceScaffoldSession['status']): WorkspaceScaffoldSession {
  return {
    id: 's-1',
    workspaceId: 'w-1',
    rootPath: '/tmp',
    personaId: 'p-1',
    status,
    createdAt: '',
    updatedAt: '',
  };
}

describe('isRepoRemovalBlocked', () => {
  it('blocks removal while a scaffold session is active, syncing, or indexing', () => {
    expect(isRepoRemovalBlocked(scaffold('active'))).toBe(true);
    expect(isRepoRemovalBlocked(scaffold('syncing'))).toBe(true);
    expect(isRepoRemovalBlocked(scaffold('indexing'))).toBe(true);
  });

  it('allows removal with no session or a finished one', () => {
    expect(isRepoRemovalBlocked(null)).toBe(false);
    expect(isRepoRemovalBlocked(undefined)).toBe(false);
    expect(isRepoRemovalBlocked(scaffold('completed'))).toBe(false);
    expect(isRepoRemovalBlocked(scaffold('failed'))).toBe(false);
    expect(isRepoRemovalBlocked(scaffold('cancelled'))).toBe(false);
  });
});

describe('repoUsedOutsideWorkspace', () => {
  const usage = new Map<string, readonly string[]>([
    ['ws-a', ['repo-1', 'repo-2']],
    ['ws-b', ['repo-2']],
    ['ws-c', []],
  ]);

  it('detects references in other workspaces', () => {
    expect(repoUsedOutsideWorkspace('repo-2', usage, 'ws-a')).toBe(true);
  });

  it('ignores the workspace the repo is being removed from', () => {
    expect(repoUsedOutsideWorkspace('repo-1', usage, 'ws-a')).toBe(false);
  });

  it('returns false when the repo is not referenced anywhere else', () => {
    expect(repoUsedOutsideWorkspace('repo-9', usage, 'ws-a')).toBe(false);
    expect(repoUsedOutsideWorkspace('repo-1', new Map(), 'ws-a')).toBe(false);
  });
});
