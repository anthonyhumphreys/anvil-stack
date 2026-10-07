import { isRecord, rpcErrorResponse } from '../rpc';
import { audit } from './billing';
import { verifyHostedServiceRequest } from './service-auth';
import { consumeServiceNonce, findActiveBillingBySyncAccount } from './store';

const BODY_LIMIT = 8 * 1024;
export const FAIR_USE_OPERATOR_AUDIENCE = 'anvil-hosted-operator';

function operatorKeys(
  raw: string | undefined,
  websiteKeysRaw: string | undefined,
): Record<string, string> | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || Object.keys(value).length === 0) return null;
  const keys: Record<string, string> = Object.create(null);
  let websiteSecrets: unknown[] = [];
  if (websiteKeysRaw) {
    try {
      const websiteKeys: unknown = JSON.parse(websiteKeysRaw);
      if (!isRecord(websiteKeys)) return null;
      websiteSecrets = Object.values(websiteKeys);
    } catch {
      return null;
    }
  }
  for (const [id, secret] of Object.entries(value)) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
      typeof secret !== 'string' ||
      new TextEncoder().encode(secret).byteLength < 32 ||
      websiteSecrets.includes(secret)
    )
      return null;
    keys[id] = secret;
  }
  return keys;
}

async function readBody(request: Request): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > BODY_LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Operator credentials are deliberately separate from the website service channel. */
export async function handleFairUseOperatorRequest(request: Request, env: Env): Promise<Response> {
  const db = env.HOSTED_DB;
  const keys = operatorKeys(env.HOSTED_OPERATOR_KEYS, env.HOSTED_SERVICE_KEYS);
  if (!db || !keys) return rpcErrorResponse(undefined, 'not-found');
  if (request.method !== 'POST') return rpcErrorResponse(undefined, 'malformed-request');
  const bytes = await readBody(request);
  if (bytes === null) return rpcErrorResponse(undefined, 'payload-too-large');
  const verified = await verifyHostedServiceRequest(
    request,
    bytes,
    {
      audience: FAIR_USE_OPERATOR_AUDIENCE,
      keys,
      consumeNonce: (keyId, requestId, expiresAt) =>
        consumeServiceNonce(db, `operator:${keyId}`, requestId, expiresAt),
    },
    Date.now(),
  );
  if (!verified) return rpcErrorResponse(undefined, 'unauthenticated');
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  if (
    !isRecord(body) ||
    typeof body.accountId !== 'string' ||
    body.accountId.length === 0 ||
    body.accountId.length > 256 ||
    typeof body.action !== 'string' ||
    !['status', 'set', 'clear'].includes(body.action)
  )
    return rpcErrorResponse(undefined, 'malformed-request');
  const account = await findActiveBillingBySyncAccount(db, body.accountId);
  if (!account) return rpcErrorResponse(undefined, 'not-found');
  const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(body.accountId));
  const response =
    body.action === 'status'
      ? await stub.fetch('https://internal.anvil/internal/fair-use')
      : await stub.fetch('https://internal.anvil/internal/fair-use/restriction', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: body.action,
            code: body.code,
            message: body.message,
            restrictAt: body.restrictAt,
            emergency: body.emergency,
          }),
        });
  if (response.ok && body.action !== 'status') {
    await audit(db, account.id, 'fair-use.operator-change', {
      operatorKeyId: request.headers.get('x-anvil-key-id'),
      action: body.action,
      emergency: body.emergency === true,
    });
  }
  return response;
}
