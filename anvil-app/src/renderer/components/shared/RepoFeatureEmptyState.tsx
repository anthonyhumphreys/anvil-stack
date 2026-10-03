import { useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Button } from '../ui/Button';
import { EmptyState } from '../layout/ViewScaffold';
import { WorkspaceReadinessStrip } from '../workspace/WorkspaceReadinessStrip';

export interface RepoFeatureEmptyStateProps {
  icon: LucideIcon;
  /** Feature name used in copy, e.g. "Security audits" or "The editor". */
  featureLabel: string;
  /** Optional extra sentence describing what the feature unlocks once a repo is mapped. */
  description?: string;
  className?: string;
}

/**
 * Consistent empty state for routes gated on `featureAvailability.repoFeaturesEnabled`.
 *
 * - No repositories: explains the block and offers an "Add a repository" CTA that
 *   opens /workspace, where the AddRepositoriesDialog lives.
 * - Repositories connected but none mapped yet: shows the readiness strip so the
 *   user can watch indexing progress (and Stop/Retry on failure) instead of a
 *   half-broken view.
 */
export function RepoFeatureEmptyState({
  icon,
  featureLabel,
  description,
  className,
}: RepoFeatureEmptyStateProps) {
  const { repos } = useWorkspace();
  const navigate = useNavigate();
  const openWorkspace = () => navigate('/workspace');

  if (repos.length === 0) {
    return (
      <EmptyState
        icon={icon}
        title="Connect a repository"
        description={
          <>
            {featureLabel} need a repository in this workspace.
            {description ? <> {description}</> : null}
          </>
        }
        action={
          <Button variant="primary" size="sm" onClick={openWorkspace}>
            Add a repository
          </Button>
        }
        className={className ?? 'h-full'}
      />
    );
  }

  return (
    <EmptyState
      icon={icon}
      title="Preparing your repositories"
      description={
        <>
          {featureLabel} unlock as soon as a repository finishes its structural index — this usually
          takes seconds, and enrichment continues in the background.
          {description ? <> {description}</> : null}
        </>
      }
      action={
        <div className="flex w-full max-w-2xl flex-col items-stretch gap-3 text-left">
          <WorkspaceReadinessStrip onOpenWorkspace={openWorkspace} />
          <div className="flex justify-center">
            <Button variant="secondary" size="sm" onClick={openWorkspace}>
              Open workspace
            </Button>
          </div>
        </div>
      }
      className={className ?? 'h-full'}
    />
  );
}
