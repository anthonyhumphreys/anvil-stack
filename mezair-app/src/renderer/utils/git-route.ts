export type GitViewTab = 'changes' | 'pull_requests' | 'log' | 'branches';

export function readGitRoute(params: URLSearchParams): { repoId?: string; tab?: GitViewTab } {
  const repoId = params.get('repo') || undefined;
  const tab = params.get('tab');
  const validTab: GitViewTab | undefined =
    tab === 'changes' || tab === 'pull_requests' || tab === 'log' || tab === 'branches'
      ? tab
      : undefined;
  return { repoId, tab: validTab };
}

export function writeGitRoute(
  current: URLSearchParams,
  repoId: string,
  tab: GitViewTab,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set('repo', repoId);
  next.set('tab', tab);
  return next;
}
