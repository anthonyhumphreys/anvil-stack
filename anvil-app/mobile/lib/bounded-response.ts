/** Reads a streamed response into a fixed-size buffer and cancels oversized bodies. */
export async function readBoundedResponseText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('A positive response byte limit is required.');
  }
  if (!body) throw new Error('machine-response-stream-unavailable');

  const reader = body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel('machine-response-stream-invalid').catch(() => {});
        throw new Error('machine-response-stream-invalid');
      }
      if (value.byteLength > maxBytes - byteLength) {
        await reader.cancel('machine-response-too-large').catch(() => {});
        throw new Error('machine-response-too-large');
      }
      bytes.set(value, byteLength);
      byteLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder('utf-8').decode(bytes.subarray(0, byteLength));
}
