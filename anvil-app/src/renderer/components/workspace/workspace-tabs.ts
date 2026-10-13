export type WorkspaceTab = 'overview' | 'repositories' | 'library';

export const WORKSPACE_TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'library', label: 'Library' },
];

/** Which workspace tab a URL shows. Library wins over a `repo` library filter. */
export function resolveWorkspaceTab(
  searchParams: URLSearchParams,
  routeRepoId: string | undefined,
): WorkspaceTab {
  if (searchParams.get('view') === 'library') return 'library';
  if (routeRepoId || searchParams.get('view') === 'repositories' || searchParams.has('repo')) {
    return 'repositories';
  }
  return 'overview';
}
