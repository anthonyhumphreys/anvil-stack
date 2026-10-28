import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MobileMeshSessionManager } from '../mesh-session-manager.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const route = (kind, networkKind) => ({
  kind,
  ...(networkKind ? { networkKind } : {}),
  url: kind === 'managed' ? 'https://managed.test' : 'http://192.168.1.2:47631',
  machineId: 'machine',
  endpointGeneration: 'one',
  reachableUntil: '2099-01-01T00:00:00Z',
});
const host = () => ({
  enrollmentId: 'host',
  machineId: 'machine',
  endpointGeneration: 'one',
  protocolVersion: 1,
  capabilities: ['machine.session/1', 'machine.stream/1', 'machine.stream-handoff/1'],
  operations: ['read.snapshot', 'command.cancel'],
  routes: [route('private', 'lan'), route('managed')],
  online: true,
});
const event = (sequence) => ({
  epoch: 'epoch',
  sequence,
  workspaceId: 'workspace',
  eventKind: 'chat',
  payload: sequence,
});
function fixture(options = {}) {
  let scope = 'account-1';
  let roster = [host()];
  let discoverCount = 0;
  const connections = [];
  const attempts = [];
  const manager = new MobileMeshSessionManager({
    scope: async () => scope,
    discover: async () => {
      discoverCount += 1;
      return roster;
    },
    connect: async (target, input) => {
      const index = connections.length;
      const connection = {
        host: target,
        route: index === 0 ? route('managed') : target.routes[0],
        isOpen: true,
        replayComplete: true,
        streamCursor: input.cursor ?? { epoch: 'epoch', sequence: 0 },
        closed: 0,
        calls: [],
        async request(operation, payload, requestId) {
          this.calls.push({ operation, payload, requestId });
          return options.request?.(operation, index) ?? 'ok';
        },
        close() {
          if (!this.isOpen) return;
          this.closed += 1;
          this.isOpen = false;
          input.handlers.onClosed('retired');
        },
        emit(value) {
          this.streamCursor = { epoch: value.epoch, sequence: value.sequence };
          input.handlers.onEvent(value);
        },
        terminal(cause) {
          this.isOpen = false;
          input.handlers.onClosed(cause);
        },
      };
      connections.push(connection);
      attempts.push(input);
      await options.connect?.(connection, input, index);
      return connection;
    },
    rank: (candidate) =>
      candidate.kind === 'managed' ? 3 : candidate.networkKind === 'lan' ? 0 : 1,
    path: (candidate) =>
      candidate.kind === 'managed'
        ? 'managed'
        : candidate.networkKind === 'lan'
          ? 'direct'
          : 'private-network',
    random: () => 0.5,
    idleMs: 30_000,
    refreshMs: 60_000,
    dwellMs: 0,
    preparationMs: 1_000,
    retryMs: options.retryMs,
  });
  return {
    manager,
    connections,
    attempts,
    setScope: (value) => {
      scope = value;
    },
    setRoster: (value) => {
      roster = value;
    },
    get discoverCount() {
      return discoverCount;
    },
  };
}
const handlers = (events = [], closed = []) => ({
  onEvent: (value) => events.push(value.sequence),
  onResnapshot() {},
  onClosed: (cause) => closed.push(cause),
});

test('consumers share discovery and connection, and final release closes demand', async () => {
  const f = fixture();
  const first = f.manager.subscribe('host', handlers());
  const second = f.manager.subscribe('host', handlers());
  try {
    await tick();
    assert.equal(f.discoverCount, 1);
    assert.equal(f.connections.length, 1);
    first();
    assert.equal(f.connections[0].closed, 0);
    second();
    assert.equal(f.connections[0].closed, 1);
    assert.equal(f.manager.status('host').state, 'idle');
  } finally {
    f.manager.reset();
  }
});

