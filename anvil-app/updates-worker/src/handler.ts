type UpdateServiceEnv = {
  ASSET_RATE_LIMITER: RateLimit;
  FEED_RATE_LIMITER: RateLimit;
  RELEASES: Pick<R2Bucket, 'get' | 'head'>;
};

type PublicObject = {
  cacheControl: string;
  key: string;
  rateLimiter: RateLimit;
};

const FEED_PATH = '/v1/macos/arm64/feed.json';
const VERSIONED_ASSET_PATH =
  /^\/v1\/macos\/arm64\/releases\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/(Anvil-[0-9A-Za-z.-]+-arm64-mac\.zip)$/;

const SHORT_CACHE = 'public, max-age=60, s-maxage=300, must-revalidate';
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

export async function handleRequest(request: Request, env: UpdateServiceEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { Allow: 'GET, HEAD' });
  }

  if (url.pathname === '/health' && request.method === 'GET') {
    return jsonResponse({ ok: true }, 200, { 'Cache-Control': 'no-store' });
  }

  const publicObject = resolvePublicObject(url.pathname, env);
  if (!publicObject) {
    return jsonResponse({ error: 'Not found.' }, 404);
  }

  const rateLimitKey = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const rateLimit = await publicObject.rateLimiter.limit({ key: rateLimitKey });
  if (!rateLimit.success) {
    return jsonResponse({ error: 'Rate limit exceeded.' }, 429, {
      'Cache-Control': 'no-store',
      'Retry-After': '60',
    });
  }

  if (request.method === 'HEAD') {
    const object = await env.RELEASES.head(publicObject.key);
    if (!object) return jsonResponse({ error: 'Not found.' }, 404);
    return objectResponse(null, object, publicObject.cacheControl, 200);
  }

  const object = await env.RELEASES.get(publicObject.key, {
    onlyIf: request.headers,
    range: request.headers,
  });
  if (!object) return jsonResponse({ error: 'Not found.' }, 404);

  if (!('body' in object)) {
    const status =
      request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since') ? 304 : 412;
    return objectResponse(null, object, publicObject.cacheControl, status);
  }

  return objectResponse(object.body, object, publicObject.cacheControl, object.range ? 206 : 200);
}

function resolvePublicObject(pathname: string, env: UpdateServiceEnv): PublicObject | null {
  if (pathname === FEED_PATH) {
    return {
      cacheControl: SHORT_CACHE,
      key: 'macos/arm64/feed.json',
      rateLimiter: env.FEED_RATE_LIMITER,
    };
  }

  const match = VERSIONED_ASSET_PATH.exec(pathname);
  if (!match) return null;

  return {
    cacheControl: IMMUTABLE_CACHE,
    key: `macos/arm64/releases/${match[1]}/${match[2]}`,
    rateLimiter: env.ASSET_RATE_LIMITER,
  };
}

function objectResponse(
  body: ReadableStream | null,
  object: R2Object,
  cacheControl: string,
  status: number,
): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', cacheControl);
  headers.set('ETag', object.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');

  if (status !== 304 && status !== 412) {
    headers.set('Content-Length', String(responseLength(object)));
  }

  if (object.range) {
    headers.set('Content-Range', contentRange(object.range, object.size));
  }

  return new Response(body, { headers, status });
}

function responseLength(object: R2Object): number {
  if (!object.range) return object.size;
  if ('suffix' in object.range) return Math.min(object.range.suffix, object.size);
  const offset = object.range.offset ?? 0;
  return Math.min(object.range.length ?? object.size - offset, object.size - offset);
}

function contentRange(range: R2Range, objectSize: number): string {
  if ('suffix' in range) {
    const length = Math.min(range.suffix, objectSize);
    return `bytes ${objectSize - length}-${objectSize - 1}/${objectSize}`;
  }

  const start = range.offset ?? 0;
  const length = Math.min(range.length ?? objectSize - start, objectSize - start);
  return `bytes ${start}-${start + length - 1}/${objectSize}`;
}

function jsonResponse(
  value: Record<string, unknown>,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
