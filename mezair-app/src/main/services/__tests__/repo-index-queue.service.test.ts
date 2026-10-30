import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

const { mockMapRepo, mockEnrichRepo, sentMessages } = vi.hoisted(() => ({
  mockMapRepo: vi.fn(),
  mockEnrichRepo: vi.fn(),
  sentMessages: [] as Array<{ channel: string; payload: Record<string, unknown> }>,
}));

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: Record<string, unknown>) =>
            sentMessages.push({ channel, payload }),
        },
      },
    ],
  },
}));

vi.mock('../settings.service.js', () => ({
  getSettings: () => ({ llmProvider: 'openai' }),
}));

// The mocked module supplies its own RepoIndexCancelledError; the queue's
// instanceof check works because the mock is the only copy under test.
vi.mock('../repo-index.service.js', () => ({
  mapRepo: mockMapRepo,
  enrichRepo: mockEnrichRepo,
  RepoIndexCancelledError: class RepoIndexCancelledError extends Error {
    constructor(repoId: string) {
      super(`Index job cancelled for repo ${repoId}`);
      this.name = 'RepoIndexCancelledError';
    }
  },
}));

import {
  cancelIndexJobs,
  enqueueIndexJobs,
  listRepoIndexJobs,
  recoverInterruptedIndexJobs,
  waitForRepoIndexJobs,
} from '../repo-index-queue.service.js';
import { RepoIndexCancelledError } from '../repo-index.service.js';

