import { useState } from 'react';
import { CheckCheck } from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { EmptyState, ViewHeader } from '../layout/ViewScaffold';
import { ChangeReviewPanel } from './ChangeReviewPanel';
export function ChangeReviewView() {
  const { activeWorkspace } = useWorkspace();
  const [repoId, setRepoId] = useState('');
  const selected =
    activeWorkspace?.repos.find((repo) => repo.id === repoId) ?? activeWorkspace?.repos[0];
  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        icon={CheckCheck}
        title="Change review"
        description="Compare local changes and accept them with evidence."
        actions={
          <select
            aria-label="Review repository"
            value={selected?.id ?? ''}
            onChange={(e) => setRepoId(e.target.value)}
            className="rounded-md border border-border bg-bg-primary px-3 py-2 text-sm"
          >
            {activeWorkspace?.repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {activeWorkspace && selected ? (
          <ChangeReviewPanel
            key={`${activeWorkspace.id}:${selected.id}`}
            workspaceId={activeWorkspace.id}
            repoId={selected.id}
          />
        ) : (
          <EmptyState
            icon={CheckCheck}
            title="Connect a repository"
            description="Add a local Git repository to review a change. No chat session or Work Item provider is required."
          />
        )}
      </div>
    </div>
  );
}
