import { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  ChevronRight,
  RefreshCw,
  Search,
  FolderGit2,
  ArrowLeft,
  FileText,
} from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { AdrMarkdown } from './AdrMarkdown';
import type { AdrEntry, RepoAdrs } from '../../../shared/types';

type StatusVariant = 'accepted' | 'proposed' | 'deprecated' | 'superseded' | 'unknown';

function classifyStatus(status?: string): StatusVariant {
  if (!status) return 'unknown';
  const lower = status.toLowerCase();
  if (lower.includes('accepted') || lower.includes('approved')) return 'accepted';
  if (lower.includes('proposed') || lower.includes('draft') || lower.includes('pending'))
    return 'proposed';
  if (lower.includes('deprecated') || lower.includes('rejected')) return 'deprecated';
  if (lower.includes('superseded') || lower.includes('replaced')) return 'superseded';
  return 'unknown';
}

const statusStyles: Record<StatusVariant, string> = {
  accepted: 'bg-success/15 text-success border-success/30',
  proposed: 'bg-info/15 text-info border-info/30',
  deprecated: 'bg-error/15 text-error border-error/30',
  superseded: 'bg-warning/15 text-warning border-warning/30',
  unknown: 'bg-bg-tertiary text-text-tertiary border-border-subtle',
};

function StatusBadge({ status }: { status?: string }) {
  const variant = classifyStatus(status);
  const label = status || 'Unknown';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusStyles[variant]}`}
    >
      {label}
    </span>
  );
}

function AdrCard({ adr, onClick }: { adr: AdrEntry; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-start gap-3 rounded-lg border border-border-subtle bg-bg-secondary p-4 text-left transition-all hover:border-border hover:bg-bg-tertiary"
    >
      <div className="mt-0.5 rounded-md bg-accent/10 p-2">
        <FileText size={16} className="text-accent" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-medium text-text-primary group-hover:text-accent">
            {adr.title}
          </h3>
          {adr.status && <StatusBadge status={adr.status} />}
        </div>
        <p className="mt-0.5 truncate text-xs text-text-tertiary">{adr.relativePath}</p>
      </div>
      <ChevronRight
        size={16}
        className="mt-1 shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-text-secondary"
      />
    </button>
  );
}

function RepoSection({
  repoAdrs,
  onSelectAdr,
}: {
  repoAdrs: RepoAdrs;
  onSelectAdr: (adr: AdrEntry) => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <FolderGit2 size={16} className="text-accent" />
        <h2 className="text-base font-semibold text-text-primary">{repoAdrs.repoName}</h2>
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-tertiary">
          {repoAdrs.adrs.length} ADR{repoAdrs.adrs.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="space-y-2">
        {repoAdrs.adrs.map((adr) => (
          <AdrCard key={adr.relativePath} adr={adr} onClick={() => onSelectAdr(adr)} />
        ))}
      </div>
    </div>
  );
}

export function AdrsView() {
  const { activeWorkspace } = useWorkspace();
  const [repoAdrs, setRepoAdrs] = useState<RepoAdrs[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAdr, setSelectedAdr] = useState<{ adr: AdrEntry; repoName: string } | null>(null);
  const [search, setSearch] = useState('');

  const loadAdrs = useCallback(async () => {
    if (!activeWorkspace) return;
    setLoading(true);
    try {
      const data = await window.anvil.adr.listByWorkspace(activeWorkspace.id);
      setRepoAdrs(data);
    } catch (err) {
      console.error('[ADR] Failed to load ADRs:', err);
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace]);

  useEffect(() => {
    loadAdrs();
  }, [loadAdrs]);

  const filteredRepoAdrs = search
    ? repoAdrs
        .map((ra) => ({
          ...ra,
          adrs: ra.adrs.filter(
            (adr) =>
              adr.title.toLowerCase().includes(search.toLowerCase()) ||
              adr.filename.toLowerCase().includes(search.toLowerCase()) ||
              (adr.status && adr.status.toLowerCase().includes(search.toLowerCase())),
          ),
        }))
        .filter((ra) => ra.adrs.length > 0)
    : repoAdrs;

  const totalAdrs = repoAdrs.reduce((sum, ra) => sum + ra.adrs.length, 0);

  // Detail view for a selected ADR
  if (selectedAdr) {
    return (
      <div className="flex h-full flex-col">
        {/* Header */}
        <div className="shrink-0 border-b border-border px-6 py-4">
          <button
            onClick={() => setSelectedAdr(null)}
            className="mb-3 flex items-center gap-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary"
          >
            <ArrowLeft size={14} />
            Back to ADRs
          </button>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-text-primary">{selectedAdr.adr.title}</h1>
              <div className="mt-1 flex items-center gap-3 text-sm text-text-tertiary">
                <span className="flex items-center gap-1">
                  <FolderGit2 size={12} />
                  {selectedAdr.repoName}
                </span>
                <span>{selectedAdr.adr.relativePath}</span>
              </div>
            </div>
            {selectedAdr.adr.status && <StatusBadge status={selectedAdr.adr.status} />}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          <div className="mx-auto max-w-4xl px-6 py-6">
            <AdrMarkdown content={selectedAdr.adr.content} />
          </div>
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-accent/10 p-2">
              <BookOpen size={20} className="text-accent" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-text-primary">
                Architecture Decision Records
              </h1>
              <p className="text-sm text-text-secondary">
                {loading
                  ? 'Scanning repositories...'
                  : totalAdrs === 0
                    ? 'No ADRs found in workspace repositories'
                    : `${totalAdrs} ADR${totalAdrs !== 1 ? 's' : ''} across ${repoAdrs.length} repositor${repoAdrs.length !== 1 ? 'ies' : 'y'}`}
              </p>
            </div>
          </div>
          <button
            onClick={loadAdrs}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {/* Search */}
        {totalAdrs > 0 && (
          <div className="relative mt-4">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search ADRs by title, filename, or status..."
              className="w-full rounded-lg border border-border-subtle bg-bg-primary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent/50 focus:outline-none"
            />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-6 py-5">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <RefreshCw size={24} className="animate-spin text-accent" />
            <p className="mt-3 text-sm text-text-secondary">Scanning repositories for ADRs...</p>
          </div>
        ) : totalAdrs === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="rounded-full bg-bg-tertiary p-4">
              <BookOpen size={32} className="text-text-tertiary" />
            </div>
            <h2 className="mt-4 text-base font-medium text-text-primary">No ADRs found</h2>
            <p className="mt-1 max-w-sm text-center text-sm text-text-secondary">
              No Architecture Decision Records were found in the workspace repositories. ADRs are
              typically stored in{' '}
              <code className="rounded bg-bg-tertiary px-1 py-0.5 text-xs">docs/adr/</code> or{' '}
              <code className="rounded bg-bg-tertiary px-1 py-0.5 text-xs">docs/adrs/</code>{' '}
              directories.
            </p>
          </div>
        ) : filteredRepoAdrs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Search size={24} className="text-text-tertiary" />
            <p className="mt-3 text-sm text-text-secondary">No ADRs match your search</p>
          </div>
        ) : (
          <div className="space-y-8">
            {filteredRepoAdrs.map((ra) => (
              <RepoSection
                key={ra.repoId}
                repoAdrs={ra}
                onSelectAdr={(adr) => setSelectedAdr({ adr, repoName: ra.repoName })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