test('failed upgrade keeps current session and obeys backoff', async () => {
  const f = fixture({
    connect: async (_connection, _input, index) => {
      if (index > 0) throw new Error('unreachable');
    },
  });
  const release = f.manager.subscribe('host', handlers());
  try {
    await tick();
    await f.manager.refresh(true);
    await tick();
    assert.equal(f.manager.status('host').path, 'managed');
    assert.equal(f.connections[0].closed, 0);
    await f.manager.refresh(true);
    await tick();
    assert.equal(f.connections.length, 2);
    assert.equal(await f.manager.request('host', 'read.snapshot', {}), 'ok');
  } finally {
    release();
    f.manager.reset();
  }
});

test('promotion deduplicates replay, retains subscribers and drains a sent command', async () => {
  const preparation = deferred();
  const command = deferred();
  const events = [];
  const f = fixture({
    connect: async (_connection, _input, index) => {
      if (index === 1) await preparation.promise;
    },
    request: (operation) => (operation === 'command.cancel' ? command.promise : 'ok'),
  });
  const release = f.manager.subscribe('host', handlers(events));
  try {
    await tick();
    f.connections[0].emit(event(1));
    const response = f.manager.request('host', 'command.cancel', {}, 'stable-intent');
    await tick();
    await f.manager.refresh(true);
    await tick();
    f.connections[0].emit(event(2));
    f.connections[1].emit(event(2));
    f.connections[1].emit(event(5)); // Global sequence gaps may belong to filtered workspaces.
    preparation.resolve();
    await tick();
    assert.equal(f.manager.status('host').path, 'direct');
    assert.deepEqual(events, [1, 2, 5]);
    assert.equal(f.connections[0].closed, 0);
    f.connections[0].emit(event(6));
    f.connections[1].emit(event(6));
    assert.deepEqual(events, [1, 2, 5, 6]);
    command.resolve('confirmed');
    assert.equal(await response, 'confirmed');
    assert.equal(f.connections[0].closed, 1);
    assert.equal(f.connections[1].calls.length, 0);
    assert.equal(f.manager.status('host').state, 'live');
  } finally {
    preparation.resolve();
    command.resolve();
    release();
    f.manager.reset();
  }
});

test('candidate waits for the currently delivered watermark after replay completion', async () => {
  const preparation = deferred();
  const f = fixture({
    connect: async (_connection, _input, index) => {
      if (index === 1) await preparation.promise;
    },
  });
  const release = f.manager.subscribe('host', handlers());
  try {
    await tick();
    await f.manager.refresh(true);
    await tick();
    f.connections[0].emit(event(10));
    preparation.resolve();
    await tick();
    assert.equal(f.manager.status('host').path, 'managed');
    f.connections[1].emit(event(10));
    assert.equal(f.manager.status('host').path, 'direct');
  } finally {
    preparation.resolve();
    release();
    f.manager.reset();
  }
});

test('backgrounding cancels preparing migration and disposes a late success', async () => {
  const preparation = deferred();
  const f = fixture({
    connect: async (_connection, _input, index) => {
      if (index === 1) await preparation.promise;
    },
  });
  const release = f.manager.subscribe('host', handlers());
  try {
    await tick();
    await f.manager.refresh(true);
    await tick();
    f.manager.setForeground(false);
    assert.equal(f.attempts[1].signal.aborted, true);
    preparation.resolve();
    await tick();
    assert.equal(f.connections[1].closed, 1);
    assert.equal(f.connections[0].closed, 0);
    assert.equal(f.manager.status('host').path, 'managed');
  } finally {
    preparation.resolve();
    release();
    f.manager.reset();
  }
});

test('releasing final consumer cancels in-flight initial connection', async () => {
  const preparation = deferred();
  const f = fixture({ connect: async () => preparation.promise });
  const release = f.manager.subscribe('host', handlers());
  try {
    await tick();
    release();
    preparation.resolve();
    await tick();
    assert.equal(f.connections[0].closed, 1);
    assert.equal(f.manager.status('host').path, null);
  } finally {
    preparation.resolve();
    f.manager.reset();
  }
});

