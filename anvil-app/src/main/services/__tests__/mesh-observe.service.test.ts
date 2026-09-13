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

beforeEach(() => {
  rpcCalls.length = 0;
  sentFrames.length = 0;
  live = true;
  rpcHandler = () => ({ events: [], nextCursor: null, hasGap: false });
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
          events: [
            {
              id: 'e1',
              scope: 'attempt:att-2',
              sequence: 1,
              kind: 'status',
              payloadJson: 'claimed',
              createdAt: '2026-09-13T00:00:00.000Z',
            },
            {
              id: 'e2',
              scope: 'attempt:att-2',
              sequence: 2,
              kind: 'stdout',
              payloadJson: 'running',
              createdAt: '2026-09-13T00:00:01.000Z',
            },
          ],
          nextCursor: 2,
          hasGap: false,
        };
      }
      return {};
    };
    const received: AttemptActivity[] = [];
    observeAttempt('att-2', (a) => received.push(a));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(received.map((r) => r.text)).toEqual(['claimed', 'running']);
    expect(rpcCalls.some((c) => c.operation === 'event.pull')).toBe(true);
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

  it('re-subscribes with afterSequence on reconnect (meshObserverOnLive)', async () => {
    observeAttempt('att-4', () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    handleActivityFrame(activityFrame('att-4', 7, 'seven'));
    sentFrames.length = 0;

    meshObserverOnLive();
    const resub = sentFrames.find((f) => f['type'] === 'subscribe');
    expect(resub).toBeDefined();
    expect(resub!['afterSequence']).toBe(7);
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
