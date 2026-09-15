import { describe, expect, it, vi } from 'vitest';

import {
  signHostedServiceRequest,
  verifyHostedServiceRequest,
  type HostedServiceAuthConfig,
} from '../src/hosted/service-auth';

const AUDIENCE = 'anvil-hosted-test';
const SECRET = 'test-signing-secret-with-32+bytes!!';
const SECRET_B = 'rotation-signing-secret-with-32+bytes!';
const encoder = new TextEncoder();
const NOW = 1_800_000_000_000;
const REQUEST_ID = 'abcdef0123456789';

function makeConfig(overrides: Partial<HostedServiceAuthConfig> = {}) {
  const seen = new Set<string>();
  const consumeNonce = vi.fn(async (keyId: string, requestId: string) => {
    const key = `${keyId}:${requestId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    config: { audience: AUDIENCE, keys: { keyA: SECRET }, consumeNonce, ...overrides },
    consumeNonce,
  };
}

async function signedRequest(
  url = 'https://sync.test/v1/jobs?limit=1',
  options: { method?: string; body?: Uint8Array; keyId?: string; secret?: string; audience?: string; now?: number; requestId?: string } = {},
) {
  const body = options.body ?? encoder.encode('{"op":"submit"}');
  const request = new Request(url, { method: options.method ?? 'POST', body });
  const headers = await signHostedServiceRequest(
    request,
    body,
    {
      audience: options.audience ?? AUDIENCE,
      keyId: options.keyId ?? 'keyA',
      secret: options.secret ?? SECRET,
    },
    options.now ?? NOW,
    options.requestId ?? REQUEST_ID,
  );
  const signed = new Request(url, { method: options.method ?? 'POST', body, headers });
  return { request: signed, body };
}

describe('hosted service auth', () => {
  it('accepts a valid signed request then rejects its replay', async () => {
    const { config } = makeConfig();
    const { request, body } = await signedRequest();
    expect(await verifyHostedServiceRequest(request, body, config, NOW)).toBe(true);
    const { request: replay } = await signedRequest();
    expect(await verifyHostedServiceRequest(replay, body, config, NOW)).toBe(false);
  });

  it.each([
    ['method', async () => {
      const { request, body } = await signedRequest();
      const headers = request.headers;
      return new Request(request.url, { method: 'GET', headers });
    }],
    ['path', async () => {
      const { request } = await signedRequest();
      return new Request('https://sync.test/v1/other?limit=1', { method: 'POST', headers: request.headers });
    }],
    ['query', async () => {
      const { request } = await signedRequest();
      return new Request('https://sync.test/v1/jobs?limit=2', { method: 'POST', headers: request.headers });
    }],
  ])('rejects tampered %s', async (_label, tamper) => {
    const { config } = makeConfig();
    const { body } = await signedRequest();
    expect(await verifyHostedServiceRequest(await tamper(), body, config, NOW)).toBe(false);
  });

  it('rejects a tampered body', async () => {
    const { config } = makeConfig();
    const { request } = await signedRequest();
    expect(
      await verifyHostedServiceRequest(request, encoder.encode('{"op":"other"}'), config, NOW),
    ).toBe(false);
  });

  it('rejects a signature minted under a different key id or audience', async () => {
    const { config } = makeConfig();
    const { request, body } = await signedRequest('https://sync.test/v1/jobs?limit=1', {
      keyId: 'keyB',
      secret: SECRET,
    });
    expect(await verifyHostedServiceRequest(request, body, config, NOW)).toBe(false);

    const other = await signedRequest('https://sync.test/v1/jobs?limit=1', {
      audience: 'other-audience',
      requestId: 'fedcba9876543210',
    });
    expect(await verifyHostedServiceRequest(other.request, other.body, config, NOW)).toBe(false);
  });

  it('rejects malformed signature and unknown key id before consumeNonce', async () => {
    const { config, consumeNonce } = makeConfig();
    const { request, body } = await signedRequest();
    const headers = new Headers(request.headers);
    headers.set('x-anvil-signature', 'f'.repeat(64));
    expect(
      await verifyHostedServiceRequest(
        new Request(request.url, { method: 'POST', headers }),
        body,
        config,
        NOW,
      ),
    ).toBe(false);

    const headers2 = new Headers(request.headers);
    headers2.set('x-anvil-key-id', 'unknownKey');
    expect(
      await verifyHostedServiceRequest(
        new Request(request.url, { method: 'POST', headers: headers2 }),
        body,
        config,
        NOW,
      ),
    ).toBe(false);
    expect(consumeNonce).not.toHaveBeenCalled();
  });

  it('rejects stale and future timestamps before consumeNonce, accepts the exact boundary once', async () => {
    const { config, consumeNonce } = makeConfig();
    const stale = await signedRequest('https://sync.test/v1/jobs?limit=1', { now: NOW - 300_001 });
    expect(await verifyHostedServiceRequest(stale.request, stale.body, config, NOW)).toBe(false);

    const future = await signedRequest('https://sync.test/v1/jobs?limit=1', {
      now: NOW + 300_001,
      requestId: '1111111111111111',
    });
    expect(await verifyHostedServiceRequest(future.request, future.body, config, NOW)).toBe(false);
    expect(consumeNonce).not.toHaveBeenCalled();

    const boundary = await signedRequest('https://sync.test/v1/jobs?limit=1', {
      now: NOW - 300_000,
      requestId: '2222222222222222',
    });
    expect(await verifyHostedServiceRequest(boundary.request, boundary.body, config, NOW)).toBe(true);
  });

  it('accepts either configured rotation key', async () => {
    const { config } = makeConfig({ keys: { keyA: SECRET, keyB: SECRET_B } });
    const a = await signedRequest('https://sync.test/v1/jobs?limit=1', { requestId: 'aaaaaaaaaaaaaaaa' });
    expect(await verifyHostedServiceRequest(a.request, a.body, config, NOW)).toBe(true);
    const b = await signedRequest('https://sync.test/v1/jobs?limit=1', {
      keyId: 'keyB',
      secret: SECRET_B,
      requestId: 'bbbbbbbbbbbbbbbb',
    });
    expect(await verifyHostedServiceRequest(b.request, b.body, config, NOW)).toBe(true);
  });

  it('rejects a device Bearer credential alone', async () => {
    const { config, consumeNonce } = makeConfig();
    const request = new Request('https://sync.test/v1/jobs?limit=1', {
      method: 'POST',
      headers: { authorization: 'Bearer anvil_at_testtoken' },
    });
    expect(await verifyHostedServiceRequest(request, encoder.encode('{}'), config, NOW)).toBe(false);
    expect(consumeNonce).not.toHaveBeenCalled();
  });

  it('propagates consumeNonce failure instead of allowing', async () => {
    const { config } = makeConfig({
      consumeNonce: async () => {
        throw new Error('d1 unavailable');
      },
    });
    const { request, body } = await signedRequest();
    await expect(verifyHostedServiceRequest(request, body, config, NOW)).rejects.toThrow(
      'd1 unavailable',
    );
  });

  it('rejects signing with a short key and generates a random default request id', async () => {
    await expect(
      signHostedServiceRequest(
        new Request('https://sync.test/v1/jobs', { method: 'POST' }),
        encoder.encode('{}'),
        { audience: AUDIENCE, keyId: 'keyA', secret: 'short' },
        NOW,
      ),
    ).rejects.toThrow('at least 32 bytes');

    const request = new Request('https://sync.test/v1/jobs', { method: 'POST' });
    const first = await signHostedServiceRequest(
      request,
      encoder.encode('{}'),
      { audience: AUDIENCE, keyId: 'keyA', secret: SECRET },
      NOW,
    );
    const second = await signHostedServiceRequest(
      request,
      encoder.encode('{}'),
      { audience: AUDIENCE, keyId: 'keyA', secret: SECRET },
      NOW,
    );
    expect(first.get('x-anvil-request-id')).not.toBe(second.get('x-anvil-request-id'));
  });
});
