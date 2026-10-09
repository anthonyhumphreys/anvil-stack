import { describe, expect, it } from 'vitest';
import { readGitRoute, writeGitRoute } from '../git-route';

describe('Git route state', () => {
  it('restores the requested repository and every supported tab', () => {
    for (const tab of ['changes', 'pull_requests', 'log', 'branches'] as const) {
      expect(readGitRoute(new URLSearchParams(`repo=repo-1&tab=${tab}`))).toEqual({
        repoId: 'repo-1',
        tab,
      });
    }
  });

  it('writes repo and tab together so later navigation does not restore stale state', () => {
    const route = writeGitRoute(
      new URLSearchParams('repo=old-repo&tab=pull_requests&keep=value'),
      'repo 2',
      'changes',
    );
    expect(readGitRoute(route)).toEqual({ repoId: 'repo 2', tab: 'changes' });
    expect(route.get('keep')).toBe('value');
  });

  it('ignores unknown tabs', () => {
    expect(readGitRoute(new URLSearchParams('repo=repo-1&tab=unknown'))).toEqual({
      repoId: 'repo-1',
    });
  });
});
