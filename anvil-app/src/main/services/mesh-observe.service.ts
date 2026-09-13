// MESH-03: observer side of live session observation.
//
// A source device (or any enrolled controller) subscribes to an attempt's
// event stream over the live socket. Subscription interest expires
// server-side after 90s without renewal, so active observers re-subscribe
// on a shorter cadence. `activity` frames are ephemeral — the durable path
// is `event.pull`, used to replay history and recover gaps the socket
// skipped. The service never imports sync-runtime: the runtime injects a
// context provider and routes inbound `activity`/`gap` frames here.
//
// Local replay buffering is in-memory and bounded: event.pull is the
// durable record, the buffer only serves a live listener between durable
// reads.

import { randomUUID } from 'node:crypto';
import { rpc as backendRpc, BackendRpcError } from './sync-backend-client.service.js';
import type {
  ActivityFrame,
  GapFrame,
  SubscribeFrame,
  UnsubscribeFrame,
} from '../../../cloud/contract/socket.js';

/** Durable event as returned by `event.pull` (MESH-03 contract). */
export interface MeshEvent {
  id: string;
  scope: string;
  sequence: number;
  kind: string;
  payloadJson: string;
  createdAt: string;
}

interface EventPullResult {
  events: MeshEvent[];
  nextCursor: number | null;
  hasGap: boolean;
}

interface MeshObserverContext {
  apiUrl: string;
  accessToken: string;
  enrollmentId: string;
  sendFrame?: (frame: unknown) => void;
  /** Whether the live socket is currently up (for resubscribe-on-hello). */
  isLive?: () => boolean;
}

export interface AttemptActivity {
  at: string;
  kind: 'stdout' | 'stderr' | 'status';
  text: string;
  sequence: number;
  /** True when a `gap` frame indicates skipped sequence numbers. */
  gapBefore: boolean;
}

export type AttemptObserver = (activity: AttemptActivity) => void;

interface Subscription {
  id: string;
  scope: string;
  attemptId: string;
  listeners: Set<AttemptObserver>;
  lastSequence: number;
  renewTimer: ReturnType<typeof setInterval> | null;
  /** Bounded recent-activity buffer for late listeners. */
  buffer: AttemptActivity[];
  /** Sequences the backend told us were skipped (gap frames). */
  gapped: Set<number>;
}

let contextProvider: (() => MeshObserverContext | null) | null = null;
const subscriptions = new Map<string, Subscription>();

const OBSERVER_RENEW_MS = 60_000; // < 90s server-side expiry
const BUFFER_LIMIT = 200;

export function configureMeshObserverContext(
  provider: () => MeshObserverContext | null,
): void {
  contextProvider = provider;
}

function observerContext(): MeshObserverContext | null {
  return contextProvider?.() ?? null;
}

async function observeRpc<T>(operation: string, params: unknown): Promise<T> {
  const ctx = observerContext();
  if (ctx === null) {
    throw new Error('Mesh observer has no active sync session.');
  }
  const { result } = await backendRpc<T>(
    { apiUrl: ctx.apiUrl },
    operation,
    params,
    ctx.accessToken,
  );
  return result;
}

function sendFrame(frame: SubscribeFrame | UnsubscribeFrame): void {
  const ctx = observerContext();
  if (ctx?.sendFrame === undefined || ctx.isLive?.() === false) return;
  try {
    ctx.sendFrame(frame);
  } catch {
    // Socket mid-reconnect — the next hello re-subscribes everything.
  }
}

/**
 * Registers an observer for an attempt's activity stream. Multiple listeners
 * share one socket subscription; the returned function detaches the listener
 * and drops the subscription when the last listener leaves.
 */
export function observeAttempt(attemptId: string, listener: AttemptObserver): () => void {
  const scope = `attempt:${attemptId}`;
  let sub = subscriptions.get(scope);
  if (sub === undefined) {
    sub = {
      id: randomUUID(),
      scope,
      attemptId,
      listeners: new Set(),
      lastSequence: 0,
      renewTimer: null,
      buffer: [],
      gapped: new Set(),
    };
    subscriptions.set(scope, sub);
    sendSubscribe(sub);
    sub.renewTimer = setInterval(() => {
      sendSubscribe(sub as Subscription);
    }, OBSERVER_RENEW_MS);
    if (typeof sub.renewTimer.unref === 'function') sub.renewTimer.unref();
    // Durable catch-up for anything emitted before the subscription landed.
    void replayEvents(sub).catch(() => undefined);
  }
  sub.listeners.add(listener);
  // Late listeners get the bounded buffer immediately.
  for (const item of sub.buffer) listener(item);
  return () => {
    const current = subscriptions.get(scope);
    if (current === undefined) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      if (current.renewTimer !== null) clearInterval(current.renewTimer);
      subscriptions.delete(scope);
      sendFrame({
        type: 'unsubscribe',
        version: 1,
        id: randomUUID(),
        subscriptionId: current.id,
      });
    }
  };
}

