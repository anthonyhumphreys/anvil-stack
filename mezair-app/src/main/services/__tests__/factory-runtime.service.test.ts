import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';
import type {
  FactoryDefinition,
  FactoryEvidence,
  FactoryIssue,
  FactoryPrObservation,
  FactoryProvider,
} from '../../../shared/factories.js';
import { FactoryStore } from '../factory-persistence.service.js';
import { FactoryRuntime, type FactoryWorker } from '../factory-runtime.service.js';

const sha = 'a'.repeat(40),
  mergedSha = 'b'.repeat(40),
  tree = 'c'.repeat(40);
let db: Database.Database,
  store: FactoryStore,
  factory: FactoryDefinition,
  issue: FactoryIssue,
  provider: FactoryProvider,
  worker: FactoryWorker,
  runtime: FactoryRuntime,
  prExists: boolean,
  merges: number,
  publishes: number,
  now: Date,
  observation: FactoryPrObservation;
const evidence = (): FactoryEvidence => ({
  headSha: sha,
  treeSha: tree,
  criteria: [
    { criterion: 'Test passes', status: 'passed', evidence: 'npm test exited 0 at pinned tree' },
  ],
  commands: [{ command: 'npm test', exitCode: 0, output: 'ok' }],
  passed: true,
  checkedAt: now.toISOString(),
});
function run() {
  return store.listRuns(factory.id)[0];
}
async function advance() {
  const value = run();
  await runtime.advance(value.id);
  return run();
}
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('ws','Workspace','','')",
  ).run();
  store = new FactoryStore(db);
  now = new Date('2026-10-26T12:00:00Z');
  prExists = false;
  merges = 0;
  publishes = 0;
  factory = {
    id: 'factory',
    workspaceId: 'ws',
    revision: 1,
    activeRevision: 1,
    status: 'active',
    ownerId: 'owner',
    accountScope: 'scope',
    confirmation: 'reviewed',
    createdAt: '2026-10-26T11:00:00Z',
    activatedAt: '2026-10-26T11:00:00Z',
    updatedAt: '2026-10-26T11:00:00Z',
    workflow: {
      id: 'workflow',
      name: 'Implement',
      description: '',
      nodes: [],
      edges: [],
      createdAt: '',
      updatedAt: '',
    },
    definition: {
      name: 'Factory',
      workspaceId: 'ws',
      repoId: 'repo',
      github: {
        host: 'github.com',
        owner: 'acme',
        repo: 'repo',
        label: 'ready',
        baseBranch: 'main',
      },
      workflowTemplateId: 'workflow',
      criteria: ['Test passes'],
      checks: ['npm test'],
      postMergeChecks: ['npm test'],
      limits: { repairRounds: 2, maxRunMinutes: 90, maxCommands: 40, maxConcurrentRuns: 1 },
      publication: { enabled: true, draft: true },
      merge: {
        mode: 'auto-merge',
        method: 'squash',
        requiredChecks: ['CI'],
        requireApproval: true,
      },
      access: { kind: 'private' },
    },
  };
  store.saveRevision(factory);
  issue = {
    number: 7,
    title: 'Fix bug',
    body: 'Acceptance criteria',
    url: 'https://github.com/acme/repo/issues/7',
    labels: ['ready'],
    state: 'open',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  observation = {
    headSha: sha,
    state: 'open',
    draft: true,
    checks: [{ name: 'CI', headSha: sha, status: 'passed' }],
    review: 'approved',
    feedback: [],
    observedAt: now.toISOString(),
  };
  provider = {
    listIssues: vi.fn(async () => [issue]),
    readIssue: vi.fn(async () => issue),
    prepareCheckout: vi.fn(async (_f, _r, _k, guard) => {
      await guard?.();
      return { path: '/owned', branch: 'factory/7', baseSha: sha };
    }),
    verifyCheckout: vi.fn(async (_f, _r, _k, guard) => {
      await guard?.();
      return evidence();
    }),
    publishPullRequest: vi.fn(async (_f, _r, _k, guard) => {
      await guard?.();
      if (!prExists) {
        prExists = true;
        publishes++;
      }
      return {
        number: 11,
        url: 'https://github.com/acme/repo/pull/11',
        headSha: sha,
        branch: 'factory/7',
        baseBranch: 'main',
        draft: true,
      };
    }),
    readPullRequest: vi.fn(async () => structuredClone(observation)),
    requestMerge: vi.fn(async (_f, _r, _k, guard) => {
      await guard?.();
      merges++;
      return { requestedHeadSha: sha, state: 'queued' as const };
    }),
    cancelMerge: vi.fn(async (_f, _r, _k, guard) => {
      await guard?.();
      observation.mergeQueued = false;
    }),
    verifyMerged: vi.fn(async (_f, _r, _k, guard) => {
      await guard?.();
      return { ...evidence(), headSha: mergedSha, criteria: [] };
    }),
  };
  worker = {
    start: vi.fn(async () => ({ id: 'worker', threadId: 'thread' })),
    read: vi.fn(async () => ({ status: 'completed' as const, commandsUsed: 2 })),
    cancel: vi.fn(async () => {}),
    takeover: vi.fn(async () => 'private-takeover'),
  };
  runtime = new FactoryRuntime({
    store,
    provider,
    worker,
    authorize: async () => {},
    now: () => now,
  });
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('durable factory lifecycle', () => {
  it('deduplicates intake and waits for confirmed merge plus post-merge checks', async () => {
    await runtime.tick();
    expect(run().stage).toBe('merging');
    expect(run().commandsUsed).toBe(3);
    expect(publishes).toBe(1);
    expect(merges).toBe(1);
    await runtime.tick();
    expect(store.listRuns(factory.id)).toHaveLength(1);
    expect(run().stage).toBe('merging');
    observation = { ...observation, state: 'merged', draft: false, mergeCommitSha: mergedSha };
    await advance();
    expect(run().stage).toBe('completed');
    expect(run().postMergeEvidence?.headSha).toBe(mergedSha);
    expect(run().commandsUsed).toBe(4);
  });
  it('one source issue cannot start a competing lifecycle in another factory', () => {
    const other = { ...factory, id: 'other' };
    store.saveRevision(other);
    store.intake(factory, issue, now);
    expect(() => store.intake(other, issue, now)).toThrow('already claimed');
  });
  it('two runtimes produce one worker, PR and merge effect for duplicate issue deliveries', async () => {
    const second = new FactoryRuntime({
      store: new FactoryStore(db),
      provider,
      worker,
      authorize: async () => {},
      now: () => now,
    });
    await Promise.all([runtime.tick(), second.tick()]);
    expect(store.listRuns(factory.id)).toHaveLength(1);
    expect(worker.start).toHaveBeenCalledTimes(1);
    expect(publishes).toBe(1);
    expect(merges).toBe(1);
  });
  it('reconciles an uncertain publish using the same intent key without duplicating the PR', async () => {
    const normal = vi.mocked(provider.publishPullRequest).getMockImplementation()!;
    vi.mocked(provider.publishPullRequest).mockImplementationOnce(async (...args) => {
      await normal(...args);
      throw new Error('Lost response after provider write');
    });
    await runtime.tick();
    expect(run().stage).toBe('blocked');
    expect(publishes).toBe(1);
    expect(run().receipts.find((r) => r.kind === 'publish')?.status).toBe('uncertain');
    await runtime.control({ runId: run().id, action: 'retry' }, 'owner');
    await advance();
    expect(publishes).toBe(1);
    expect(run().stage).toBe('merging');
    const keys = vi.mocked(provider.publishPullRequest).mock.calls.map((call) => call[2]);
    expect(new Set(keys).size).toBe(1);
  });
  it('retains durable external waits across a new runtime instance', async () => {
    observation.checks = [{ name: 'CI', headSha: sha, status: 'pending' }];
    await runtime.tick();
    expect(run().stage).toBe('waiting-checks');
    const recovered = new FactoryRuntime({
      store: new FactoryStore(db),
      provider,
      worker,
      authorize: async () => {},
      now: () => now,
    });
    observation.checks = [{ name: 'CI', headSha: sha, status: 'passed' }];
    now = new Date(now.getTime() + 31000);
    await recovered.tick();
    expect(run().stage).toBe('merging');
    expect(worker.start).toHaveBeenCalledTimes(1);
  });
  it('invalidates evidence and approval when an unrelated PR head appears', async () => {
    observation.checks = [];
    await runtime.tick();
    observation.headSha = 'd'.repeat(40);
    await advance();
    expect(run().stage).toBe('blocked');
    expect(run().evidence).toBeUndefined();
    expect(run().mergeApprovalHead).toBeUndefined();
    expect(merges).toBe(0);
  });
  it('requires approval bound to the exact current verified head in manual mode', async () => {
    factory.definition.merge.mode = 'human-approved';
    store.updateFactory(factory);
    db.prepare('UPDATE factory_revisions SET record_json=? WHERE factory_id=?').run(
      JSON.stringify(factory),
      factory.id,
    );
    await runtime.tick();
    expect(run().stage).toBe('awaiting-merge-approval');
    expect(merges).toBe(0);
    await expect(
      runtime.control(
        { runId: run().id, action: 'approve-merge', expectedHeadSha: 'wrong' },
        'owner',
      ),
    ).rejects.toThrow('currently verified');
    await runtime.control(
      { runId: run().id, action: 'approve-merge', expectedHeadSha: sha },
      'owner',
    );
    await advance();
    expect(merges).toBe(1);
  });
  it('counts worker commands cumulatively across bounded repair rounds', async () => {
    observation.review = 'changes-requested';
    await runtime.tick();
    expect(run().stage).toBe('repairing');
    expect(run().commandsUsed).toBe(3);
    observation.review = 'approved';
    await advance();
    expect(run().commandsUsed).toBe(6);
    expect(run().repairRounds).toBe(1);
    expect(merges).toBe(1);
  });
  it('repairs failing local acceptance checks before publication within the configured limit', async () => {
    vi.mocked(provider.verifyCheckout).mockResolvedValueOnce({
      ...evidence(),
      passed: false,
      commands: [{ command: 'npm test', exitCode: 1, output: 'failed' }],
    });
    await runtime.tick();
    expect(run().stage).toBe('repairing');
    expect(publishes).toBe(0);
    await advance();
    expect(run().stage).toBe('merging');
    expect(run().commandsUsed).toBe(6);
  });
  it('stops on missing required reviews and does not accept the agent report', async () => {
    observation.review = 'pending';
    await runtime.tick();
    expect(run().stage).toBe('waiting-checks');
    expect(merges).toBe(0);
  });
  it('claims takeover before creating a fresh private continuation', async () => {
    observation.checks = [];
    await runtime.tick();
    vi.mocked(worker.takeover).mockImplementation(async (value) => {
      expect(store.getRun(value.id)?.pendingControl).toBeUndefined();
      expect(store.getRun(value.id)?.stage).toBe('taken-over');
      return 'private-takeover';
    });
    const result = await runtime.control({ runId: run().id, action: 'takeover' }, 'operator');
    expect(result.stage).toBe('taken-over');
    expect(result.takeoverThreadId).toBe('private-takeover');
    expect(result.takeoverRequestId).toBeUndefined();
    expect(worker.cancel).toHaveBeenCalled();
  });
  it('keeps cancellation pending through an uncertain provider result, then reconciles', async () => {
    await runtime.tick();
    vi.mocked(provider.cancelMerge).mockRejectedValueOnce(
      new Error('unknown direct async outcome'),
    );
    const pending = await runtime.control({ runId: run().id, action: 'cancel' }, 'owner');
    expect(pending.stage).toBe('cancelling');
    expect(pending.pendingControl).toBe('cancel');
    await expect(runtime.control({ runId: run().id, action: 'resume' }, 'owner')).rejects.toThrow(
      'reconcile',
    );
    await advance();
    expect(run().stage).toBe('cancelled');
    expect(run().pendingControl).toBeUndefined();
    expect(new Set(vi.mocked(provider.cancelMerge).mock.calls.map((call) => call[2])).size).toBe(1);
  });
  it('cancels a queued merge immediately after standing auto-merge authority is reduced', async () => {
    await runtime.tick();
    factory.definition.merge.mode = 'human-approved';
    factory.updatedAt = '2026-10-26T12:01:00Z';
    store.updateFactory(factory);
    observation.mergeQueued = true;
    await advance();
    expect(provider.cancelMerge).toHaveBeenCalled();
    expect(run().stage).toBe('paused');
    expect(run().mergeReceipt).toBeUndefined();
  });
  it('checks current stronger merge conditions immediately before the write', async () => {
    const original = vi.mocked(provider.requestMerge).getMockImplementation()!;
    vi.mocked(provider.requestMerge).mockImplementation(async (...args) => {
      const current = store.getFactory(factory.id)!;
      current.definition.merge.requiredChecks.push('Security');
      current.updatedAt = 'changed';
      store.updateFactory(current);
      return original(...args);
    });
    await runtime.tick();
    expect(merges).toBe(0);
    expect(run().stage).toBe('paused');
    expect(run().pendingControl).toBe('pause');
  });
  it('preserves a merge acknowledgement returned after pause and reconciles its async request identity', async () => {
    let release: (value: {
      requestedHeadSha: string;
      state: 'requested';
      providerRequestId: string;
    }) => void = () => {};
    const response = new Promise<{
      requestedHeadSha: string;
      state: 'requested';
      providerRequestId: string;
    }>((resolve) => {
      release = resolve;
    });
    vi.mocked(provider.requestMerge).mockImplementation(async (_f, _r, _key, guard) => {
      await guard?.();
      return response;
    });
    const work = runtime.tick();
    await vi.waitFor(() => expect(provider.requestMerge).toHaveBeenCalled());
    const paused = await runtime.control({ runId: run().id, action: 'pause' }, 'owner');
    expect(paused.pendingControl).toBe('pause');
    release({ requestedHeadSha: sha, state: 'requested', providerRequestId: 'async-uuid' });
    await work;
    vi.mocked(provider.cancelMerge).mockImplementation(async (_f, value) => {
      expect(value.mergeReceipt?.providerRequestId).toBe('async-uuid');
      throw new Error('direct async outcome still pending');
    });
    await advance();
    expect(run().pendingControl).toBe('pause');
    expect(run().stage).toBe('paused');
    expect(run().mergeReceipt?.providerRequestId).toBe('async-uuid');
    observation = { ...observation, state: 'merged', mergeCommitSha: mergedSha };
    await advance();
    expect(run().pendingControl).toBeUndefined();
    expect(run().observation?.state).toBe('merged');
    expect(run().error).toContain('before cancellation');
  });
  it('does not claim cancellation of an uncertain merge intent merely because no queue is observed', async () => {
    vi.mocked(provider.requestMerge).mockRejectedValueOnce(new Error('lost merge response'));
    await runtime.tick();
    expect(run().stage).toBe('paused');
    await runtime.control({ runId: run().id, action: 'cancel' }, 'owner');
    expect(run().stage).toBe('cancelling');
    expect(run().pendingControl).toBe('cancel');
    expect(run().error).toContain('unknown provider outcome');
    expect(provider.cancelMerge).not.toHaveBeenCalled();
  });
  it('remote takeover correlates the confirmed claim and never creates an owner-private thread', async () => {
    observation.checks = [];
    await runtime.tick();
    const result = await runtime.control(
      { runId: run().id, action: 'takeover', requestId: 'remote-claim' },
      'member',
    );
    expect(result.stage).toBe('taken-over');
    expect(result.takeoverRequestId).toBe('remote-claim');
    expect(result.takeoverThreadId).toBeUndefined();
    expect(worker.takeover).not.toHaveBeenCalled();
  });
  it('handles an org factory paused outside the runner using cleanup authority rather than execute', async () => {
    await runtime.tick();
    factory.status = 'paused';
    store.updateFactory(factory);
    const authorize = vi.fn(async (current: FactoryDefinition, action: string) => {
      if (action === 'execute' && current.status !== 'active')
        throw new Error('inactive execution denied');
    });
    const cleanup = new FactoryRuntime({ store, provider, worker, authorize, now: () => now });
    await cleanup.advance(run().id);
    expect(provider.cancelMerge).toHaveBeenCalled();
    expect(run().stage).toBe('paused');
    expect(run().pendingControl).toBeUndefined();
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ status: 'paused' }), 'cancel');
  });
  it('observes an irreversible merge after the cancel API and routes through post-merge verification', async () => {
    await runtime.tick();
    vi.mocked(provider.cancelMerge).mockImplementation(async (_f, _r, _k, guard) => {
      await guard?.();
      observation = {
        ...observation,
        state: 'merged',
        mergeCommitSha: mergedSha,
        mergeQueued: false,
      };
    });
    const result = await runtime.control({ runId: run().id, action: 'cancel' }, 'owner');
    expect(result.stage).toBe('verifying-merge');
    expect(result.mergeReceipt?.state).toBe('merged');
    expect(result.observation?.state).toBe('merged');
    await advance();
    expect(run().stage).toBe('completed');
    expect(run().postMergeEvidence?.headSha).toBe(mergedSha);
  });
  it('cancels queued merge eligibility before starting review repairs', async () => {
    await runtime.tick();
    observation.review = 'changes-requested';
    observation.mergeQueued = true;
    await advance();
    expect(provider.cancelMerge).toHaveBeenCalled();
    expect(run().stage).toBe('paused');
    expect(run().repairRounds).toBe(0);
    expect(run().mergeReceipt).toBeUndefined();
  });
  it('cancels a queued merge when new current required checks are missing', async () => {
    await runtime.tick();
    const current = store.getFactory(factory.id)!;
    current.definition.merge.requiredChecks.push('Security');
    current.updatedAt = 'new-policy';
    store.updateFactory(current);
    observation.mergeQueued = true;
    await advance();
    expect(provider.cancelMerge).toHaveBeenCalled();
    expect(run().stage).toBe('paused');
    expect(run().mergeReceipt).toBeUndefined();
  });
  it('records a fresh preflight denial as failed without claiming an unknown external write', async () => {
    const denied = new FactoryRuntime({
      store,
      provider,
      worker,
      now: () => now,
      authorize: async (_factory, action) => {
        if (action === 'merge') throw new Error('merge authority revoked');
      },
    });
    await denied.tick();
    expect(provider.requestMerge).not.toHaveBeenCalled();
    expect(run().stage).toBe('blocked');
    expect(run().pendingControl).toBeUndefined();
    expect(run().receipts.find((receipt) => receipt.kind === 'merge')?.status).toBe('failed');
  });
  it('keeps the lease alive during a long effect so a second scheduler cannot duplicate it', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = vi.mocked(provider.publishPullRequest).getMockImplementation()!;
    vi.mocked(provider.publishPullRequest).mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    const first = new FactoryRuntime({
      store,
      provider,
      worker,
      authorize: async () => {},
      leaseMs: 40,
      heartbeatMs: 10,
    });
    const second = new FactoryRuntime({
      store,
      provider,
      worker,
      authorize: async () => {},
      leaseMs: 40,
      heartbeatMs: 10,
    });
    const work = first.tick();
    await vi.waitFor(() => expect(provider.publishPullRequest).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await second.tick();
    expect(provider.publishPullRequest).toHaveBeenCalledTimes(1);
    release();
    await work;
    expect(publishes).toBe(1);
  });
});
