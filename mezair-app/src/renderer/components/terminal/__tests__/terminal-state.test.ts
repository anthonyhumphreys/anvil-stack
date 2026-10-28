import { describe, expect, it } from 'vitest';
import { closeTerminalRepo, selectTerminalRepo } from '../terminal-state';

describe('workspace terminal state', () => {
  it('keeps each workspace selection and opened repositories independent', () => {
    const workspaceA = selectTerminalRepo({ activeRepoId: null, createdRepoIds: [] }, 'repo-a');
    const workspaceB = selectTerminalRepo({ activeRepoId: null, createdRepoIds: [] }, 'repo-b');

    expect(workspaceA).toEqual({ activeRepoId: 'repo-a', createdRepoIds: ['repo-a'] });
    expect(workspaceB).toEqual({ activeRepoId: 'repo-b', createdRepoIds: ['repo-b'] });
  });

  it('stops a terminal without losing the selected repository', () => {
    const state = closeTerminalRepo(
      { activeRepoId: 'repo-a', createdRepoIds: ['repo-a', 'repo-b'] },
      'repo-a',
    );

    expect(state).toEqual({ activeRepoId: 'repo-a', createdRepoIds: ['repo-b'] });
  });
});