test('account scope replacement fences an outstanding connection and stale facades', async () => {
  const f = fixture();
  try {
    const session = await f.manager.get('host');
    f.setScope('account-2');
    await assert.rejects(session.request('command.cancel', {}), /authorization-unavailable/);
    assert.equal(f.connections[0].calls.length, 0);
    assert.equal(f.connections[0].closed, 1);
    await assert.rejects(session.request('read.snapshot', {}), /authorization-unavailable/);
  } finally {
    f.manager.reset();
  }
});

test('an uncertain command is never retried on a second route', async () => {
  const f = fixture({
    request: () => {
      throw new Error('socket-closed');
    },
  });
  try {
    await assert.rejects(
      f.manager.request('host', 'command.cancel', {}, 'command-id'),
      /machine-request-uncertain/,
    );
    assert.equal(f.connections.length, 1);
    assert.equal(f.connections[0].calls.length, 1);
  } finally {
    f.manager.reset();
  }
});

test('old hosts connect but do not start proactive migration', async () => {
  const f = fixture();
  f.setRoster([{ ...host(), capabilities: ['machine.session/1', 'machine.stream/1'] }]);
  const release = f.manager.subscribe('host', handlers());
  try {
    await tick();
    await f.manager.refresh(true);
    await tick();
    assert.equal(f.connections.length, 1);
  } finally {
    release();
    f.manager.reset();
  }
});

test('a route-only network change cancels obsolete candidates and permits a fresh assessment', async () => {
  const preparation = deferred();
  const f = fixture({
    connect: async (_connection, _input, index) => {
      if (index === 1) await preparation.promise;
    },
  });
  const release = f.manager.subscribe('host', handlers());
  try {
    await tick();
    await f.manager.refresh(true);
    await tick();
    f.manager.networkChanged();
    preparation.resolve();
    await tick();
    await tick();
    assert.equal(f.attempts[1].signal.aborted, true);
    assert.equal(f.connections[1].closed, 1);
    assert.equal(f.connections.length, 3);
    assert.equal(f.manager.status('host').path, 'direct');
  } finally {
    preparation.resolve();
    release();
    f.manager.reset();
  }
});

test('operator switch cancels preparation while preserving ordinary requests', async () => {
  const preparation = deferred();
  const f = fixture({
    connect: async (_connection, _input, index) => {
      if (index === 1) await preparation.promise;
    },
  });
  const release = f.manager.subscribe('host', handlers());
  try {
    await tick();
    await f.manager.refresh(true);
    await tick();
    f.manager.setUpgradesEnabled(false);
    preparation.resolve();
    await tick();
    assert.equal(f.connections[1].closed, 1);
    assert.equal(f.manager.status('host').path, 'managed');
    assert.equal(await f.manager.request('host', 'read.snapshot', {}), 'ok');
    await f.manager.refresh(true);
    await tick();
    assert.equal(f.connections.length, 2);
  } finally {
    preparation.resolve();
    release();
    f.manager.reset();
  }
});

test('obsolete connection callbacks do not clear the promoted winner', async () => {
  const f = fixture();
  const release = f.manager.subscribe('host', handlers());
  try {
    await tick();
    await f.manager.refresh(true);
    await tick();
    f.attempts[0].handlers.onClosed('machine-session-expired');
    f.attempts[0].handlers.onClosed('session.revoked');
    assert.equal(f.manager.status('host').path, 'direct');
    assert.equal(f.connections[1].closed, 0);
  } finally {
    release();
    f.manager.reset();
  }
});

test('scope changes fence delayed read and mutation results without waiting for an event', async () => {
  for (const operation of ['read.snapshot', 'command.cancel']) {
    const result = deferred();
    const f = fixture({ request: () => result.promise });
    try {
      const response = f.manager.request('host', operation, {});
      await tick();
      f.setScope('replacement-account');
      result.resolve({ secret: 'old-account-data' });
      await assert.rejects(
        response,
        operation.startsWith('read.') ? /authorization-unavailable/ : /machine-request-uncertain/,
      );
      assert.equal(f.connections[0].calls.length, 1);
      assert.equal(f.connections[0].closed, 1);
    } finally {
      result.resolve();
      f.manager.reset();
    }
  }
});

