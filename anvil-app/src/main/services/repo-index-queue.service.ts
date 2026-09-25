import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import type {
  RepoIndexEnqueueOptions,
  RepoIndexJob,
  RepoIndexJobState,
  RepoIndexJobTier,
} from '../../shared/index-jobs.js';
import type { RepoIndexProgress } from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { getSettings } from './settings.service.js';
import {
  enrichRepo,
  mapRepo,
  RepoIndexCancelledError,
  type EnrichRepoResult,
  type RepoIndexProgressFn,
} from './repo-index.service.js';
import { trackActivationEvent } from './metrics.service.js';

/**
 * Main-process repo index queue (§4.2). All indexing — connect, scaffold,
 * commit refresh and manual re-index — funnels through here so a repo can
 * never have two indexers racing, job state survives restarts, and progress
 * is broadcast to every window rather than whichever renderer started it.
 */

const MAX_MAPPED_JOBS = 4;
const JOB_HISTORY_LIMIT = 200;

interface DbIndexJobRow {
  id: string;
  repo_id: string;
  tier: string;
  state: string;
  reason: string;
  progress: number;
  message: string | null;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

let runningMappedJobs = 0;
let runningEnrichedJobs = 0;
let pumpScheduled = false;

/** Repos with a cancellation request — running jobs check this cooperatively. */
const cancelRequestedRepoIds = new Set<string>();
const repoWaiters = new Map<string, Array<() => boolean>>();

// ---------------------------------------------------------------------------
// Shared LLM pool — every enrichment LLM call across all repos goes through
// this semaphore. Size comes from settings: Codex is serial (1), others 2.
// ---------------------------------------------------------------------------

let llmActive = 0;
const llmWaiters: Array<() => void> = [];

function llmPoolSize(): number {
  try {
    return getSettings().llmProvider === 'codex' ? 1 : 2;
  } catch {
    return 2;
  }
}

export async function withLlmSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (llmActive >= llmPoolSize()) {
    await new Promise<void>((resolve) => llmWaiters.push(resolve));
  }
  llmActive += 1;
  try {
    return await fn();
  } finally {
    llmActive = Math.max(0, llmActive - 1);
    for (const waiter of llmWaiters.splice(0)) waiter();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue index jobs for a repo. Already queued/running jobs for the same
 * repo+tier are reused — this is the single concurrency guard for indexing.
 */
export function enqueueIndexJobs(repoId: string, options: RepoIndexEnqueueOptions): RepoIndexJob[] {
  const db = getDb();
  const repo = db.prepare('SELECT id FROM repos WHERE id = ?').get(repoId) as
    | { id: string }
    | undefined;
  if (!repo) throw new Error(`Repo not found: ${repoId}`);

  const tiers = options.tiers ?? ['mapped', 'enriched'];
  const jobs: RepoIndexJob[] = [];

  for (const tier of tiers) {
    const existing = db
      .prepare(
        `SELECT * FROM repo_index_jobs
         WHERE repo_id = ? AND tier = ? AND state IN ('queued', 'running')
         ORDER BY rowid LIMIT 1`,
      )
      .get(repoId, tier) as DbIndexJobRow | undefined;
    if (existing) {
      jobs.push(rowToJob(existing));
      continue;
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO repo_index_jobs (id, repo_id, tier, state, reason, progress, message, queued_at)
       VALUES (?, ?, ?, 'queued', ?, 0, 'Queued', datetime('now'))`,
    ).run(id, repoId, tier, options.reason);
    const job = rowToJob(
      db.prepare('SELECT * FROM repo_index_jobs WHERE id = ?').get(id) as DbIndexJobRow,
    );
    jobs.push(job);
    emitJobState(job);
  }

  refreshRepoStatus(repoId);
  schedulePump();
  return jobs;
}

/** Cancel all queued and running index jobs for a repo. */
export function cancelIndexJobs(repoId: string): void {
  const db = getDb();
  cancelRequestedRepoIds.add(repoId);

  const cancelledQueued = db
    .prepare(
      `UPDATE repo_index_jobs
       SET state = 'cancelled', message = 'Cancelled', finished_at = datetime('now')
       WHERE repo_id = ? AND state = 'queued'`,
    )
    .run(repoId);

  if (cancelledQueued.changes > 0) {
    const rows = db
      .prepare(
        `SELECT * FROM repo_index_jobs WHERE repo_id = ? AND state = 'cancelled'
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(repoId, cancelledQueued.changes) as DbIndexJobRow[];
    for (const row of rows) emitJobState(rowToJob(row));
  }

  refreshRepoStatus(repoId);
  settleRepoWaiters(repoId);
}

/**
 * Resolve when a repo has no queued or running index jobs. Returns the repo's
 * recent job rows so callers can inspect outcomes.
 */
export function waitForRepoIndexJobs(repoId: string): Promise<RepoIndexJob[]> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      if (activeJobCount(repoId) === 0) {
        resolve(listRepoIndexJobs(repoId));
        return true;
      }
      return false;
    };
    if (check()) return;
    const waiters = repoWaiters.get(repoId) ?? [];
    waiters.push(check);
    repoWaiters.set(repoId, waiters);
  });
}

