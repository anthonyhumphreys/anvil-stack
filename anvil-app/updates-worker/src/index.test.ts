import { describe, expect, it, vi } from 'vitest';
import { handleRequest } from './handler.js';

function createRateLimiter(success = true): RateLimit {
  return { limit: vi.fn(async () => ({ success })) };
}

function createObject(
  key: string,
  body = 'update',
  options: { range?: R2Range; size?: number } = {},
): R2ObjectBody {
  const bytes = new TextEncoder().encode(body);
  const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    bodyUsed: false,
    key,
    version: '1',
    size: options.size ?? bytes.byteLength,
    etag: 'etag',
    httpEtag: '"etag"',
    checksums: { toJSON: () => ({}) },
    uploaded: new Date('2026-08-31T00:00:00Z'),
    httpMetadata: { contentType: headers.get('Content-Type') ?? undefined },
    customMetadata: {},
    range: options.range,
    storageClass: 'Standard',
    writeHttpMetadata(target) {
      for (const [name, value] of headers) target.set(name, value);
    },
    arrayBuffer: async () => new Blob([bytes]).arrayBuffer(),
    blob: async () => new Blob([bytes]),
    bytes: async () => bytes,
    json: async <T>() => JSON.parse(body) as T,
    text: async () => body,
  };
}

function createEnv(options: { assetAllowed?: boolean; feedAllowed?: boolean } = {}) {
  return {
    ASSET_RATE_LIMITER: createRateLimiter(options.assetAllowed ?? true),
    FEED_RATE_LIMITER: createRateLimiter(options.feedAllowed ?? true),
    RELEASES: {
      get: vi.fn(async (key: string) => createObject(key)),
      head: vi.fn(async (key: string) => createObject(key)),
    },
  };
}

describe('desktop updates Worker', () => {
  it('serves the feed from its fixed R2 key with short caching', async () => {
    const env = createEnv();
    const response = await handleRequest(
      new Request('https://updates.example/v1/macos/arm64/feed.json', {
        headers: { 'CF-Connecting-IP': '203.0.113.10' },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('max-age=60');
    expect(env.RELEASES.get).toHaveBeenCalledWith('macos/arm64/feed.json', expect.any(Object));
    expect(env.FEED_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: '203.0.113.10' });
  });

  it('serves only valid versioned release assets with immutable caching', async () => {
    const env = createEnv();
    const response = await handleRequest(
      new Request(
        'https://updates.example/v1/macos/arm64/releases/0.6.13/Anvil-0.6.13-arm64-mac.zip',
      ),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('immutable');
    expect(env.RELEASES.get).toHaveBeenCalledWith(
      'macos/arm64/releases/0.6.13/Anvil-0.6.13-arm64-mac.zip',
      expect.any(Object),
    );
  });

  it('rejects bucket paths that are not public routes', async () => {
    const env = createEnv();
    const response = await handleRequest(
      new Request('https://updates.example/secrets/internal.txt'),
      env,
    );

    expect(response.status).toBe(404);
    expect(env.RELEASES.get).not.toHaveBeenCalled();
  });

  it('returns retry guidance when the asset limit is exceeded', async () => {
    const env = createEnv({ assetAllowed: false });
    const response = await handleRequest(
      new Request(
        'https://updates.example/v1/macos/arm64/releases/0.6.13/Anvil-0.6.13-arm64-mac.zip',
      ),
      env,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(env.RELEASES.get).not.toHaveBeenCalled();
  });

  it('supports metadata-only HEAD requests', async () => {
    const env = createEnv();
    const response = await handleRequest(
      new Request('https://updates.example/v1/macos/arm64/feed.json', { method: 'HEAD' }),
      env,
    );

    expect(response.status).toBe(200);
    expect(env.RELEASES.head).toHaveBeenCalledWith('macos/arm64/feed.json');
    expect(env.RELEASES.get).not.toHaveBeenCalled();
  });

  it('returns byte-range headers without buffering the asset', async () => {
    const env = createEnv();
    env.RELEASES.get.mockResolvedValue(
      createObject('macos/arm64/releases/0.6.13/Anvil-0.6.13-arm64-mac.zip', 'part', {
        range: { offset: 2, length: 4 },
        size: 10,
      }),
    );

    const response = await handleRequest(
      new Request(
        'https://updates.example/v1/macos/arm64/releases/0.6.13/Anvil-0.6.13-arm64-mac.zip',
        { headers: { Range: 'bytes=2-5' } },
      ),
      env,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(response.headers.get('Content-Length')).toBe('4');
  });
});
