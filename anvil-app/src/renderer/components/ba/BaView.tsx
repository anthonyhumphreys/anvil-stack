import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { WorkItem, RepoInfo } from '../../../shared/types';
import { BaProvider, useBa } from '../../contexts/BaContext';
import { BaSidebar } from './BaSidebar';
import { BaChatArea } from './BaChatArea';
import { RepoSelector } from '../shared/RepoSelector';
import { useWorkspace } from '../../contexts/WorkspaceContext';

export function BaView() {
  const { workItemId } = useParams<{ workItemId: string }>();
  const [searchParams] = useSearchParams();
  const { repos: workspaceRepos } = useWorkspace();

  const [workItem, setWorkItem] = useState<WorkItem | null>(null);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [repoId, setRepoId] = useState<string | null>(searchParams.get('repoId'));
  const [showRepoModal, setShowRepoModal] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load work item
  useEffect(() => {
    if (!workItemId) return;
    window.anvil.workitems
      .get(workItemId)
      .then(setWorkItem)
      .catch((err) => console.error('Failed to load work item:', err));
  }, [workItemId]);

  // Resolve repo: query param > saved link > show modal
  useEffect(() => {
    if (!workItemId) return;

    const resolve = async () => {
      // 1. Check query param
      const paramRepoId = searchParams.get('repoId');
      if (paramRepoId) {
        setRepoId(paramRepoId);
        await loadRepo(paramRepoId);
        setLoading(false);
        return;
      }

      // 2. Check saved repo link
      try {
        const link = await window.anvil.ba.getRepoLink(workItemId);
        if (link) {
          setRepoId(link.repoId);
          await loadRepo(link.repoId);
          setLoading(false);
          return;
        }
      } catch (err) {
        console.error('Failed to check repo link:', err);
      }

      // 3. Show modal
      setLoading(false);
      setShowRepoModal(true);
    };

    resolve();
  }, [workItemId, searchParams]);

  const loadRepo = (id: string) => {
    const found = workspaceRepos.find((r) => r.id === id);
    if (found) setRepo(found);
  };

  const handleRepoSelect = async (selectedRepoId: string) => {
    setRepoId(selectedRepoId);
    setShowRepoModal(false);
    await loadRepo(selectedRepoId);
  };

  const handleRepoCancel = () => {
    setShowRepoModal(false);
  };

  if (!workItemId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-secondary">No work item specified.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-secondary">Loading...</p>
      </div>
    );
  }

  if (showRepoModal) {
    return (
      <RepoSelector
        variant="modal"
        title="Select Repository"
        description="Choose an indexed repository for the BA session."
        confirmLabel="Start BA Session"
        selectedRepoId={null}
        onSelect={(repo) => handleRepoSelect(repo.id)}
        onCancel={handleRepoCancel}
      />
    );
  }

  if (!repoId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-secondary">No repository selected.</p>
      </div>
    );
  }

  return (
    <BaProvider workItemId={workItemId}>
      <BaViewInner
        workItem={workItem}
        repo={repo}
        repoId={repoId}
        workItemId={workItemId}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
      />
    </BaProvider>
  );
}

/** Inner component that has access to BaContext */
function BaViewInner({
  workItem,
  repo,
  repoId,
  workItemId,
  sidebarCollapsed,
  onToggleSidebar,
}: {
  workItem: WorkItem | null;
  repo: RepoInfo | null;
  repoId: string;
  workItemId: string;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}) {
  const { startSession, session } = useBa();

  // Auto-start session when repo is available and no session yet
  useEffect(() => {
    if (repoId && !session) {
      startSession(workItemId, repoId);
    }
  }, [repoId, session, workItemId, startSession]);

  return (
    <div className="flex h-full">
      <BaSidebar
        workItem={workItem}
        repo={repo}
        collapsed={sidebarCollapsed}
        onToggleCollapse={onToggleSidebar}
      />
      <BaChatArea />
    </div>
  );
}
