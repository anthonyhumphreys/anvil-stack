export interface HostedServiceAuthConfig {
  audience: string;
  keys: Readonly<Record<string, string>>;
  consumeNonce: (keyId: string, requestId: string, expiresAt: number) => Promise<boolean>;
}

const SKEW_MS = 300_000;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('');

async function signingKey(secret: string): Promise<CryptoKey> {
  if (encoder.encode(secret).byteLength < 32)
    throw new Error('Hosted signing key must contain at least 32 bytes');
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signaturePayload(
  request: Request,
  body: Uint8Array,
  audience: string,
  keyId: string,
  timestamp: string,
  requestId: string,
): Promise<Uint8Array> {
  const url = new URL(request.url);
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', Uint8Array.from(body).buffer as ArrayBuffer));
  return encoder.encode(
    [
      'anvil-hosted/1',
      audience,
      keyId,
      request.method.toUpperCase(),
      url.pathname + url.search,
      timestamp,
      requestId,
      bodyHash,
    ].join('\n'),
  );
}

export async function signHostedServiceRequest(
  request: Request,
  body: Uint8Array,
  config: { audience: string; keyId: string; secret: string },
  now: number,
  requestId: string = crypto.randomUUID(),
): Promise<Headers> {
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(config.keyId) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(requestId) ||
    !Number.isSafeInteger(now) ||
    /[\r\n]/.test(config.audience) ||
    !config.audience
  )
    throw new Error('Invalid hosted signature input');
  const timestamp = String(now);
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(config.secret),
    Uint8Array.from(await signaturePayload(request, body, config.audience, config.keyId, timestamp, requestId)).buffer as ArrayBuffer,
  );
  return new Headers({
    'x-anvil-key-id': config.keyId,
    'x-anvil-timestamp': timestamp,
    'x-anvil-request-id': requestId,
    'x-anvil-signature': hex(signature),
  });
}

export async function verifyHostedServiceRequest(
  request: Request,
  body: Uint8Array,
  config: HostedServiceAuthConfig,
  now: number,
): Promise<boolean> {
  const keyId = request.headers.get('x-anvil-key-id') ?? '';
  const requestId = request.headers.get('x-anvil-request-id') ?? '';
  const timestamp = request.headers.get('x-anvil-timestamp') ?? '';
  const signature = request.headers.get('x-anvil-signature') ?? '';
  const time = Number(timestamp);
  if (
    !Number.isSafeInteger(now) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(requestId) ||
    !/^\d{1,16}$/.test(timestamp) ||
    !Number.isSafeInteger(time) ||
    Math.abs(now - time) > SKEW_MS ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    !Object.hasOwn(config.keys, keyId) ||
    !config.audience ||
    /[\r\n]/.test(config.audience)
  )
    return false;
  const key = await signingKey(config.keys[keyId]!);
  const bytes = Uint8Array.from(signature.match(/../g)!, (pair) => parseInt(pair, 16));
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      key,
      bytes,
      Uint8Array.from(await signaturePayload(request, body, config.audience, keyId, timestamp, requestId)).buffer as ArrayBuffer,
    ))
  )
    return false;
  return config.consumeNonce(keyId, requestId, time + SKEW_MS);
}
