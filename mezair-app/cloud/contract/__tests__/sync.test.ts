import { describe, expect, it } from 'vitest';

import {
  canonicalChangeHashInput,
  canonicalizeJson,
  hashChange,
  PendingChange,
  SyncOperation,
} from '../sync';
import pushBatch from '../fixtures/push-batch.json';

const K256: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * Test-local SHA-256 over the canonical UTF-8 string. Kept here (not in the
 * contract) so the contract never gains a crypto runtime dependency; callers
 * inject their own implementation through `hashChange`.
 */
function sha256Hex(input: string): string {
  const binary = unescape(encodeURIComponent(input));
  const bytes: number[] = [];
  for (let index = 0; index < binary.length; index += 1) {
    bytes.push(binary.charCodeAt(index));
  }
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  bytes.push(
    (high >>> 24) & 0xff,
    (high >>> 16) & 0xff,
    (high >>> 8) & 0xff,
    high & 0xff,
    (low >>> 24) & 0xff,
    (low >>> 16) & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  );

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const schedule: number[] = new Array<number>(64).fill(0);
  for (let block = 0; block < bytes.length; block += 64) {
    for (let t = 0; t < 16; t += 1) {
      schedule[t] =
        (bytes[block + t * 4] << 24) |
        (bytes[block + t * 4 + 1] << 16) |
        (bytes[block + t * 4 + 2] << 8) |
        bytes[block + t * 4 + 3];
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 =
        rotateRight(schedule[t - 15], 7) ^ rotateRight(schedule[t - 15], 18) ^ (schedule[t - 15] >>> 3);
      const s1 =
        rotateRight(schedule[t - 2], 17) ^ rotateRight(schedule[t - 2], 19) ^ (schedule[t - 2] >>> 10);
      schedule[t] = (schedule[t - 16] + s0 + schedule[t - 7] + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let t = 0; t < 64; t += 1) {
      const bigS1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + bigS1 + ch + K256[t] + schedule[t]) | 0;
      const bigS0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (bigS0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => (word >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

function asPendingChange(raw: unknown): PendingChange {
  return raw as unknown as PendingChange;
}

describe('canonical serialization', () => {
  it('implements real SHA-256 (reference vectors)', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('produces sorted-key, whitespace-free JSON', () => {
    expect(canonicalizeJson({ b: 1, a: [3, 2], c: { z: null, y: true } })).toBe(
      '{"a":[3,2],"b":1,"c":{"y":true,"z":null}}',
    );
  });

  it('is independent of caller key order for change hash input', () => {
    const first = canonicalChangeHashInput({
      entityType: 'workitem',
      entityId: 'wi-7',
      schemaVersion: 3,
      baseRevision: 7,
      operation: 'update',
      payload: { title: 'Fix nav', position: 3, tags: ['web', 'nav'] },
    });
    const reordered = canonicalChangeHashInput({
      payload: { tags: ['web', 'nav'], title: 'Fix nav', position: 3 },
      operation: 'update',
      baseRevision: 7,
      schemaVersion: 3,
      entityId: 'wi-7',
      entityType: 'workitem',
    });
    expect(first).toBe(reordered);
    expect(first).toBe(
      '{"baseRevision":7,"entityId":"wi-7","entityType":"workitem","operation":"update",' +
        '"payload":{"position":3,"tags":["web","nav"],"title":"Fix nav"},"schemaVersion":3}',
    );
  });

  it('distinguishes operations and bases with the same payload', () => {
    const base = {
      entityType: 'agent',
      entityId: 'agent-old',
      schemaVersion: 1,
      payload: undefined,
    } as const;
    const del = canonicalChangeHashInput({ ...base, baseRevision: 3, operation: 'delete' });
    const upd = canonicalChangeHashInput({ ...base, baseRevision: 3, operation: 'update' });
    const create = canonicalChangeHashInput({ ...base, baseRevision: null, operation: 'create' });
    expect(new Set([del, upd, create]).size).toBe(3);
  });

  it('hashes through the injected function without Node crypto in the contract', () => {
    const change = asPendingChange(pushBatch.changes[1]);
    expect(change.operation as SyncOperation).toBe('update');
    expect(hashChange(change, sha256Hex)).toBe(sha256Hex(canonicalChangeHashInput(change)));
    expect(hashChange(change, () => 'constant')).toBe('constant');
  });

  it('matches the committed payloadHash values in the push-batch fixture', () => {
    const computed = pushBatch.changes.map((raw) => hashChange(asPendingChange(raw), sha256Hex));
    expect(computed).toEqual(pushBatch.changes.map((change) => change.payloadHash));
  });
});
