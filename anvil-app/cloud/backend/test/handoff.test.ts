import { describe, expect, it } from 'vitest';

import type {
  HandoffCheckpoint,
  HandoffRecord,
  SealedSessionCheckpoint,
  SessionCheckpoint,
} from '../../contract/handoff';
import { isSealedCheckpoint } from '../../contract/handoff';
import type { RpcError } from '../../contract/envelope';
import { expectSuccess, postRpc, spikeBearer, uniqueIds } from './helpers';

const ACCT = uniqueIds('handoff').accountId;
const SRC = `enr-src-${crypto.randomUUID().slice(0, 8)}`;
const TGT = `enr-tgt-${crypto.randomUUID().slice(0, 8)}`;
const SRC_AUTH = spikeBearer(ACCT, SRC);
const TGT_AUTH = spikeBearer(ACCT, TGT);

function checkpointFor(sessionId: string, generation: number): SessionCheckpoint {
  return {
    sessionId,
    schemaVersion: 1,
    sourceGeneration: generation,
    repositories: [{ repositoryId: 'p1', commit: 'abc123' }],
    provider: 'codex',
    model: 'gpt-5',
    summary: 'turn summary',
    artifactRefs: [],
    unresolvedApprovals: [],
  };
}

async function provision(enrollmentAuth: string): Promise<void> {
  // sync.push provisions the authenticating enrollment even with no changes.
  expectSuccess(await postRpc('sync.push', { changes: [] }, enrollmentAuth));
}

async function createHandoff(
  sessionId: string,
  generation = 1,
  handoffId = crypto.randomUUID(),
): Promise<HandoffRecord> {
  const res = expectSuccess<{ handoff: HandoffRecord }>(
    await postRpc(
      'handoff.create',
      {
        handoffId,
        sessionId,
        sourceEnrollmentId: SRC,
        targetEnrollmentId: TGT,
        sourceGeneration: generation,
      },
      SRC_AUTH,
    ),
  );
  return res.handoff;
}

async function advance(
  handoffId: string,
  from: string,
  to: string,
  auth: string,
  checkpoint?: HandoffCheckpoint,
) {
  return postRpc(
    'handoff.advance',
    { handoffId, from, to, ...(checkpoint === undefined ? {} : { checkpoint }) },
    auth,
  );
}

async function advanceOk(
  handoffId: string,
  from: string,
  to: string,
  auth: string,
  checkpoint?: HandoffCheckpoint,
): Promise<HandoffRecord> {
  return expectSuccess<{ handoff: HandoffRecord }>(
    await advance(handoffId, from, to, auth, checkpoint),
  ).handoff;
}

// Both participants must be provisioned before handoff.create accepts them.
await provision(SRC_AUTH);
await provision(TGT_AUTH);

