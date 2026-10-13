import { lazy, Suspense, useCallback } from 'react';
import { Loader2, MessageSquare, ShieldOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Feature, RepoInfo } from '../../../shared/types';
import { chatPromptPath, repoDetailPath, type RepoHealthTab } from '../../utils/sidebar-navigation';
import { Button } from '../ui';
import { EmptyState } from '../layout/ViewScaffold';
import { ViewTabs, type ViewTab } from '../library/ViewTabs';
import { isFeatureAllowed, useAllowedFeatures } from '../library/useAllowedFeatures';
import { resolveRepoHealthTab } from './repo-sections';

const SecurityView = lazy(() =>
  import('../security/SecurityView').then((module) => ({ default: module.SecurityView })),
);
const DependenciesView = lazy(() =>
  import('../dependencies/DependenciesView').then((module) => ({
    default: module.DependenciesView,
  })),
);
const CicdView = lazy(() =>
  import('../cicd/CicdView').then((module) => ({ default: module.CicdView })),
);

export const REPO_HEALTH_TAB_DEFINITIONS: Array<
  ViewTab<RepoHealthTab> & { feature: Feature; askPrompt: (repo: RepoInfo) => string }
> = [
  {
    id: 'security',
    label: 'Security',
    feature: 'security',
    askPrompt: (repo) =>
      `Run a security audit of the ${repo.name} repository (${repo.path}). Report concrete findings with severity, evidence, and fixes.`,
  },
  {
    id: 'dependencies',
    label: 'Dependencies',
    feature: 'dependencies',
    askPrompt: (repo) =>
      `Check the dependencies of the ${repo.name} repository (${repo.path}): outdated, deprecated, vulnerable, and licence-risky packages.`,
  },
  {
    id: 'cicd',
    label: 'CI/CD',
    feature: 'cicd',
    askPrompt: (repo) =>
      `Analyse the CI/CD pipelines of the ${repo.name} repository (${repo.path}). Flag failing, flaky, or slow steps and suggest improvements.`,
  },
];

/**
 * Repo detail › Health (spec §12): the saved history and tools that used to
 * be the Security, Dependencies and CI/CD destinations, scoped to one repo.
 * Security and Dependencies read `:repoId` from the route
 * (`/workspace/repos/:repoId/health/:tab`); CI/CD takes the repo as a prop.
 */
export function RepoHealthPanel({ repo, tab }: { repo: RepoInfo; tab?: string }) {
  const navigate = useNavigate();
  const allowed = useAllowedFeatures();
  const tabs = REPO_HEALTH_TAB_DEFINITIONS.filter((entry) =>
    isFeatureAllowed(allowed, entry.feature),
  );
  const active = resolveRepoHealthTab(
    tab,
    tabs.map((entry) => entry.id),
  );
  const selectTab = useCallback(
    (next: RepoHealthTab) => navigate(repoDetailPath(repo.id, 'health', next), { replace: true }),
    [navigate, repo.id],
  );

  if (!active) {
    return (
      <EmptyState
        icon={ShieldOff}
        title="Health tools aren't available for your role"
        description="Switch role or turn on “Show all tools” in Settings to see security, dependency and pipeline health."
      />
    );
  }

  const definition = tabs.find((entry) => entry.id === active)!;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4">
        <ViewTabs
          tabs={tabs}
          value={active}
          onChange={selectTab}
          label={`${repo.name} health`}
          idPrefix="repo-health-tab"
          size="sm"
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(chatPromptPath(definition.askPrompt(repo)))}
        >
          <MessageSquare size={13} aria-hidden="true" />
          Ask the agent
        </Button>
      </div>
      <div
        role="tabpanel"
        aria-labelledby={`repo-health-tab-${active}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Suspense
          fallback={
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-text-tertiary">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              Loading…
            </div>
          }
        >
          {active === 'security' ? (
            <SecurityView embedded />
          ) : active === 'dependencies' ? (
            <DependenciesView />
          ) : (
            <CicdView repoId={repo.id} />
          )}
        </Suspense>
      </div>
    </div>
  );
}