function seedRepo(id: string, status = 'connected', indexTier = 'connected'): void {
  inMemoryDb
    .prepare(
      `INSERT INTO repos (id, name, path, status, index_tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, id, `/tmp/${id}`, status, indexTier);
}

function repoRow(id: string): { status: string; index_tier: string } {
  return inMemoryDb.prepare('SELECT status, index_tier FROM repos WHERE id = ?').get(id) as {
    status: string;
    index_tier: string;
  };
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  inMemoryDb.exec('DELETE FROM repo_index_jobs');
  inMemoryDb.exec('DELETE FROM repos');
  sentMessages.length = 0;
  vi.clearAllMocks();
  mockMapRepo.mockImplementation(async (repoId: string) => {
    inMemoryDb
      .prepare("UPDATE repos SET index_tier = 'mapped', status = 'indexed' WHERE id = ?")
      .run(repoId);
  });
  mockEnrichRepo.mockImplementation(async (repoId: string) => {
    inMemoryDb
      .prepare("UPDATE repos SET index_tier = 'enriched', status = 'indexed' WHERE id = ?")
      .run(repoId);
  });
});

describe('enqueueIndexJobs', () => {
  it('creates mapped + enriched jobs and marks the repo indexing', async () => {
    seedRepo('r1');
    const jobs = enqueueIndexJobs('r1', { reason: 'connect' });

    expect(jobs.map((j) => j.tier)).toEqual(['mapped', 'enriched']);
    expect(jobs.every((j) => j.state === 'queued')).toBe(true);
    expect(repoRow('r1').status).toBe('indexing');

    await waitForRepoIndexJobs('r1');
    expect(mockMapRepo).toHaveBeenCalledWith('r1', expect.any(Function), expect.any(Object));
    expect(mockEnrichRepo).toHaveBeenCalledWith('r1', expect.any(Function), expect.any(Object));
    expect(repoRow('r1')).toEqual({ status: 'indexed', index_tier: 'enriched' });
  });

  it('dedupes against already queued/running jobs (single concurrency guard)', async () => {
    seedRepo('r2');
    const first = enqueueIndexJobs('r2', { reason: 'connect' });
    const second = enqueueIndexJobs('r2', { reason: 'manual' });

    expect(second.map((j) => j.id)).toEqual(first.map((j) => j.id));
    const rows = inMemoryDb
      .prepare("SELECT COUNT(*) AS c FROM repo_index_jobs WHERE repo_id = 'r2'")
      .get() as { c: number };
    expect(rows.c).toBe(2);

    await waitForRepoIndexJobs('r2');
    expect(mockMapRepo).toHaveBeenCalledTimes(1);
    expect(mockEnrichRepo).toHaveBeenCalledTimes(1);
  });

  it('runs the enriched job only after the same repo’s mapped job finishes', async () => {
    seedRepo('r3');
    const order: string[] = [];
    mockMapRepo.mockImplementation(async (repoId: string) => {
      order.push(`map:${repoId}`);
      inMemoryDb
        .prepare("UPDATE repos SET index_tier = 'mapped', status = 'indexed' WHERE id = ?")
        .run(repoId);
    });
    mockEnrichRepo.mockImplementation(async (repoId: string) => {
      order.push(`enrich:${repoId}`);
      inMemoryDb
        .prepare("UPDATE repos SET index_tier = 'enriched', status = 'indexed' WHERE id = ?")
        .run(repoId);
    });

    enqueueIndexJobs('r3', { reason: 'connect' });
    await waitForRepoIndexJobs('r3');

    expect(order).toEqual(['map:r3', 'enrich:r3']);
  });
});

describe('cancelIndexJobs', () => {
  it('cancels queued jobs and restores the derived status', async () => {
    seedRepo('r4');
    // Block the mapped job so the repo's jobs stay active until we release it.
    let release: () => void = () => {};
    mockMapRepo.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    enqueueIndexJobs('r4', { reason: 'connect' });
    await flushMicrotasks();

    // mapped is running, enriched is still queued — cancel both.
    cancelIndexJobs('r4');
    release();
    const jobs = await waitForRepoIndexJobs('r4');

    expect(jobs.map((j) => j.state).sort()).toEqual(['cancelled', 'cancelled']);
    expect(repoRow('r4').status).toBe('connected');
  });

  it('marks a running job cancelled when the worker honours shouldCancel', async () => {
    seedRepo('r5');
    mockMapRepo.mockImplementation(async (repoId: string, _p, options) => {
      // Simulate hitting a cancellation checkpoint mid-run.
      if (options?.shouldCancel?.()) throw new RepoIndexCancelledError(repoId);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (options?.shouldCancel?.()) throw new RepoIndexCancelledError(repoId);
      inMemoryDb
        .prepare("UPDATE repos SET index_tier = 'mapped', status = 'indexed' WHERE id = ?")
        .run(repoId);
    });

    enqueueIndexJobs('r5', { reason: 'connect', tiers: ['mapped'] });
    await flushMicrotasks();
    cancelIndexJobs('r5');
    const jobs = await waitForRepoIndexJobs('r5');

    expect(jobs[0].state).toBe('cancelled');
    expect(repoRow('r5').status).toBe('connected');
  });
});

describe('crash recovery', () => {
  it('re-queues interrupted running jobs and clears stale indexing status', async () => {
    seedRepo('r6', 'indexing');
    seedRepo('r7', 'indexing', 'mapped');
    // r6 died mid-job; r7 just has a stale status and no surviving job.
    inMemoryDb
      .prepare(
        `INSERT INTO repo_index_jobs (id, repo_id, tier, state, reason, queued_at, started_at)
         VALUES ('job-r6', 'r6', 'mapped', 'running', 'connect', datetime('now'), datetime('now'))`,
      )
      .run();

    recoverInterruptedIndexJobs();
    await waitForRepoIndexJobs('r6');
    await flushMicrotasks();

    const job = listRepoIndexJobs('r6').find((j) => j.id === 'job-r6');
    expect(job?.state).toBe('completed');
    expect(mockMapRepo).toHaveBeenCalledWith('r6', expect.any(Function), expect.any(Object));
    // r7 has no jobs: status falls back to its tier ('mapped' → 'indexed').
    expect(repoRow('r7').status).toBe('indexed');
  });
});

describe('progress broadcast', () => {
  it('broadcasts repo:index-progress with job metadata to all windows', async () => {
    seedRepo('r8');
    enqueueIndexJobs('r8', { reason: 'manual' });
    await waitForRepoIndexJobs('r8');

    const events = sentMessages.filter((m) => m.channel === 'repo:index-progress');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.payload.repoId === 'r8')).toBe(true);
    expect(events.some((e) => e.payload.jobState === 'completed')).toBe(true);
    expect(events.every((e) => typeof e.payload.jobId === 'string')).toBe(true);
  });
});

describe('failure handling', () => {
  it('marks the job failed and sets error status when no tier was reached', async () => {
    seedRepo('r9');
    mockMapRepo.mockRejectedValue(new Error('disk exploded'));
    mockEnrichRepo.mockRejectedValue(new Error('llm exploded'));

    enqueueIndexJobs('r9', { reason: 'connect' });
    const jobs = await waitForRepoIndexJobs('r9');

    expect(jobs.find((j) => j.tier === 'mapped')?.state).toBe('failed');
    expect(jobs.find((j) => j.tier === 'mapped')?.error).toContain('disk exploded');
    expect(repoRow('r9').status).toBe('error');
  });

  it('keeps indexed status when enrichment fails on an already-mapped repo', async () => {
    seedRepo('r10', 'indexed', 'mapped');
    mockEnrichRepo.mockRejectedValue(new Error('llm exploded'));

    enqueueIndexJobs('r10', { reason: 'manual', tiers: ['enriched'] });
    const jobs = await waitForRepoIndexJobs('r10');

    expect(jobs[0].state).toBe('failed');
    expect(repoRow('r10').status).toBe('indexed');
  });
});