/** Recent index jobs for hydration — newest first. */
export function listRepoIndexJobs(repoId?: string): RepoIndexJob[] {
  const db = getDb();
  const rows = (
    repoId
      ? db
          .prepare('SELECT * FROM repo_index_jobs WHERE repo_id = ? ORDER BY rowid DESC LIMIT ?')
          .all(repoId, JOB_HISTORY_LIMIT)
      : db
          .prepare('SELECT * FROM repo_index_jobs ORDER BY rowid DESC LIMIT ?')
          .all(JOB_HISTORY_LIMIT)
  ) as DbIndexJobRow[];
  return rows.map(rowToJob);
}

/**
 * Startup crash recovery: re-queue jobs that were running when the app died,
 * and clear 'indexing' on repos with no surviving work (replaces the old
 * blanket status reset and the repo:status 30-minute flip).
 */
export function recoverInterruptedIndexJobs(): void {
  const db = getDb();
  const resumed = db
    .prepare(
      `UPDATE repo_index_jobs
       SET state = 'queued', progress = 0, message = 'Resuming after restart', started_at = NULL
       WHERE state = 'running'`,
    )
    .run();

  const staleRepos = db
    .prepare(
      `SELECT id FROM repos WHERE status = 'indexing' AND NOT EXISTS (
         SELECT 1 FROM repo_index_jobs j
         WHERE j.repo_id = repos.id AND j.state IN ('queued', 'running')
       )`,
    )
    .all() as { id: string }[];
  for (const repo of staleRepos) refreshRepoStatus(repo.id);

  if (resumed.changes > 0) {
    console.log(`[IndexQueue] Re-queued ${resumed.changes} index job(s) interrupted by shutdown.`);
  }
  schedulePump();
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

function schedulePump(): void {
  if (pumpScheduled) return;
  pumpScheduled = true;
  queueMicrotask(() => {
    pumpScheduled = false;
    pump();
  });
}

function pump(): void {
  const db = getDb();

  while (runningMappedJobs < MAX_MAPPED_JOBS) {
    const job = db
      .prepare(
        `SELECT * FROM repo_index_jobs WHERE state = 'queued' AND tier = 'mapped'
         ORDER BY rowid LIMIT 1`,
      )
      .get() as DbIndexJobRow | undefined;
    if (!job) break;
    startJob(rowToJob(job));
  }

  const enrichCap = Math.max(1, llmPoolSize());
  while (runningEnrichedJobs < enrichCap) {
    // An enrichment job waits until the same repo's mapped job has finished.
    const job = db
      .prepare(
        `SELECT * FROM repo_index_jobs j
         WHERE j.state = 'queued' AND j.tier = 'enriched'
           AND NOT EXISTS (
             SELECT 1 FROM repo_index_jobs m
             WHERE m.repo_id = j.repo_id AND m.tier = 'mapped'
               AND m.state IN ('queued', 'running')
           )
         ORDER BY j.rowid LIMIT 1`,
      )
      .get() as DbIndexJobRow | undefined;
    if (!job) break;
    startJob(rowToJob(job));
  }
}

function startJob(job: RepoIndexJob): void {
  const db = getDb();
  // Claim the row before running so a second pump can't pick it up.
  const claimed = db
    .prepare(
      `UPDATE repo_index_jobs
       SET state = 'running', started_at = datetime('now'), message = 'Running'
       WHERE id = ? AND state = 'queued'`,
    )
    .run(job.id);
  if (claimed.changes === 0) return;

  if (job.tier === 'mapped') runningMappedJobs += 1;
  else runningEnrichedJobs += 1;

  const running: RepoIndexJob = { ...job, state: 'running' };
  emitJobState(running);
  refreshRepoStatus(job.repoId);

  const onProgress: RepoIndexProgressFn = (message, percent, stage, detail) => {
    try {
      db.prepare('UPDATE repo_index_jobs SET progress = ?, message = ? WHERE id = ?').run(
        percent,
        message,
        job.id,
      );
    } catch {
      /* job row may be gone if the repo was forgotten mid-run */
    }
    broadcastProgress({
      repoId: job.repoId,
      message,
      percent,
      stage,
      detail,
      jobId: job.id,
      jobTier: job.tier,
      jobState: 'running',
    });
  };

  const shouldCancel = () => cancelRequestedRepoIds.has(job.repoId);
  const work =
    job.tier === 'mapped'
      ? mapRepo(job.repoId, onProgress, { shouldCancel })
      : enrichRepo(job.repoId, onProgress, { shouldCancel, acquireLlmSlot: withLlmSlot });

  work
    .then((result: void | EnrichRepoResult) => {
      const cancelled = cancelRequestedRepoIds.has(job.repoId);
      // §7 funnel — content-hash skips vs real LLM calls per enrichment run.
      if (!cancelled && job.tier === 'enriched' && result != null) {
        trackActivationEvent('repo_enrich_completed', {
          calls: result.summarised + result.failed,
          skipped: result.skipped,
        });
      }
      finishJob(job.id, cancelled ? 'cancelled' : 'completed');
    })
    .catch((err) => {
      if (err instanceof RepoIndexCancelledError || cancelRequestedRepoIds.has(job.repoId)) {
        finishJob(job.id, 'cancelled');
      } else {
        console.error(`[IndexQueue] ${job.tier} job failed for repo ${job.repoId}:`, err);
        finishJob(job.id, 'failed', err instanceof Error ? err.message : String(err));
      }
    })
    .finally(() => {
      if (job.tier === 'mapped') runningMappedJobs -= 1;
      else runningEnrichedJobs -= 1;
      if (activeJobCount(job.repoId) === 0) cancelRequestedRepoIds.delete(job.repoId);
      refreshRepoStatus(job.repoId);
      settleRepoWaiters(job.repoId);
      schedulePump();
    });
}

function finishJob(jobId: string, state: RepoIndexJobState, error?: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE repo_index_jobs
     SET state = ?, progress = ?, message = ?, error = ?, finished_at = datetime('now')
     WHERE id = ?`,
  ).run(
    state,
    state === 'completed' ? 100 : 0,
    state === 'completed' ? 'Complete' : state === 'cancelled' ? 'Cancelled' : 'Failed',
    error ?? null,
    jobId,
  );
  const row = db.prepare('SELECT * FROM repo_index_jobs WHERE id = ?').get(jobId) as
    | DbIndexJobRow
    | undefined;
  if (row) emitJobState(rowToJob(row));

  // §7 funnel — local-only tier-reached timing (ms from job start to finish).
  if (row && state === 'completed') {
    const repo = db.prepare('SELECT file_count FROM repos WHERE id = ?').get(row.repo_id) as
      | { file_count: number | null }
      | undefined;
    const parseJobTime = (value: string | null) =>
      value ? Date.parse(`${value.replace(' ', 'T')}Z`) : Number.NaN;
    const startedMs = parseJobTime(row.started_at);
    const finishedMs = parseJobTime(row.finished_at);
    trackActivationEvent('repo_index_tier_reached', {
      tier: row.tier,
      ms: Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? finishedMs - startedMs : null,
      fileCount: repo?.file_count ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// Status derivation + broadcast
// ---------------------------------------------------------------------------

/**
 * repos.status is derived from the tier plus live job state:
 * active work → 'indexing'; mapped/enriched → 'indexed'; failed before any
 * tier was reached → 'error'; otherwise 'connected'.
 */
function refreshRepoStatus(repoId: string): void {
  const db = getDb();
  const repo = db.prepare('SELECT index_tier, status FROM repos WHERE id = ?').get(repoId) as
    | { index_tier: string | null; status: string }
    | undefined;
  if (!repo) return;

  let status: string;
  if (activeJobCount(repoId) > 0) {
    status = 'indexing';
  } else if (repo.index_tier === 'mapped' || repo.index_tier === 'enriched') {
    status = 'indexed';
  } else {
    const lastFinished = db
      .prepare(
        `SELECT state FROM repo_index_jobs
         WHERE repo_id = ? AND state IN ('completed', 'failed', 'cancelled')
         ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
      )
      .get(repoId) as { state: string } | undefined;
    status = lastFinished?.state === 'failed' ? 'error' : 'connected';
  }

  if (status !== repo.status) {
    db.prepare("UPDATE repos SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
      status,
      repoId,
    );
  }
}

