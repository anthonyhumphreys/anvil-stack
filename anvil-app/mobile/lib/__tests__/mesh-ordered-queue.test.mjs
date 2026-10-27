import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrderedMeshQueue } from '../mesh-ordered-queue.ts';

test('asynchronous decoding cannot overtake an earlier frame', async () => {
  const queue = new OrderedMeshQueue();
  const order = [];
  let release;
  const first = queue.run(async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    order.push(1);
  }, 10);
  const second = queue.run(async () => {
    order.push(2);
  }, 10);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, []);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2]);
});

test('bounds retained frame bytes and prevents queued work after close', async () => {
  const queue = new OrderedMeshQueue();
  let release;
  let ran = false;
  const first = queue.run(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    2 * 1024 * 1024,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(
    queue.run(async () => {}, 1),
    /machine-frame-queue-full/,
  );
  const waiting = queue.run(async () => {
    ran = true;
  }, 0);
  queue.close();
  release();
  await first;
  await assert.rejects(waiting, /machine-session-closed/);
  assert.equal(ran, false);
});