describe('handoff.create', () => {
  it('creates a requested handoff and binds the session generation', async () => {
    const h = await createHandoff(`sess-${crypto.randomUUID()}`);
    expect(h.state).toBe('requested');
    expect(h.sourceGeneration).toBe(1);
    expect(h.targetGeneration).toBeNull();
    expect(h.checkpoint).toBeNull();
  });

  it('is idempotent on handoffId and conflicts on param reuse', async () => {
    const sessionId = `sess-${crypto.randomUUID()}`;
    const handoffId = crypto.randomUUID();
    const first = await createHandoff(sessionId, 1, handoffId);
    const replay = await createHandoff(sessionId, 1, handoffId);
    expect(replay.id).toBe(first.id);
    expect(replay.state).toBe('requested');

    const reused = await postRpc(
      'handoff.create',
      {
        handoffId,
        sessionId,
        sourceEnrollmentId: SRC,
        targetEnrollmentId: TGT,
        sourceGeneration: 2,
      },
      SRC_AUTH,
    );
    expect((reused.body as RpcError).error.code).toBe('conflict');
  });

  it('rejects a second in-flight handoff for the same session', async () => {
    const sessionId = `sess-${crypto.randomUUID()}`;
    await createHandoff(sessionId);
    const second = await postRpc(
      'handoff.create',
      {
        handoffId: crypto.randomUUID(),
        sessionId,
        sourceEnrollmentId: SRC,
        targetEnrollmentId: TGT,
        sourceGeneration: 1,
      },
      SRC_AUTH,
    );
    expect((second.body as RpcError).error.code).toBe('conflict');
    expect((second.body as RpcError).error.details?.['reason']).toBe('handoff-in-flight');
  });

  it('rejects a source generation or owner that does not match the bound session', async () => {
    const sessionId = `sess-${crypto.randomUUID()}`;
    await createHandoff(sessionId, 1);
    // Complete the first handoff so a second may open.
    const stale = await postRpc(
      'handoff.create',
      {
        handoffId: crypto.randomUUID(),
        sessionId,
        sourceEnrollmentId: SRC,
        targetEnrollmentId: TGT,
        sourceGeneration: 7,
      },
      SRC_AUTH,
    );
    expect((stale.body as RpcError).error.code).toBe('stale-generation');
  });

  it('rejects unenrolled participants and self-handoff', async () => {
    const sessionId = `sess-${crypto.randomUUID()}`;
    const unenrolled = await postRpc(
      'handoff.create',
      {
        handoffId: crypto.randomUUID(),
        sessionId,
        sourceEnrollmentId: SRC,
        targetEnrollmentId: `enr-ghost-${crypto.randomUUID().slice(0, 8)}`,
        sourceGeneration: 1,
      },
      SRC_AUTH,
    );
    expect((unenrolled.body as RpcError).error.code).toBe('forbidden');

    const self = await postRpc(
      'handoff.create',
      {
        handoffId: crypto.randomUUID(),
        sessionId,
        sourceEnrollmentId: SRC,
        targetEnrollmentId: SRC,
        sourceGeneration: 1,
      },
      SRC_AUTH,
    );
    expect((self.body as RpcError).error.code).toBe('malformed-request');
  });
});

