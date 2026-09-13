import { parseDeviceBearer, parseSpikeAuth, type VerifiedAuth } from './auth';
import { AccountCoordinator } from './account-coordinator';
import { SessionCoordinator } from './session-coordinator';
import { buildDescriptor } from './descriptor';
import { parseRpcRequest, rpcErrorResponse, rpcSuccessResponse } from './rpc';

export { AccountCoordinator, SessionCoordinator };

const RPC_BODY_MAX_BYTES = 512 * 1024;
const AUTH_BODY_MAX_BYTES = 16 * 1024;

function sessionStub(env: Env): DurableObjectStub {
  return env.SESSIONS.get(env.SESSIONS.idFromName('sessions'));
}

/**
 * Bounded request-body read: rejects on a declared content-length over the
 * cap, and aborts the stream if the actual bytes exceed it. Returns null on
 * overflow so callers can answer 413 without buffering the body.
 */
async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }
  const body = request.body;
  if (body === null) {
    return '';
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

/**
 * Turns the request's bearer into a verified {accountId, enrollmentId}.
 * Device tokens are validated against the SessionCoordinator; the spike
 * bearer is honored only when ANVIL_DEV_SPIKE is enabled for development.
 */
async function authenticate(request: Request, env: Env): Promise<VerifiedAuth | null> {
  const deviceToken = parseDeviceBearer(request.headers.get('Authorization'));
  if (deviceToken !== null) {
    const response = await sessionStub(env).fetch('https://internal.anvil/internal/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: deviceToken }),
    });
    if (!response.ok) {
      return null;
    }
    const identity = (await response.json()) as { accountId?: unknown; enrollmentId?: unknown };
    if (typeof identity.accountId !== 'string' || typeof identity.enrollmentId !== 'string') {
      return null;
    }
    return { accountId: identity.accountId, enrollmentId: identity.enrollmentId };
  }
  if (env.ANVIL_DEV_SPIKE === 'true') {
    return parseSpikeAuth(request.headers.get('Authorization'));
  }
  return null;
}

/** Forwards a request to the account object with worker-verified identity headers. */
function forwardToAccount(
  env: Env,
  auth: VerifiedAuth,
  init: { method: string; headers: Headers; body?: string },
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-anvil-account', auth.accountId);
  headers.set('x-anvil-enrollment', auth.enrollmentId);
  const id = env.ACCOUNT.idFromName(auth.accountId);
  const stub = env.ACCOUNT.get(id);
  return stub.fetch(
    new Request('https://internal.anvil/v1/rpc', {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
  );
}

/** Public auth routes: straight JSON bodies, no RPC envelope. */
async function forwardAuthRoute(
  env: Env,
  path: string,
  request: Request,
  bodyText: string,
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  const authorization = request.headers.get('Authorization');
  if (authorization !== null) {
    headers.set('Authorization', authorization);
  }
  return sessionStub(env).fetch(
    new Request(`https://internal.anvil${path}`, {
      method: 'POST',
      headers,
      body: bodyText,
    }),
  );
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'GET' && path === '/.well-known/anvil-backend') {
    return Response.json(buildDescriptor(env));
  }

  if (path === '/v1/connect') {
    return handleConnect(request, env);
  }

  if (request.method === 'POST' && path.startsWith('/v1/')) {
    const authRoute =
      path === '/v1/enroll'
        ? '/enroll'
        : path === '/v1/session/refresh'
          ? '/session/refresh'
          : path === '/v1/session/revoke'
            ? '/session/revoke'
            : path === '/v1/enrollment-codes'
              ? '/enrollment-codes'
              : null;
    if (authRoute !== null) {
      const bodyText = await readBoundedBody(request, AUTH_BODY_MAX_BYTES);
      if (bodyText === null) {
        return rpcErrorResponse(undefined, 'payload-too-large');
      }
      return forwardAuthRoute(env, authRoute, request, bodyText);
    }
  }

  if (path === '/v1/rpc') {
    return handleRpc(request, env);
  }

  return rpcErrorResponse(undefined, 'not-found');
}

async function handleConnect(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const auth = await authenticate(request, env);
  if (auth === null) {
    return rpcErrorResponse(undefined, 'unauthenticated');
  }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  return forwardToAccount(env, auth, {
    method: 'GET',
    headers: new Headers(request.headers),
  });
}

async function handleRpc(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const bodyText = await readBoundedBody(request, RPC_BODY_MAX_BYTES);
  if (bodyText === null) {
    return rpcErrorResponse(undefined, 'payload-too-large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const envelope = parseRpcRequest(parsed);
  if (!envelope.ok) {
    return rpcErrorResponse(envelope.requestId, envelope.code);
  }
  const auth = await authenticate(request, env);
  if (auth === null) {
    return rpcErrorResponse(envelope.request.requestId, 'unauthenticated');
  }
  switch (envelope.request.operation) {
    case 'session.describe': {
      const response = await sessionStub(env).fetch(
        new Request('https://internal.anvil/internal/describe', {
          method: 'POST',
          headers: {
            'x-anvil-account': auth.accountId,
            'x-anvil-enrollment': auth.enrollmentId,
          },
        }),
      );
      if (!response.ok) {
        return rpcErrorResponse(envelope.request.requestId, 'unauthenticated');
      }
      return rpcSuccessResponse(envelope.request.requestId, await response.json());
    }
    case 'sync.push':
    case 'sync.pull':
    case 'sync.scan.begin':
    case 'sync.scan.page':
    case 'sync.scan.finish': {
      return forwardToAccount(env, auth, {
        method: 'POST',
        headers: new Headers(request.headers),
        body: bodyText,
      });
    }
    default:
      return rpcErrorResponse(envelope.request.requestId, 'unsupported-operation');
  }
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
