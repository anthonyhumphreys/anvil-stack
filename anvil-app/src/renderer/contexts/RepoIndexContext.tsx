import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { RepoIndexJob } from '../../shared/index-jobs';
import type { RepoIndexProgress } from '../../shared/types';

/**
 * Repo index job state (first-run remediation §4.4, finding R2).
 *
 * Indexing is owned by the main-process queue; this context is the renderer's
 * window onto it. Jobs hydrate once from `repo:index-jobs` and then follow the
 * `repo:index-progress` broadcast, so every surface (Repos view, readiness
 * strip, Chat mount point) sees the same truth — no per-view polling and no
 * state loss on navigation.
 */

export interface RepoIndexLiveProgress {
  message: string;
  percent: number;
  detail?: string;
  /** Rolling tail of progress lines for the expandable history (R8). */
  history: string[];
}

export interface RepoIndexContextValue {
  /** All known jobs, newest first. */
  jobs: RepoIndexJob[];
  /** False until the first `repo:index-jobs` hydration resolves. */
  hydrated: boolean;
  /** Live progress lines per repo while a job streams updates. */
  progressByRepoId: Map<string, RepoIndexLiveProgress>;
  jobsForRepo: (repoId: string) => RepoIndexJob[];
  /** The queued/running job for a repo, if any. */
  activeJobForRepo: (repoId: string) => RepoIndexJob | null;
  /** Latest terminal job (completed/failed/cancelled) for a repo. */
  latestFinishedJobForRepo: (repoId: string) => RepoIndexJob | null;
  /** Most recent failed job carrying an error message, for RM5. */
  lastErrorForRepo: (repoId: string) => RepoIndexJob | null;
  isIndexing: (repoId: string) => boolean;
  /** Manual full refresh: enqueues mapped + enriched tiers. */
  startIndex: (repoId: string) => Promise<RepoIndexJob[]>;
  /** Retry after failure — same as startIndex, named for call sites. */
  retryIndex: (repoId: string) => Promise<RepoIndexJob[]>;
  cancelIndex: (repoId: string) => Promise<void>;
  /** Force a re-list from `repo:index-jobs` (e.g. after removing a repo). */
  refresh: () => Promise<void>;
  /** Bumped whenever a job reaches a terminal state — consumers can refresh. */
  settledJobsVersion: number;
}

const RepoIndexContext = createContext<RepoIndexContextValue | null>(null);

export function useRepoIndex(): RepoIndexContextValue {
  const ctx = useContext(RepoIndexContext);
  if (!ctx) throw new Error('useRepoIndex must be used within <RepoIndexProvider>');
  return ctx;
}

/**
 * Null-safe variant for providers that may render outside
 * `<RepoIndexProvider>` (e.g. WorkspaceContext, which consumes job state to
 * compute truthful feature availability but is mounted inside it in App.tsx).
 */
export function useOptionalRepoIndex(): RepoIndexContextValue | null {
  return useContext(RepoIndexContext);
}

const ACTIVE_STATES = new Set<RepoIndexJob['state']>(['queued', 'running']);
const TERMINAL_STATES = new Set<RepoIndexJob['state']>(['completed', 'failed', 'cancelled']);

function sortJobs(jobs: RepoIndexJob[]): RepoIndexJob[] {
  return [...jobs].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
}