describe('handoff.advance', () => {
  it('drives the full transfer with per-side enrollment gates', async () => {
    const sessionId = `sess-${crypto.randomUUID()}`;
    const h = await createHandoff(sessionId, 1);

    const prepared = await advanceOk(
      h.id,
      'requested',
      'target-prepared-without-execution',
      SRC_AUTH,
    );
    expect(prepared.state).toBe('target-prepared-without-execution');

    // Only the source enrollment may quiesce/relinquish.
    const wrongSide = await advance(
      h.id,
      'target-prepared-without-execution',
      'source-quiescing',
      TGT_AUTH,
    );
    expect((wrongSide.body as RpcError).error.code).toBe('forbidden');

    await advanceOk(h.id, 'target-prepared-without-execution', 'source-quiescing', SRC_AUTH);
    const relinquished = await advanceOk(
      h.id,
      'source-quiescing',
      'source-relinquished-and-checkpointed',
      SRC_AUTH,
      checkpointFor(sessionId, 1),
    );
    expect(
      relinquished.checkpoint !== null &&
        !isSealedCheckpoint(relinquished.checkpoint) &&
        relinquished.checkpoint.summary,
    ).toBe('turn summary');

    const transferred = await advanceOk(
      h.id,
      'source-relinquished-and-checkpointed',
      'ownership-transferred',
      SRC_AUTH,
    );
    expect(transferred.targetGeneration).toBe(2);

    // Only the target enrollment may activate/complete.
    const wrongActivate = await advance(
      h.id,
      'ownership-transferred',
      'target-activating',
      SRC_AUTH,
    );
    expect((wrongActivate.body as RpcError).error.code).toBe('forbidden');

    await advanceOk(h.id, 'ownership-transferred', 'target-activating', TGT_AUTH);
    const done = await advanceOk(h.id, 'target-activating', 'completed', TGT_AUTH);
    expect(done.state).toBe('completed');
  });

  it('transfers the session generation exactly once', async () => {
    const sessionId = `sess-${crypto.randomUUID()}`;
    const h = await createHandoff(sessionId, 1);
    await advanceOk(h.id, 'requested', 'target-prepared-without-execution', SRC_AUTH);
    await advanceOk(h.id, 'target-prepared-without-execution', 'source-quiescing', SRC_AUTH);
    await advanceOk(
      h.id,
      'source-quiescing',
      'source-relinquished-and-checkpointed',
      SRC_AUTH,
      checkpointFor(sessionId, 1),
    );
    await advanceOk(
      h.id,
      'source-relinquished-and-checkpointed',
      'ownership-transferred',
      SRC_AUTH,
    );
    await advanceOk(h.id, 'ownership-transferred', 'target-activating', TGT_AUTH);
    await advanceOk(h.id, 'target-activating', 'completed', TGT_AUTH);

    // The source can no longer assert generation 1 — the target owns 2 now.
    const stale = await postRpc(
      'handoff.create',
      {
        handoffId: crypto.randomUUID(),
        sessionId,
        sourceEnrollmentId: SRC,
        targetEnrollmentId: TGT,
        sourceGeneration: 1,
      },
      SRC_AUTH,
    );
    expect((stale.body as RpcError).error.code).toBe('forbidden');

    // A new handoff back the other way binds against the target's generation.
    const back = expectSuccess<{ handoff: HandoffRecord }>(
      await postRpc(
        'handoff.create',
        {
          handoffId: crypto.randomUUID(),
          sessionId,
          sourceEnrollmentId: TGT,
          targetEnrollmentId: SRC,
          sourceGeneration: 2,
        },
        TGT_AUTH,
      ),
    );
    expect(back.handoff.sourceGeneration).toBe(2);
  });

  it('rejects CAS state mismatches and illegal edges', async () => {
    const sessionId = `sess-${crypto.randomUUID()}`;
    const h = await createHandoff(sessionId, 1);

    const skipped = await advance(h.id, 'requested', 'completed', SRC_AUTH);
    expect((skipped.body as RpcError).error.code).toBe('invalid-transition');

    await advanceOk(h.id, 'requested', 'target-prepared-without-execution', SRC_AUTH);
    const mismatched = await advance(h.id, 'requested', 'source-quiescing', SRC_AUTH);
    expect((mismatched.body as RpcError).error.code).toBe('conflict');
  });

  it('requires a matching checkpoint on relinquish', async () => {
    const sessionId = `sess-${crypto.randomUUID()}`;
    const h = await createHandoff(sessionId, 1);
    await advanceOk(h.id, 'requested', 'target-prepared-without-execution', SRC_AUTH);
    await advanceOk(h.id, 'target-prepared-without-execution', 'source-quiescing', SRC_AUTH);

    const missing = await advance(
      h.id,
      'source-quiescing',
      'source-relinquished-and-checkpointed',
      SRC_AUTH,
    );
    expect((missing.body as RpcError).error.code).toBe('malformed-request');

    const wrongSession = await advance(
      h.id,
      'source-quiescing',
      'source-relinquished-and-checkpointed',
      SRC_AUTH,
      checkpointFor('sess-other', 1),
    );
    expect((wrongSession.body as RpcError).error.code).toBe('malformed-request');
  });

  it('accepts a sealed checkpoint: clear CAS fields, opaque body', async () => {
    const sessionId = `sess-${crypto.randomUUID()}`;
    const h = await createHandoff(sessionId, 1);
    await advanceOk(h.id, 'requested', 'target-prepared-without-execution', SRC_AUTH);
    await advanceOk(h.id, 'target-prepared-without-execution', 'source-quiescing', SRC_AUTH);

    const sealed: SealedSessionCheckpoint = {
      enc: 'aes-256-gcm',
      keyVersion: 1,
      nonce: Buffer.alloc(12, 3).toString('base64'),
      ct: Buffer.alloc(48, 4).toString('base64'),
      sessionId,
      sourceGeneration: 1,
    };
    const relinquished = await advanceOk(
      h.id,
      'source-quiescing',
      'source-relinquished-and-checkpointed',
      SRC_AUTH,
      sealed,
    );
    expect(isSealedCheckpoint(relinquished.checkpoint!)).toBe(true);
    expect((relinquished.checkpoint as typeof sealed).ct).toBe(sealed.ct);

    // The CAS assertions still apply to the clear fields.
    const h2 = await createHandoff(`sess-${crypto.randomUUID()}`, 1);
    await advanceOk(h2.id, 'requested', 'target-prepared-without-execution', SRC_AUTH);
    await advanceOk(h2.id, 'target-prepared-without-execution', 'source-quiescing', SRC_AUTH);
    const mismatch = await advance(
      h2.id,
      'source-quiescing',
      'source-relinquished-and-checkpointed',
      SRC_AUTH,
      { ...sealed, sessionId: 'sess-other' },
    );
    expect((mismatch.body as RpcError).error.code).toBe('malformed-request');

    // And a malformed sealed body is rejected outright.
    const h3 = await createHandoff(`sess-${crypto.randomUUID()}`, 1);
    await advanceOk(h3.id, 'requested', 'target-prepared-without-execution', SRC_AUTH);
    await advanceOk(h3.id, 'target-prepared-without-execution', 'source-quiescing', SRC_AUTH);
    const bad = await advance(
      h3.id,
      'source-quiescing',
      'source-relinquished-and-checkpointed',
      SRC_AUTH,
      { ...sealed, nonce: '!!bad!!' },
    );
    expect((bad.body as RpcError).error.code).toBe('malformed-request');
  });
});

