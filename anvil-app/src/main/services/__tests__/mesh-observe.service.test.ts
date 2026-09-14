import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityFrame, GapFrame } from '../../../../cloud/contract/socket';
import type { AttemptActivity } from '../mesh-observe.service';

interface RpcCall {
  operation: string;
  params: unknown;
}

const rpcCalls: RpcCall[] = [];
let rpcHandler: (operation: string, params: unknown) => unknown = () => ({});

vi.mock('../sync-backend-client.service.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../sync-backend-client.service.js')>();
  return {
    ...original,
    rpc: async (
      _connection: unknown,
      operation: string,
      params: unknown,
    ): Promise<{ result: unknown; serverTime: string }> => {
      rpcCalls.push({ operation, params });
      return { result: rpcHandler(operation, params), serverTime: '' };
    },
  };
});

import {
  configureMeshObserverContext,
  handleActivityFrame,
  handleGapFrame,
  meshObserverOnGone,
  meshObserverOnLive,
  observeAttempt,
  resetMeshObserverForTests,
} from '../mesh-observe.service';

const sentFrames: Array<Record<string, unknown>> = [];
let live = true;

const CTX = {
  apiUrl: 'https://backend.test/v1',
  accessToken: 'tok',
  enrollmentId: 'enr-src',
  sendFrame: (frame: unknown) => {
    sentFrames.push(frame as Record<string, unknown>);
  },
  isLive: () => live,
};

function activityFrame(attemptId: string, sequence: number, text: string): ActivityFrame {
  return {
    type: 'activity',
    version: 1,
    id: `f-${sequence}`,
    attemptId,
    generation: 1,
    streamId: `attempt:${attemptId}`,
    sequence,
    payload: { kind: 'status', text, byteLength: text.length, truncated: false },
  };
}

function gapFrame(attemptId: string, from: number, to: number): GapFrame {
  return {
    type: 'gap',
    version: 1,
    id: `g-${from}`,
    attemptId,
    streamId: `attempt:${attemptId}`,
    fromSequence: from,
    toSequence: to,
  };
}

function durableEvent(
  cursor: number,
  attemptId: string,
  sequence: number,
  kind: string,
  payload: unknown,
): Record<string, unknown> {
  return {
    cursor,
    jobId: 'job-1',
    attemptId,
    streamId: `attempt:${attemptId}`,
    sequence,
    kind,
    generation: 1,
    payload,
    createdAt: '2026-09-13T00:00:00.000Z',
  };
}

beforeEach(() => {
  rpcCalls.length = 0;
  sentFrames.length = 0;
  live = true;
  rpcHandler = () => ({
    scopeKind: 'attempt',
    scopeId: 'x',
    jobId: 'job-1',
    events: [],
    nextCursor: 0,
    hasMore: false,
    hasGap: false,
  });
  resetMeshObserverForTests();
  configureMeshObserverContext(() => CTX);
});

