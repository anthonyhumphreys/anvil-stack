import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  GitBranch,
  Loader2,
  MessageSquareText,
  Network,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { AgentRunSummary, GitStatusResult, RepositoryMapGraph } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildEditorUrl } from '../../utils/editor-link';
import { buildRepositoryTwinSnapshot } from '../../utils/repository-twin';

interface RepositoryTwinProps {
  repoId?: string;
  repositoryName: string;
  graph: RepositoryMapGraph;
  compact?: boolean;
}

export function RepositoryTwin({
  repoId,
  repositoryName,
  graph,
  compact = false,
}: RepositoryTwinProps) {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!repoId || !activeWorkspace?.id) return;
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextRuns] = await Promise.all([
        window.anvil.git.status(repoId),
        window.anvil.agentRuns.list(activeWorkspace.id, 30),
      ]);
      setStatus(nextStatus);
      setRuns(nextRuns);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not read the live repository state.',
      );
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace?.id, repoId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const snapshot = useMemo(
    () => (repoId && status ? buildRepositoryTwinSnapshot(graph, status, runs, repoId) : null),
    [graph, repoId, runs, status],
  );

  if (!repoId || !activeWorkspace?.id) {
    return <TwinMessage message="Connect this repository to a workspace to start its live twin." />;
  }

  if (loading && !snapshot) {
    return (
      <TwinMessage
        icon={<Loader2 size={20} className="animate-spin text-accent" />}
        message="Reading the repository pulse…"
      />
    );
  }

  if (error || !snapshot) {
    return (
      <TwinMessage message={error ?? 'The repository twin is unavailable.'} onRetry={refresh} />
    );
  }

  const askAboutTwin = () => {
    const districtSummary = snapshot.districts
      .map((district) => `${district.node.name}: ${district.files.length} changed files`)
      .join(', ');
    navigate(
      `/chat?prompt=${encodeURIComponent(
        `Inspect the live repository state for ${repositoryName}. Branch ${snapshot.branch} has ${snapshot.changedFileCount} changed files. Impacted districts: ${districtSummary || 'none detected'}. Explain risk, likely blast radius, and the next useful verification.`,
      )}`,
    );
  };

  return (
    <div
      className="min-w-0 overflow-y-auto bg-bg-primary/35 p-4"
      style={{ height: compact ? 400 : 560 }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Activity size={16} className="text-accent" />
            Live repository twin
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            Working tree, agent activity, and dependency blast radius. Refreshes every 15 seconds.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={askAboutTwin}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          >
            <MessageSquareText size={13} /> Ask in Chat
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Refresh repository twin"
            title="Refresh repository twin"
            className="grid h-8 w-8 place-items-center rounded-md border border-border text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <TwinStat icon={<GitBranch size={14} />} label="Branch" value={snapshot.branch} />
        <TwinStat
          icon={<Sparkles size={14} />}
          label="Working tree"
          value={`${snapshot.changedFileCount} changed`}
        />
        <TwinStat
          icon={<ArrowUpFromLine size={14} />}
          label="Ahead"
          value={String(snapshot.ahead)}
        />
        <TwinStat
          icon={<ArrowDownToLine size={14} />}
          label="Behind"
          value={String(snapshot.behind)}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(260px,0.65fr)]">
        <section>
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              Live districts
            </h4>
            <span className="text-xs text-text-tertiary">{snapshot.districts.length} affected</span>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {snapshot.districts.length === 0 ? (
              <div className="col-span-full rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-text-secondary">
                The working tree is clean. The twin is quiet.
              </div>
            ) : (
              snapshot.districts.map((district) => (
                <article
                  key={district.node.id}
                  className="rounded-lg border border-border-subtle bg-bg-secondary p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-text-primary">
                        {district.node.name}
                      </div>
                      <div className="truncate font-mono text-[11px] text-text-tertiary">
                        {district.node.path}
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-xs text-warning">
                      {district.files.length} changed
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {district.files.slice(0, 4).map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() =>
                          navigate(
                            buildEditorUrl({
                              workspaceId: activeWorkspace.id,
                              repoId,
                              relativePath: file.path,
                              source: 'repos',
                              title: file.path,
                            }),
                          )
                        }
                        className="block w-full truncate rounded px-1.5 py-1 text-left font-mono text-[11px] text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                      >
                        {file.path}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center gap-1 text-[11px] text-text-tertiary">
                    <Network size={11} />
                    {district.connectedNodes.length > 0
                      ? `${district.connectedNodes.length} connected district${district.connectedNodes.length === 1 ? '' : 's'}`
                      : 'No indexed dependency blast radius'}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              Agent pulse
            </h4>
            <span className="text-xs text-text-tertiary">{snapshot.activeRuns.length} active</span>
          </div>
          <div className="mt-2 space-y-2">
            {snapshot.recentRuns.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-5 text-sm text-text-secondary">
                No agent runs have touched this repository yet.
              </div>
            ) : (
              snapshot.recentRuns.map((run) => <TwinRun key={run.id} run={run} />)
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function TwinStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
        {icon} {label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function TwinRun({ run }: { run: AgentRunSummary }) {
  const active = run.status === 'running' || run.status === 'queued';
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-sm font-medium text-text-primary">{run.title}</div>
        <span className={active ? 'text-xs text-accent' : 'text-xs text-text-tertiary'}>
          {run.status}
        </span>
      </div>
      <div className="mt-1 text-xs text-text-tertiary">
        {run.source.replace('_', ' ')} · {run.changedFileCount} changed · {run.evidenceCount}{' '}
        evidence
      </div>
    </div>
  );
}

function TwinMessage({
  message,
  icon,
  onRetry,
}: {
  message: string;
  icon?: React.ReactNode;
  onRetry?: () => void | Promise<void>;
}) {
  return (
    <div className="grid h-[560px] place-items-center px-6 text-center">
      <div>
        {icon}
        <p className="mt-2 text-sm text-text-secondary">{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={() => void onRetry()}
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