test('reset from initial replay stops later callbacks and does not restore the closed session', async () => {
  const f = fixture({
    connect: async (connection) => {
      connection.emit(event(1));
      connection.emit(event(2));
    },
  });
  const seen = [];
  f.manager.subscribe('host', {
    ...handlers(),
    onEvent(value) {
      seen.push(value.sequence);
      f.manager.reset();
    },
  });
  await tick();
  assert.deepEqual(seen, [1]);
  assert.equal(f.connections[0].closed, 1);
  assert.equal(f.manager.status('host').state, 'idle');
});

test('reset from promoted replay closes both owners and stops remaining delivery', async () => {
  const pending = deferred();
  const preparation = deferred();
  const seen = [];
  const f = fixture({
    request: () => pending.promise,
    connect: async (_connection, _input, index) => {
      if (index > 0) await preparation.promise;
    },
  });
  f.manager.subscribe('host', {
    ...handlers(),
    onEvent(value) {
      seen.push(value.sequence);
      f.manager.reset();
    },
  });
  await tick();
  const response = f.manager.request('host', 'command.cancel', {});
  await tick();
  await f.manager.refresh(true);
  await tick();
  f.connections[1].emit(event(1));
  f.connections[1].emit(event(2));
  preparation.resolve();
  await tick();
  assert.deepEqual(seen, [1]);
  assert.equal(f.connections[0].closed, 1);
  assert.equal(f.connections[1].closed, 1);
  assert.equal(f.manager.status('host').state, 'idle');
  pending.resolve('old-account-result');
  await assert.rejects(response, /machine-request-uncertain/);
  f.manager.reset();
});

test('a definitive rejection remains actionable without replaying a mutation', async () => {
  const f = fixture({
    request: () => {
      throw Object.assign(new Error('machine-operation-denied'), { definitive: true });
    },
  });
  try {
    await assert.rejects(
      f.manager.request('host', 'command.cancel', {}),
      /machine-operation-denied/,
    );
    assert.equal(f.connections[0].calls.length, 1);
  } finally {
    f.manager.reset();
  }
});

test('an initial dial cancelled by a network change immediately retries on the new network', async () => {
  const pending = deferred();
  const f = fixture({
    connect: async (_connection, _input, index) => {
      if (index === 0) await pending.promise;
    },
  });
  const release = f.manager.subscribe('host', handlers());
  try {
    await tick();
    f.manager.networkChanged();
    pending.resolve();
    await tick();
    await tick();
    assert.equal(f.connections.length, 2);
    assert.equal(f.connections[0].closed, 1);
    assert.equal(f.manager.status('host').state, 'live');
  } finally {
    pending.resolve();
    release();
    f.manager.reset();
  }
});

