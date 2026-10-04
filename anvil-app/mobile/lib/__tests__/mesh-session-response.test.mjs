import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBoundedResponseText } from '../bounded-response.ts';

function responseBody(chunks, onCancel = () => {}) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
    cancel(reason) {
      onCancel(reason);
    },
  });
}

test('reads a bounded stream exactly at its limit and decodes split UTF-8', async () => {
  const bytes = new TextEncoder().encode('A😀');
  const result = await readBoundedResponseText(
    responseBody([bytes.subarray(0, 2), bytes.subarray(2)]),
    bytes.byteLength,
  );

  assert.equal(result, 'A😀');
});

test('cancels a streamed response when cumulative bytes exceed the limit', async () => {
  let cancelledWith;
  const body = responseBody(
    [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
    (reason) => (cancelledWith = reason),
  );

  await assert.rejects(readBoundedResponseText(body, 4), /machine-response-too-large/);
  assert.equal(cancelledWith, 'machine-response-too-large');
});

test('fails closed when the runtime does not provide a response stream', async () => {
  await assert.rejects(readBoundedResponseText(null, 4), /machine-response-stream-unavailable/);
});
