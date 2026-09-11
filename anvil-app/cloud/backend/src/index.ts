import { parseSpikeAuth } from './auth';
import { AccountCoordinator } from './account-coordinator';
import { buildDescriptor } from './descriptor';
import { parseRpcRequest, rpcErrorResponse } from './rpc';

export { AccountCoordinator };

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'GET' && path === '/.well-known/anvil-backend') {
    return Response.json(buildDescriptor());
  }

  if (path === '/v1/connect') {
    return handleConnect(request, env);
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
  const auth = parseSpikeAuth(request.headers.get('Authorization'));
  if (auth === null) {
    return rpcErrorResponse(undefined, 'unauthenticated');
  }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const id = env.ACCOUNT.idFromName(auth.accountId);
  const stub = env.ACCOUNT.get(id);
  return stub.fetch(request);
}

async function handleRpc(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const auth = parseSpikeAuth(request.headers.get('Authorization'));
  if (auth === null) {
    return rpcErrorResponse(undefined, 'unauthenticated');
  }
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return rpcErrorResponse(undefined, 'malformed-request');
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
  switch (envelope.request.operation) {
    case 'sync.push':
    case 'sync.pull':
    case 'sync.scan.begin':
    case 'sync.scan.page':
    case 'sync.scan.finish': {
      const id = env.ACCOUNT.idFromName(auth.accountId);
      const stub = env.ACCOUNT.get(id);
      return stub.fetch(
        new Request(request.url, {
          method: 'POST',
          headers: request.headers,
          body: bodyText,
        }),
      );
    }
    default:
      return rpcErrorResponse(envelope.request.requestId, 'unsupported-operation');
  }
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