describe('handoff.cancel', () => {
  it('records the cancelled-from boundary and is idempotent on terminal rows', async () => {
    const sessionId = `sess-${crypto.randomUUID()}`;
    const h = await createHandoff(sessionId, 1);
    const cancelled = expectSuccess<{ handoff: HandoffRecord }>(
      await postRpc('handoff.cancel', { handoffId: h.id, reason: 'user' }, SRC_AUTH),
    ).handoff;
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.cancelledFrom).toBe('requested');
    expect(cancelled.cancelReason).toBe('user');

    const again = expectSuccess<{ handoff: HandoffRecord }>(
      await postRpc('handoff.cancel', { handoffId: h.id }, TGT_AUTH),
    ).handoff;
    expect(again.state).toBe('cancelled');
  });

  it('cancels post-transfer while leaving ownership with the target', async () => {
    const sessionId = `sess-${crypto.randomUUID()}`;
    const h = await createHandoff(sessionId, 1);
    await advanceOk(h.id, 'requested', 'target-prepared-without-execution', SRC_AUTH);
    await advanceOk(h.id, 'target-prepared-without-execution', 'source-quiescing', SRC_AUTH);
    await advanceOk(
      h.id,
      'source-quiescing',
      'source-relinquished-and-checkpointed',
      SRC_AUTH,
      checkpointFor(sessionId, 1),
    );
    await advanceOk(
      h.id,
      'source-relinquished-and-checkpointed',
      'ownership-transferred',
      SRC_AUTH,
    );

    const cancelled = expectSuccess<{ handoff: HandoffRecord }>(
      await postRpc('handoff.cancel', { handoffId: h.id }, TGT_AUTH),
    ).handoff;
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.cancelledFrom).toBe('ownership-transferred');
    expect(cancelled.targetGeneration).toBe(2);

    // Ownership stays with the target: the source cannot re-bind at gen 1.
    const rebind = await postRpc(
      'handoff.create',
      {
        handoffId: crypto.randomUUID(),
        sessionId,
        sourceEnrollmentId: SRC,
        targetEnrollmentId: TGT,
        sourceGeneration: 1,
      },
      SRC_AUTH,
    );
    expect((rebind.body as RpcError).error.code).toBe('forbidden');
  });

  it('rejects cancellation by a non-participant enrollment', async () => {
    const third = spikeBearer(ACCT, `enr-third-${crypto.randomUUID().slice(0, 8)}`);
    await provision(third);
    const h = await createHandoff(`sess-${crypto.randomUUID()}`, 1);
    const res = await postRpc('handoff.cancel', { handoffId: h.id }, third);
    expect((res.body as RpcError).error.code).toBe('forbidden');
  });
});