export function RepoIndexProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<RepoIndexJob[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [progressByRepoId, setProgressByRepoId] = useState<Map<string, RepoIndexLiveProgress>>(
    new Map(),
  );
  const [settledJobsVersion, setSettledJobsVersion] = useState(0);
  // Track which job ids we've already counted as settled so a burst of
  // terminal events for one job only bumps the version once.
  const settledJobIdsRef = useRef<Set<string>>(new Set());

  const refreshJobs = useCallback(async () => {
    try {
      const list = await window.anvil.repo.listIndexJobs();
      setJobs(sortJobs(list));
    } catch (err) {
      console.error('[RepoIndex] Failed to load index jobs:', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.anvil.repo
      .listIndexJobs()
      .then((list) => {
        if (cancelled) return;
        setJobs(sortJobs(list));
        for (const job of list) {
          if (TERMINAL_STATES.has(job.state)) settledJobIdsRef.current.add(job.id);
        }
        setHydrated(true);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[RepoIndex] Failed to hydrate index jobs:', err);
          setHydrated(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cleanup = window.anvil.repo.onIndexProgress((data: RepoIndexProgress) => {
      // Live progress line for the repo card / readiness strip.
      setProgressByRepoId((prev) => {
        const next = new Map(prev);
        const current = next.get(data.repoId);
        const entry = data.detail ? `${data.message} ${data.detail}` : data.message;
        const prevHistory = current?.history ?? [];
        const history =
          prevHistory[prevHistory.length - 1] === entry
            ? prevHistory
            : [...prevHistory, entry].slice(-8);
        next.set(data.repoId, {
          message: data.message,
          percent: data.percent,
          detail: data.detail,
          history,
        });
        return next;
      });

      // Reflect job state transitions in the hydrated job list. A terminal
      // event triggers an authoritative re-list (the queue persists errors).
      if (data.jobId && data.jobState) {
        const isTerminal = TERMINAL_STATES.has(data.jobState);
        setJobs((prev) => {
          const idx = prev.findIndex((job) => job.id === data.jobId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = {
            ...next[idx],
            state: data.jobState!,
            progress: data.percent,
            message: data.message,
          };
          return next;
        });
        if (isTerminal && !settledJobIdsRef.current.has(data.jobId)) {
          settledJobIdsRef.current.add(data.jobId);
          setSettledJobsVersion((v) => v + 1);
          void refreshJobs();
        }
      } else if (data.stage === 'complete' || data.stage === 'error') {
        // Legacy progress events without a job id — re-list to stay truthful.
        void refreshJobs();
      }
    });
    return cleanup;
  }, [refreshJobs]);

  const jobsByRepoId = useMemo(() => {
    const map = new Map<string, RepoIndexJob[]>();
    for (const job of jobs) {
      const list = map.get(job.repoId);
      if (list) list.push(job);
      else map.set(job.repoId, [job]);
    }
    return map;
  }, [jobs]);

  const jobsForRepo = useCallback(
    (repoId: string) => jobsByRepoId.get(repoId) ?? [],
    [jobsByRepoId],
  );

  const activeJobForRepo = useCallback(
    (repoId: string) =>
      (jobsByRepoId.get(repoId) ?? []).find((job) => ACTIVE_STATES.has(job.state)) ?? null,
    [jobsByRepoId],
  );

  const latestFinishedJobForRepo = useCallback(
    (repoId: string) =>
      (jobsByRepoId.get(repoId) ?? []).find((job) => TERMINAL_STATES.has(job.state)) ?? null,
    [jobsByRepoId],
  );

  const lastErrorForRepo = useCallback(
    (repoId: string) =>
      (jobsByRepoId.get(repoId) ?? []).find(
        (job) => job.state === 'failed' && Boolean(job.error),
      ) ?? null,
    [jobsByRepoId],
  );

  const isIndexing = useCallback(
    (repoId: string) => activeJobForRepo(repoId) !== null,
    [activeJobForRepo],
  );

  const startIndex = useCallback(
    async (repoId: string) => {
      const enqueued = await window.anvil.repo.index(repoId);
      await refreshJobs();
      return enqueued;
    },
    [refreshJobs],
  );

  const retryIndex = startIndex;

  const cancelIndex = useCallback(
    async (repoId: string) => {
      await window.anvil.repo.cancelIndex(repoId);
      await refreshJobs();
    },
    [refreshJobs],
  );

  return (
    <RepoIndexContext.Provider
      value={{
        jobs,
        hydrated,
        progressByRepoId,
        jobsForRepo,
        activeJobForRepo,
        latestFinishedJobForRepo,
        lastErrorForRepo,
        isIndexing,
        startIndex,
        retryIndex,
        cancelIndex,
        refresh: refreshJobs,
        settledJobsVersion,
      }}
    >
      {children}
    </RepoIndexContext.Provider>
  );
}