function sendSubscribe(sub: Subscription): void {
  sendFrame({
    type: 'subscribe',
    version: 1,
    id: sub.id,
    scope: sub.scope,
    afterSequence: sub.lastSequence > 0 ? sub.lastSequence : null,
  });
}

/** Re-subscribe every active scope on socket (re)connect; replay the gap. */
export function meshObserverOnLive(): void {
  for (const sub of subscriptions.values()) {
    sendSubscribe(sub);
    void replayEvents(sub).catch(() => undefined);
  }
}

/** Tear down on sign-out/backend change: stop timers, keep nothing. */
export function meshObserverOnGone(): void {
  for (const sub of subscriptions.values()) {
    if (sub.renewTimer !== null) clearInterval(sub.renewTimer);
  }
  subscriptions.clear();
}

/**
 * True when the stream has unreconciled gapped sequences at or below `seq`:
 * the durable replay either hasn't delivered them yet or no longer retains
 * them — the UI shows an explicit hole rather than fabricating output.
 */
function hasUnresolvedGap(sub: Subscription, seq: number): boolean {
  for (const gapped of sub.gapped) {
    if (gapped <= seq) return true;
  }
  return false;
}

/** Runtime routes inbound `activity` frames here. */
export function handleActivityFrame(frame: ActivityFrame): void {
  const sub = subscriptions.get(frame.streamId) ?? subscriptions.get(`attempt:${frame.attemptId}`);
  if (sub === undefined) return;
  const item: AttemptActivity = {
    at: new Date().toISOString(),
    kind: frame.payload.kind,
    text: frame.payload.text,
    sequence: frame.sequence,
    gapBefore: hasUnresolvedGap(sub, frame.sequence),
  };
  sub.gapped.delete(frame.sequence);
  if (frame.sequence > sub.lastSequence) sub.lastSequence = frame.sequence;
  sub.buffer.push(item);
  if (sub.buffer.length > BUFFER_LIMIT) sub.buffer.shift();
  for (const listener of sub.listeners) listener(item);
}

/** Runtime routes inbound `gap` frames here: mark the skipped range. */
export function handleGapFrame(frame: GapFrame): void {
  const sub = subscriptions.get(frame.streamId) ?? subscriptions.get(`attempt:${frame.attemptId}`);
  if (sub === undefined) return;
  for (let seq = frame.fromSequence; seq <= frame.toSequence; seq += 1) {
    sub.gapped.add(seq);
  }
  // The durable journal is the record — pull the missed range.
  void replayEvents(sub).catch(() => undefined);
}

/**
 * Replays the durable journal after `lastSequence`, delivering events the
 * socket missed (or emitted before subscription). Gap-marked sequences the
 * journal still has are delivered and cleared; ones it no longer retains
 * stay marked so the UI can show an explicit hole rather than fabricating.
 */
async function replayEvents(sub: Subscription): Promise<void> {
  const ctx = observerContext();
  if (ctx === null) return;
  try {
    const result = await observeRpc<EventPullResult>('event.pull', {
      scope: sub.scope,
      afterSequence: sub.lastSequence,
      limit: 200,
    });
    for (const event of result.events) {
      if (event.sequence <= sub.lastSequence) continue;
      const item: AttemptActivity = {
        at: event.createdAt,
        kind: event.kind === 'stderr' ? 'stderr' : event.kind === 'stdout' ? 'stdout' : 'status',
        text: event.payloadJson,
        sequence: event.sequence,
        gapBefore: hasUnresolvedGap(sub, event.sequence),
      };
      sub.gapped.delete(event.sequence);
      sub.lastSequence = event.sequence;
      sub.buffer.push(item);
      if (sub.buffer.length > BUFFER_LIMIT) sub.buffer.shift();
      for (const listener of sub.listeners) listener(item);
    }
  } catch (error) {
    if (!(error instanceof BackendRpcError)) throw error;
    // RPC failures are transient — the next renewal retries the replay.
  }
}

export function resetMeshObserverForTests(): void {
  meshObserverOnGone();
  contextProvider = null;
}