test('backgrounding clears scheduled retries and cancels an unfinished initial connection', async () => {
  const f = fixture({ retryMs: 10 });
  const release = f.manager.subscribe('host', handlers());
  try {
    await tick();
    f.connections[0].terminal('machine-session-closed');
    f.manager.setForeground(false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(f.connections.length, 1);
    f.manager.setForeground(true);
    await tick();
    assert.equal(f.connections.length, 2);
  } finally {
    release();
    f.manager.reset();
  }
  const pending = deferred();
  const initial = fixture({ connect: async () => pending.promise });
  initial.manager.subscribe('host', handlers());
  await tick();
  initial.manager.setForeground(false);
  assert.equal(initial.attempts[0].signal.aborted, true);
  pending.resolve();
  await tick();
  assert.equal(initial.connections[0].closed, 1);
  initial.manager.reset();
});

test('throwing status and terminal observers cannot block other consumers or cleanup', async () => {
  const f = fixture({ retryMs: 5 });
  let notifications = 0;
  const closed = [];
  f.manager.onStatus(() => {
    throw new Error('render failed');
  });
  f.manager.onStatus(() => {
    notifications += 1;
  });
  f.manager.subscribe('host', {
    ...handlers(),
    onClosed() {
      throw new Error('consumer failed');
    },
  });
  f.manager.subscribe('host', handlers([], closed));
  await tick();
  assert.equal(f.manager.status('host').state, 'live');
  f.connections[0].terminal('machine-session-closed');
  assert.deepEqual(closed, ['machine-session-closed']);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(f.connections.length, 2);
  assert.equal(f.manager.status('host').state, 'live');
  assert.doesNotThrow(() => f.manager.reset());
  assert.equal(f.connections[1].closed, 1);
  assert.deepEqual(closed, ['machine-session-closed', 'authorization-unavailable']);
  assert.ok(notifications >= 4);
});

test('a throwing promoted replay consumer resets all owners and requests a fresh snapshot', async () => {
  const preparation = deferred();
  const command = deferred();
  const seen = [];
  const snapshots = [];
  let shouldThrow = true;
  const f = fixture({
    request: (operation) => (operation === 'command.cancel' ? command.promise : 'ok'),
    connect: async (_connection, _input, index) => {
      if (index === 1) await preparation.promise;
    },
  });
  const releaseFirst = f.manager.subscribe('host', {
    ...handlers(),
    onEvent() {
      if (shouldThrow) throw new Error('partial application');
    },
    onClosed() {
      throw new Error('terminal observer failed');
    },
    onResnapshot() {
      throw new Error('snapshot observer failed');
    },
  });
  const releaseSecond = f.manager.subscribe('host', {
    ...handlers(seen),
    onResnapshot(reason) {
      snapshots.push(reason);
    },
  });
  try {
    await tick();
    const pending = f.manager.request('host', 'command.cancel', {});
    await tick();
    await f.manager.refresh(true);
    await tick();
    f.connections[1].emit(event(1));
    f.connections[1].emit(event(2));
    preparation.resolve();
    await tick();
    assert.deepEqual(seen, []);
    assert.deepEqual(snapshots, ['delivery-failed']);
    assert.equal(f.connections[0].closed, 1);
    assert.equal(f.connections[1].closed, 1);
    assert.equal(f.manager.status('host').state, 'reconnecting');
    command.resolve('confirmed-before-close');
    await assert.rejects(pending, /machine-request-uncertain/);
    shouldThrow = false;
    await f.manager.get('host');
    assert.equal(f.attempts[2].cursor, undefined);
    assert.equal(f.manager.status('host').state, 'live');
    f.connections[2].emit(event(1));
    assert.deepEqual(seen, [1]);
  } finally {
    preparation.resolve();
    command.resolve();
    releaseFirst();
    releaseSecond();
    f.manager.reset();
  }
});

test('throwing initial replay is reconnectable and never advances the delivered cursor', async () => {
  let shouldThrow = true;
  const snapshots = [];
  const f = fixture({
    connect: async (connection) => {
      connection.emit(event(1));
      connection.emit(event(2));
    },
  });
  const release = f.manager.subscribe('host', {
    ...handlers(),
    onEvent() {
      if (shouldThrow) throw new Error('consumer failed');
    },
    onResnapshot(reason) {
      snapshots.push(reason);
    },
  });
  try {
    await tick();
    assert.deepEqual(snapshots, ['delivery-failed']);
    assert.equal(f.connections[0].closed, 1);
    assert.equal(f.manager.status('host').state, 'reconnecting');
    shouldThrow = false;
    await f.manager.get('host');
    assert.equal(f.attempts[1].cursor, undefined);
    assert.equal(f.manager.status('host').state, 'live');
  } finally {
    release();
    f.manager.reset();
  }
});

test('host revocation fences an already-resolved response while the account scope is unchanged', async () => {
  for (const operation of ['read.snapshot', 'command.cancel']) {
    const result = deferred();
    const f = fixture({ request: () => result.promise });
    try {
      const response = f.manager.request('host', operation, {});
      await tick();
      result.resolve({ oldHostData: true });
      f.connections[0].terminal('device-denied');
      await assert.rejects(
        response,
        operation.startsWith('read.') ? /authorization-unavailable/ : /machine-request-uncertain/,
      );
      assert.equal(f.connections[0].calls.length, 1);
      assert.equal(f.manager.status('host').state, 'authorization-unavailable');
    } finally {
      result.resolve();
      f.manager.reset();
    }
  }
});
