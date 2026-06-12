import { useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, GitBranch, AlertTriangle, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { WorkItem, RepoInfo, BaFinding, BaFindingType } from '../../../shared/types';
import { useBa } from '../../contexts/BaContext';
import { FindingCard } from './FindingCard';
import { CreateFindingWorkItemModal } from './CreateFindingWorkItemModal';
import { useStoredPanelState } from '../../hooks/useStoredPanelState';

interface BaSidebarProps {
  workItem: WorkItem | null;
  repo: RepoInfo | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const FINDING_TYPES: { value: BaFindingType; label: string }[] = [
  { value: 'compliance', label: 'Compliance' },
  { value: 'feasibility', label: 'Feasibility' },
  { value: 'dependency', label: 'Dependency' },
  { value: 'question', label: 'Question' },
  { value: 'risk', label: 'Risk' },
];

export function BaSidebar({ workItem, repo, collapsed, onToggleCollapse }: BaSidebarProps) {
  const navigate = useNavigate();
  const { findings, session, dismissFinding, addManualFinding, spikeDriftWarning, createWorkItem } =
    useBa();

  const [showAddForm, setShowAddForm] = useState(false);
  const [newType, setNewType] = useState<BaFindingType>('question');
  const [newContent, setNewContent] = useState('');
  const [findingForWorkItem, setFindingForWorkItem] = useState<BaFinding | null>(null);
  const { width, setWidth } = useStoredPanelState({
    storageKey: 'ba:sidebar',
    defaultWidth: 280,
    minWidth: 240,
    maxWidth: 420,
  });

  const openFindings = findings.filter((f) => f.status === 'open');

  const handleAddFinding = async () => {
    const trimmed = newContent.trim();
    if (!trimmed) return;
    await addManualFinding(newType, trimmed);
    setNewContent('');
    setShowAddForm(false);
  };

  const handleResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    if (collapsed) return;

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      setWidth(startWidth + (moveEvent.clientX - startX));
    };

    const handleMouseUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-r border-border bg-bg-secondary py-2">
        <button
          onClick={onToggleCollapse}
          className="rounded p-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        className="relative flex shrink-0 flex-col border-r border-border bg-bg-secondary"
        style={{ width }}
      >
      {/* Header with back + collapse */}
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <button
          onClick={() => navigate('/workitems')}
          className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary"
          aria-label="Back to work items"
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <button
          onClick={onToggleCollapse}
          className="rounded p-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <ChevronLeft size={14} />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 space-y-3 overflow-auto p-3">
        {/* Work item card */}
        {workItem && (
          <div className="rounded-lg border border-border bg-bg-primary p-3">
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-border px-2 py-0.5 text-sm text-text-secondary">
                {workItem.type}
              </span>
              <span className="font-mono text-sm text-text-secondary">#{workItem.id}</span>
            </div>
            <p className="mt-2 text-base font-medium leading-snug text-text-primary">
              {workItem.title}
            </p>
            <p className="mt-1 text-sm text-text-secondary">
              {workItem.state} &middot; P{workItem.priority}
            </p>
          </div>
        )}

        {/* Repo card */}
        {repo && (
          <div className="rounded-lg border border-border bg-bg-primary p-3">
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <GitBranch size={14} />
              <span className="font-medium">{repo.name}</span>
            </div>
            {session?.spikeBranch && (
              <div className="mt-1 flex items-center gap-1">
                <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-sm text-warning">
                  {session.spikeBranch}
                </span>
              </div>
            )}
            {repo.languages[0] && (
              <p className="mt-1 text-sm text-text-secondary">{repo.languages[0].language}</p>
            )}
          </div>
        )}

        {/* Spike drift warning */}
        {spikeDriftWarning && (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
            <div>
              <p className="text-sm font-medium text-warning">Spike Drift Detected</p>
              <p className="text-sm text-text-secondary">
                The origin branch has changed since the spike was created.
              </p>
            </div>
          </div>
        )}

        {/* Findings section */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-base font-semibold text-text-secondary">
              Findings
              {openFindings.length > 0 && (
                <span className="ml-1.5 rounded-full bg-accent px-2 py-0.5 text-sm text-white">
                  {openFindings.length}
                </span>
              )}
            </h3>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="rounded p-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              title="Add manual finding"
              aria-label="Add manual finding"
            >
              <Plus size={14} />
            </button>
          </div>

          {/* Manual finding form */}
          {showAddForm && (
            <div className="mb-2 space-y-2 rounded-md border border-border bg-bg-primary p-3">
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as BaFindingType)}
                className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
              >
                {FINDING_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="Describe the finding..."
                rows={3}
                className="w-full resize-none rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
              />
              <button
                onClick={handleAddFinding}
                disabled={!newContent.trim()}
                className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/80 disabled:opacity-40"
              >
                Add Finding
              </button>
            </div>
          )}

          {/* Findings list */}
          <div className="space-y-2">
            {openFindings.length === 0 && !showAddForm && (
              <p className="text-sm text-text-secondary">
                No open findings yet. They will appear here as the BA agent identifies them.
              </p>
            )}
            {openFindings.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                onDismiss={dismissFinding}
                onCreateWorkItem={setFindingForWorkItem}
              />
            ))}
          </div>
        </div>
      </div>

      <div
        onMouseDown={handleResizeStart}
        className="absolute -right-1 bottom-0 top-0 z-10 w-2 cursor-col-resize"
        aria-hidden="true"
      >
        <div className="mx-auto h-full w-px bg-border/50 transition-colors hover:bg-accent" />
      </div>
      </div>

      {findingForWorkItem ? (
        <CreateFindingWorkItemModal
          finding={findingForWorkItem}
          currentWorkItem={workItem}
          onCreate={createWorkItem}
          onClose={() => setFindingForWorkItem(null)}
        />
      ) : null}
    </>
  );
}
