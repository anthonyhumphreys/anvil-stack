import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Copy, Loader2, Square } from 'lucide-react';
import type { RepoInfo } from '../../../shared/types';
import type { RepoIndexJob } from '../../../shared/index-jobs';
import { useWorkspace, repoIsMapped } from '../../contexts/WorkspaceContext';
import { useRepoIndex } from '../../contexts/RepoIndexContext';
import { Button, cx } from '../ui';

/**
 * Compact workspace readiness strip (first-run remediation §4.4, R8).
 *
 * Mounted in the Workspace overview header and intended for the top of the
 * Chat pane:
 *
 * ```tsx
 * // ChatView.tsx (chat-surface workstream) — near the top of the chat column:
 * <WorkspaceReadinessStrip onOpenWorkspace={() => navigate('/workspace')} />
 * ```
 *
 * It shows one tier dot per repo (connected → mapped → enriched), a combined
 * progress line while jobs run, Stop on running jobs and Retry on failed ones,
 * and expands to per-repo job history including persisted errors.
 */
export function WorkspaceReadinessStrip({
  onOpenWorkspace,
  className,
}: {
  /** Optional CTA shown when a repo needs attention — typically navigates to /workspace. */
  onOpenWorkspace?: () => void;
  className?: string;
}) {
  const { repos, activeScaffoldSession } = useWorkspace();
  const repoIndex = useRepoIndex();
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(
    () =>
      repos.map((repo) => ({
        repo,
        activeJob: repoIndex.activeJobForRepo(repo.id),
        lastError: repoIndex.lastErrorForRepo(repo.id),
        jobs: repoIndex.jobsForRepo(repo.id),
        progress: repoIndex.progressByRepoId.get(repo.id) ?? null,
      })),
    [repos, repoIndex],
  );

  if (repos.length === 0) return null;

  const activeJobs = rows.filter((row) => row.activeJob !== null);
  const failedRows = rows.filter((row) => row.lastError !== null && row.activeJob === null);
  const mappedCount = rows.filter((row) => repoIsMapped(row.repo)).length;

  const headline = (() => {
    if (activeJobs.length > 0) {
      const running = activeJobs.find((row) => row.activeJob?.state === 'running') ?? activeJobs[0];
      const tier = running.activeJob?.tier === 'enriched' ? 'Summarising' : 'Mapping';
      return `${tier} ${running.repo.name} — ${running.progress?.message ?? running.activeJob?.message ?? 'queued'}`;
    }
    if (failedRows.length > 0) {
      return `${failedRows.length} ${failedRows.length === 1 ? 'repository' : 'repositories'} failed to index`;
    }
    if (activeScaffoldSession?.status === 'indexing') {
      return 'Workspace setup is finishing — repositories are being indexed';
    }
    return `${mappedCount}/${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'} ready`;
  })();

  const combinedPercent = (() => {
    if (activeJobs.length === 0) return null;
    const percents = activeJobs.map((row) => row.progress?.percent ?? row.activeJob?.progress ?? 0);
    return Math.round(percents.reduce((a, b) => a + b, 0) / percents.length);
  })();

  const tone =
    failedRows.length > 0 && activeJobs.length === 0
      ? 'border-warning/30 bg-warning/5'
      : 'border-border-subtle bg-bg-secondary/60';

  return (
    <section aria-label="Workspace readiness" className={cx('rounded-lg border', tone, className)}>
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        <span className="flex items-center gap-1.5" aria-hidden="true">
          {rows.map(({ repo, activeJob, lastError }) => (
            <RepoTierDot
              key={repo.id}
              repo={repo}
              running={activeJob !== null}
              failed={lastError !== null && activeJob === null}
            />
          ))}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-text-primary">{headline}</span>
          {combinedPercent !== null && (
            <span className="mt-1 block h-1 overflow-hidden rounded-full bg-bg-elevated">
              <span
                className="block h-full rounded-full bg-info transition-all duration-300"
                style={{ width: `${Math.max(4, combinedPercent)}%` }}
              />
            </span>
          )}
        </span>
        {activeJobs.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              for (const row of activeJobs) void repoIndex.cancelIndex(row.repo.id);
            }}
          >
            <Square size={11} aria-hidden="true" /> Stop
          </Button>
        )}
        {failedRows.length > 0 && activeJobs.length === 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              for (const row of failedRows) void repoIndex.retryIndex(row.repo.id);
            }}
          >
            Retry
          </Button>
        )}
        {failedRows.length > 0 && onOpenWorkspace && (
          <Button
            variant="secondary"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onOpenWorkspace();
            }}
          >
            Open Workspace
          </Button>
        )}
        {expanded ? (
          <ChevronUp size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" />
        ) : (
          <ChevronDown size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" />
        )}
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-border-subtle px-3 py-2">
          {rows.map(({ repo, activeJob, lastError, jobs, progress }) => (
            <RepoReadinessRow
              key={repo.id}
              repo={repo}
              activeJob={activeJob}
              lastError={lastError}
              jobs={jobs}
              progress={progress}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RepoTierDot({
  repo,
  running,
  failed,
}: {
  repo: RepoInfo;
  running: boolean;
  failed: boolean;
}) {
  const label = running
    ? 'indexing'
    : failed
      ? 'index failed'
      : repoIsMapped(repo)
        ? repo.indexTier === 'enriched' || repo.status === 'indexed'
          ? 'enriched'
          : 'mapped'
        : 'connected';
  return (
    <span
      title={`${repo.name}: ${label}`}
      className={cx(
        'h-2 w-2 rounded-full',
        running && 'bg-info animate-pulse',
        !running && failed && 'bg-error',
        !running && !failed && repo.indexTier === 'enriched' && 'bg-success',
        !running && !failed && repo.indexTier === 'mapped' && 'bg-info',
        !running &&
          !failed &&
          repo.indexTier !== 'enriched' &&
          repo.indexTier !== 'mapped' &&
          repo.status === 'indexed' &&
          'bg-success',
        !running &&
          !failed &&
          repo.indexTier !== 'enriched' &&
          repo.indexTier !== 'mapped' &&
          repo.status !== 'indexed' &&
          'bg-text-tertiary/50',
      )}
    />
  );
}

function RepoReadinessRow({
  repo,
  activeJob,
  lastError,
  jobs,
  progress,
}: {
  repo: RepoInfo;
  activeJob: RepoIndexJob | null;
  lastError: RepoIndexJob | null;
  jobs: RepoIndexJob[];
  progress: { message: string; percent: number; detail?: string; history: string[] } | null;
}) {
  const [copied, setCopied] = useState(false);

  const copyError = async () => {
    if (!lastError) return;
    const text = `Repo: ${repo.name} (${repo.path})\nJob: ${lastError.id} (${lastError.tier}, ${lastError.reason})\nError: ${lastError.error ?? 'unknown'}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const tierLabel = repoIsMapped(repo)
    ? repo.indexTier === 'enriched' || repo.status === 'indexed'
      ? 'Enriched'
      : 'Mapped'
    : 'Connected';

  return (
    <div className="rounded-md bg-bg-primary/50 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <RepoTierDot repo={repo} running={activeJob !== null} failed={lastError !== null} />
        <span className="truncate text-xs font-medium text-text-primary">{repo.name}</span>
        <span className="text-eyebrow uppercase text-text-tertiary">{tierLabel}</span>
        <span className="ml-auto flex items-center gap-1">
          {activeJob && (
            <>
              <Loader2 size={11} className="animate-spin text-info" aria-hidden="true" />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.anvil.repo.cancelIndex(repo.id)}
              >
                Stop
              </Button>
            </>
          )}
          {lastError && !activeJob && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.anvil.repo.index(repo.id)}
              >
                Retry
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void copyError()}>
                <Copy size={11} aria-hidden="true" /> {copied ? 'Copied' : 'Copy details'}
              </Button>
            </>
          )}
        </span>
      </div>

      {activeJob && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
          <span className="truncate">
            {progress?.message ?? activeJob.message}
            {activeJob.tier === 'enriched' ? ' · summaries' : ' · structure'}
          </span>
          <span className="ml-auto shrink-0 tabular-nums text-text-tertiary">
            {progress?.percent ?? activeJob.progress}%
          </span>
        </p>
      )}

      {lastError && !activeJob && (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-error">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="line-clamp-2">{lastError.error}</span>
        </p>
      )}

      {(progress?.history.length ?? 0) > 0 || jobs.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5 text-eyebrow text-text-tertiary">
          {progress?.history.slice(-3).map((entry, i) => (
            <li key={`h-${i}`} className="truncate">
              {entry}
            </li>
          ))}
          {jobs.slice(0, 3).map((job) => (
            <li key={job.id} className="truncate">
              {job.tier} · {job.state}
              {job.error ? ` — ${job.error}` : ''}
              {job.finishedAt ? ` · ${new Date(job.finishedAt).toLocaleTimeString()}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
