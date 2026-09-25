import { describe, expect, it } from 'vitest';

import {
  ErrorCode,
  httpStatusForErrorCode,
  isRpcError,
  RpcError,
  RpcSuccess,
} from '../envelope';
import oversizedError from '../fixtures/oversized-error.json';
import pullPage from '../fixtures/pull-page.json';
import pushResult from '../fixtures/push-result.json';

describe('httpStatusForErrorCode', () => {
  it('matches integration-contract section 5 status agreement', () => {
    const expected: Record<ErrorCode, number> = {
      unauthenticated: 401,
      forbidden: 403,
      conflict: 409,
      'payload-too-large': 413,
      throttled: 429,
      unavailable: 503,
      'malformed-request': 400,
      'unsupported-version': 400,
      'unsupported-operation': 400,
      'reset-required': 409,
      'receipt-expired': 409,
      'epoch-mismatch': 409,
      'not-found': 404,
      'quota-exceeded': 413,
      'stale-generation': 409,
      'invalid-transition': 409,
    };
    for (const [code, status] of Object.entries(expected) as Array<[ErrorCode, number]>) {
      expect(httpStatusForErrorCode(code)).toBe(status);
    }
  });
});

describe('error envelope fixtures', () => {
  it('parses the oversized-payload rejection as a non-retryable 413 error', () => {
    const envelope = oversizedError as unknown as RpcError;
    expect(isRpcError(envelope)).toBe(true);
    expect(envelope.error.code).toBe('payload-too-large');
    expect(envelope.error.retryable).toBe(false);
    expect(httpStatusForErrorCode(envelope.error.code)).toBe(413);
    expect(envelope.requestId).toBe('e672c524-bc21-4b24-8646-0e9ee7bdd79e');
  });

  it('distinguishes success envelopes from errors', () => {
    const success: RpcSuccess<{ ok: boolean }> = {
      requestId: 'req-1',
      result: { ok: true },
      serverTime: '2026-09-11T08:00:00.000Z',
    };
    expect(isRpcError(success)).toBe(false);
  });

  it('holds mixed per-item push outcomes inside a successful batch', () => {
    const statuses = pushResult.results.map((result) => result.status);
    expect(statuses).toEqual(['accepted', 'conflict', 'receipt-expired']);
  });

  it('reads the pull page cursor contract', () => {
    expect(pullPage.hasMore).toBe(true);
    expect(typeof pullPage.nextCursor).toBe('string');
    expect(pullPage.changes.length).toBeGreaterThan(0);
  });
});
