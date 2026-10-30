import { lazy, Suspense } from 'react';
import { Compass, Loader2 } from 'lucide-react';
import type { RepoInfo } from '../../../shared/types';
import { repoIsMapped } from '../../contexts/WorkspaceContext';
import { EmptyState } from '../layout/ViewScaffold';
import { isFeatureAllowed, useAllowedFeatures } from '../library/useAllowedFeatures';
import { RepoReadinessChecklist } from './RepoReadinessChecklist';

const OnboardView = lazy(() =>
  import('../onboard/OnboardView').then((module) => ({ default: module.OnboardView })),
);

/**
 * Repo detail › Setup (spec §12): the readiness checklist plus the repo-setup
 * wizard (AGENTS.md, devcontainer, environment, connectors) for this repo.
 * The wizard is preselected with `repoId`; remount per repo via `key`.
 */
export function RepoSetupPanel({ repo }: { repo: RepoInfo }) {
  const allowed = useAllowedFeatures();

  if (!isFeatureAllowed(allowed, 'onboard')) {
    return (
      <div className="overflow-auto p-4">
        {repoIsMapped(repo) && <RepoReadinessChecklist repo={repo} />}
        <EmptyState
          icon={Compass}
          compact
          title="Repo setup isn't available for your role"
          description="Turn on “Show all tools” in Settings to run the setup wizard."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {repoIsMapped(repo) && (
        <div className="shrink-0 border-b border-border-subtle p-4">
          <RepoReadinessChecklist repo={repo} />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense
          fallback={
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-text-tertiary">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              Loading…
            </div>
          }
        >
          <OnboardView repoId={repo.id} />
        </Suspense>
      </div>
    </div>
  );
}
