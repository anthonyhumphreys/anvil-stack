import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MobileMeshNetworkMonitor } from '../mesh-network-monitor.ts';
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('detects an address change with the same Wi-Fi type, coalesces hints, and stops in background', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const advance = async (ms = 0) => {
    context.mock.timers.tick(ms);
    for (let index = 0; index < 5; index++) await Promise.resolve();
  };
  let address = '192.168.1.2';
  let listener;
  let reads = 0;
  let changes = 0;
  let removed = false;
  const foreground = [];
  const monitor = new MobileMeshNetworkMonitor({
    read: async () => {
      reads += 1;
      return { type: 'WIFI', isConnected: true, ip: address };
    },
    listen: (next) => {
      listener = next;
      return () => {
        removed = true;
      };
    },
    hasDemand: () => true,
    changed: () => {
      changes += 1;
    },
    foreground: (active) => foreground.push(active),
    pollMs: 20,
    debounceMs: 2,
  });
  try {
    monitor.start(true);
    await advance();
    assert.equal(reads, 1);
    listener();
    listener();
    listener();
    await advance(8);
    assert.equal(reads, 2);
    assert.equal(changes, 0);
    address = '192.168.1.3';
    await advance(25);
    assert.equal(changes, 1);
    monitor.setForeground(false);
    const previous = reads;
    listener();
    await advance(25);
    assert.equal(reads, previous);
    address = '10.0.0.2';
    monitor.setForeground(true);
    await advance();
    assert.equal(changes, 2);
    assert.deepEqual(foreground, [true, false, true]);
  } finally {
    monitor.stop();
    context.mock.timers.reset();
  }
  assert.equal(removed, true);
});

test('no consumers means no IP sampling and a late background sample cannot change routes', async () => {
  let demand = false;
  let reads = 0;
  let resolve;
  let changes = 0;
  const monitor = new MobileMeshNetworkMonitor({
    read: () => {
      reads += 1;
      return new Promise((next) => {
        resolve = next;
      });
    },
    listen: () => () => {},
    hasDemand: () => demand,
    changed: () => {
      changes += 1;
    },
    foreground: () => {},
  });
  try {
    monitor.start(true);
    await wait();
    assert.equal(reads, 0);
    demand = true;
    monitor.demandChanged();
    await wait();
    assert.equal(reads, 1);
    monitor.setForeground(false);
    resolve({ type: 'WIFI', ip: '192.168.1.3' });
    await wait();
    assert.equal(changes, 0);
  } finally {
    monitor.stop();
  }
});
