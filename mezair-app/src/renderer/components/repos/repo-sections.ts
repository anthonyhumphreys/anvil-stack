import {
  isRepoHealthTab,
  type RepoDetailSection,
  type RepoHealthTab,
} from '../../utils/sidebar-navigation';

export const REPO_SECTIONS: Array<{ id: RepoDetailSection; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'health', label: 'Health' },
  { id: 'setup', label: 'Setup' },
];

export const HEALTH_HINT_LABELS: Record<RepoHealthTab, string> = {
  security: 'security history',
  dependencies: 'dependencies',
  cicd: 'CI/CD pipelines',
};

/**
 * Which repo-detail section a URL shows, plus the "open this section once a
 * repo is picked" hint used by redirects from removed destinations (§12).
 */
export function resolveRepoSection(
  routeSection: string | undefined,
  routeTab: string | undefined,
  searchParams: URLSearchParams,
): {
  section: RepoDetailSection;
  tab?: RepoHealthTab;
  hint: { section: Exclude<RepoDetailSection, 'overview'>; tab?: RepoHealthTab } | null;
} {
  const section: RepoDetailSection =
    routeSection === 'health' || routeSection === 'setup' ? routeSection : 'overview';
  const hintSection = searchParams.get('section');
  const hintTab = searchParams.get('tab');
  const hint =
    hintSection === 'health' || hintSection === 'setup'
      ? {
          section: hintSection as Exclude<RepoDetailSection, 'overview'>,
          tab: hintSection === 'health' && isRepoHealthTab(hintTab) ? hintTab : undefined,
        }
      : null;
  return { section, tab: isRepoHealthTab(routeTab) ? routeTab : undefined, hint };
}

/** The requested Health tab if the role can use it, else the first allowed one. */
export function resolveRepoHealthTab(
  requested: string | undefined,
  available: readonly RepoHealthTab[],
): RepoHealthTab | null {
  if (requested && (available as readonly string[]).includes(requested)) {
    return requested as RepoHealthTab;
  }
  return available[0] ?? null;
}