function activeJobCount(repoId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM repo_index_jobs
       WHERE repo_id = ? AND state IN ('queued', 'running')`,
    )
    .get(repoId) as { c: number };
  return row.c;
}

function settleRepoWaiters(repoId: string): void {
  const waiters = repoWaiters.get(repoId);
  if (!waiters || waiters.length === 0) return;
  const remaining = waiters.filter((check) => !check());
  if (remaining.length === 0) repoWaiters.delete(repoId);
  else repoWaiters.set(repoId, remaining);
}

function broadcastProgress(payload: RepoIndexProgress): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('repo:index-progress', payload);
    }
  } catch {
    /* no windows yet — progress is still persisted on the job row */
  }
}

/** Emit a progress event carrying the job lifecycle transition. */
function emitJobState(job: RepoIndexJob): void {
  broadcastProgress({
    repoId: job.repoId,
    message: job.message,
    percent: job.progress,
    stage: job.state === 'completed' ? 'complete' : job.state === 'failed' ? 'error' : 'queued',
    jobId: job.id,
    jobTier: job.tier,
    jobState: job.state,
  });
}

function rowToJob(row: DbIndexJobRow): RepoIndexJob {
  return {
    id: row.id,
    repoId: row.repo_id,
    tier: row.tier as RepoIndexJobTier,
    state: row.state as RepoIndexJobState,
    reason: (row.reason as RepoIndexJob['reason']) ?? 'manual',
    progress: row.progress,
    message: row.message ?? '',
    error: row.error ?? undefined,
    queuedAt: row.queued_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}