describe('observeAttempt', () => {
  it('sends a subscribe frame and delivers activity to the listener', async () => {
    const received: AttemptActivity[] = [];
    const stop = observeAttempt('att-1', (a) => received.push(a));
    expect(sentFrames.some((f) => f['type'] === 'subscribe' && f['scope'] === 'attempt:att-1')).toBe(
      true,
    );
    // Let the initial replayEvents promise settle before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    handleActivityFrame(activityFrame('att-1', 1, 'hello'));
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('hello');
    expect(received[0].sequence).toBe(1);
    stop();
    expect(sentFrames.some((f) => f['type'] === 'unsubscribe')).toBe(true);
  });

  it('replays durable events the socket missed via event.pull', async () => {
    rpcHandler = (op) => {
      if (op === 'event.pull') {
        return {
          scopeKind: 'attempt',
          scopeId: 'att-2',
          jobId: 'job-1',
          events: [
            durableEvent(1, 'att-2', 0, 'attempt.state', { state: 'claimed' }),
            durableEvent(2, 'att-2', 1, 'activity', {
              kind: 'stdout',
              text: 'running',
              byteLength: 7,
              truncated: false,
            }),
          ],
          nextCursor: 2,
          hasMore: false,
          hasGap: false,
        };
      }
      return {};
    };
    const received: AttemptActivity[] = [];
    observeAttempt('att-2', (a) => received.push(a));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(received.map((r) => r.text)).toEqual(['[attempt.state]', 'running']);
    expect(received[1].kind).toBe('stdout');
    const pull = rpcCalls.find((c) => c.operation === 'event.pull');
    expect(pull).toBeDefined();
    expect((pull!.params as { scope: string }).scope).toBe('att-2');
  });

  it('marks a sequence following a gap frame and replays the durable journal', async () => {
    const received: AttemptActivity[] = [];
    observeAttempt('att-3', (a) => received.push(a));
    await new Promise((resolve) => setImmediate(resolve));
    sentFrames.length = 0;

    handleActivityFrame(activityFrame('att-3', 1, 'first'));
    handleGapFrame(gapFrame('att-3', 2, 3));
    handleActivityFrame(activityFrame('att-3', 4, 'fourth'));

    expect(received).toHaveLength(2);
    expect(received[0].gapBefore).toBe(false);
    // Sequence 4 arrives after a gap over 2–3 → the UI sees an explicit hole.
    expect(received[1].gapBefore).toBe(true);
    expect(rpcCalls.some((c) => c.operation === 'event.pull')).toBe(true);
  });

  it('re-subscribes with the durable cursor on reconnect (meshObserverOnLive)', async () => {
    // A prior pull advanced the durable cursor to 6; live frames do not
    // carry a cursor, so afterSequence is the durable position only.
    rpcHandler = (op) => {
      if (op === 'event.pull') {
        return {
          scopeKind: 'attempt',
          scopeId: 'att-4',
          jobId: 'job-1',
          events: [durableEvent(6, 'att-4', 3, 'attempt.state', { state: 'running' })],
          nextCursor: 6,
          hasMore: false,
          hasGap: false,
        };
      }
      return {};
    };
    observeAttempt('att-4', () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    handleActivityFrame(activityFrame('att-4', 7, 'seven'));
    sentFrames.length = 0;

    meshObserverOnLive();
    const resub = sentFrames.find((f) => f['type'] === 'subscribe');
    expect(resub).toBeDefined();
    expect(resub!['afterSequence']).toBe(6);
  });

  it('does not re-deliver activity rows already seen live when replaying', async () => {
    const received: AttemptActivity[] = [];
    observeAttempt('att-7', (a) => received.push(a));
    await new Promise((resolve) => setImmediate(resolve));
    // Live frames deliver stream positions 1-2.
    handleActivityFrame(activityFrame('att-7', 1, 'one'));
    handleActivityFrame(activityFrame('att-7', 2, 'two'));
    // The durable journal replays those same rows plus a lifecycle row.
    rpcHandler = (op) => {
      if (op === 'event.pull') {
        return {
          scopeKind: 'attempt',
          scopeId: 'att-7',
          jobId: 'job-1',
          events: [
            durableEvent(1, 'att-7', 1, 'activity', { kind: 'status', text: 'one' }),
            durableEvent(2, 'att-7', 2, 'activity', { kind: 'status', text: 'two' }),
            durableEvent(3, 'att-7', 0, 'attempt.state', { state: 'completed' }),
          ],
          nextCursor: 3,
          hasMore: false,
          hasGap: false,
        };
      }
      return {};
    };
    meshObserverOnLive();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    // 'one'/'two' delivered once (live); the lifecycle row arrives via pull.
    expect(received.map((r) => r.text)).toEqual(['one', 'two', '[attempt.state]']);
  });

  it('delivers a re-sent live frame once — subscribe replays on renewal dedup', async () => {
    const received: AttemptActivity[] = [];
    observeAttempt('att-8', (a) => received.push(a));
    await new Promise((resolve) => setImmediate(resolve));

    handleActivityFrame(activityFrame('att-8', 1, 'once'));
    // Backend replays journaled rows on every subscribe (including the
    // 60s renewal): the same stream position must not re-deliver.
    handleActivityFrame(activityFrame('att-8', 1, 'once'));
    handleActivityFrame(activityFrame('att-8', 2, 'twice'));
    handleActivityFrame(activityFrame('att-8', 2, 'twice'));

    expect(received.map((r) => r.text)).toEqual(['once', 'twice']);
  });

  it('dedups a lifecycle row delivered via pull then re-pushed by socket replay', async () => {
    rpcHandler = (op) => {
      if (op === 'event.pull') {
        return {
          scopeKind: 'attempt',
          scopeId: 'att-9',
          jobId: 'job-1',
          events: [
            durableEvent(1, 'att-9', 0, 'attempt.state', { state: 'claimed' }),
            durableEvent(2, 'att-9', 1, 'activity', { kind: 'status', text: 'live-1' }),
          ],
          nextCursor: 2,
          hasMore: false,
          hasGap: false,
        };
      }
      return {};
    };
    const received: AttemptActivity[] = [];
    observeAttempt('att-9', (a) => received.push(a));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(received.map((r) => r.text)).toEqual(['[attempt.state]', 'live-1']);

    // The backend maps the same journaled lifecycle row to a status frame
    // and re-pushes it on the socket — it must not render twice.
    handleActivityFrame(activityFrame('att-9', 0, '{"type":"attempt.state"}'));
    handleActivityFrame(activityFrame('att-9', 1, 'live-1'));
    expect(received.map((r) => r.text)).toEqual(['[attempt.state]', 'live-1']);
  });

  it('follows event.pull hasMore pages within the replay budget', async () => {
    let page = 0;
    rpcHandler = (op) => {
      if (op === 'event.pull') {
        page += 1;
        return {
          scopeKind: 'attempt',
          scopeId: 'att-10',
          jobId: 'job-1',
          events: [
            durableEvent(page, 'att-10', page, 'activity', {
              kind: 'stdout',
              text: `page-${page}`,
            }),
          ],
          nextCursor: page,
          hasMore: page < 3,
          hasGap: false,
        };
      }
      return {};
    };
    const received: AttemptActivity[] = [];
    observeAttempt('att-10', (a) => received.push(a));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(received.map((r) => r.text)).toEqual(['page-1', 'page-2', 'page-3']);
    const pulls = rpcCalls.filter((c) => c.operation === 'event.pull');
    expect(pulls).toHaveLength(3);
    expect((pulls[2].params as { afterSequence: number }).afterSequence).toBe(2);
  });

  it('stops renewing and sending once gone', async () => {
    observeAttempt('att-5', () => undefined);
    sentFrames.length = 0;
    meshObserverOnGone();
    meshObserverOnLive(); // no-op: no subscriptions remain
    expect(sentFrames).toHaveLength(0);
  });

  it('buffers recent activity for a listener that attaches late', async () => {
    const first: AttemptActivity[] = [];
    const stop = observeAttempt('att-6', (a) => first.push(a));
    handleActivityFrame(activityFrame('att-6', 1, 'early'));
    const second: AttemptActivity[] = [];
    observeAttempt('att-6', (a) => second.push(a));
    // The second listener immediately sees the buffered event.
    expect(second.map((s) => s.text)).toEqual(['early']);
    stop();
  });
});
