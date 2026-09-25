import { SELF } from 'cloudflare:test';

import { canonicalChangeHashInput, type PendingChange, type SyncOperation } from '../../contract/sync';
import { PROTOCOL } from '../../contract/version';
import { isRpcError, type RpcResponse } from '../../contract/envelope';
import { sha256Hex } from '../src/hash';

export function spikeBearer(accountId: string, enrollmentId: string): string {
  return `Bearer spike:${accountId}:${enrollmentId}`;
}

export function uniqueIds(label: string): { accountId: string; enrollmentId: string } {
  const token = `${label}-${crypto.randomUUID()}`;
  return { accountId: `acct-${token}`, enrollmentId: `enr-${token}` };
}

export async function hashedChange(input: {
  enrollmentSequence: number;
  entityId: string;
  entityType?: string;
  schemaVersion?: number;
  operation?: SyncOperation;
  baseRevision?: number | null;
  payload?: unknown;
}): Promise<PendingChange> {
  const operation = input.operation ?? 'create';
  const baseRevision =
    input.baseRevision === undefined
      ? operation === 'create'
        ? null
        : 1
      : input.baseRevision;
  const withoutHash = {
    changeId: crypto.randomUUID(),
    enrollmentSequence: input.enrollmentSequence,
    entityType: input.entityType ?? 'workspace',
    entityId: input.entityId,
    schemaVersion: input.schemaVersion ?? 1,
    baseRevision,
    operation,
    ...(operation === 'delete' ? {} : { payload: input.payload ?? { name: input.entityId } }),
  };
  const payloadHash = await sha256Hex(canonicalChangeHashInput(withoutHash));
  return { ...withoutHash, payloadHash };
}

export async function postRpc(
  operation: string,
  params: unknown,
  authorization: string,
  requestId: string = crypto.randomUUID(),
): Promise<{ status: number; body: RpcResponse }> {
  const response = await SELF.fetch('https://spike.test/v1/rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authorization,
    },
    body: JSON.stringify({
      protocol: PROTOCOL,
      requestId,
      operation,
      params,
    }),
  });
  const body = (await response.json()) as RpcResponse;
  return { status: response.status, body };
}

export function expectSuccess<R>(response: { status: number; body: RpcResponse }): R {
  if (response.status !== 200 || isRpcError(response.body)) {
    throw new Error(`expected RPC success, got HTTP ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.result as R;
}

/**
 * Resolves with the first socket frame of the given type, skipping others
 * (notably the session `hello` that now opens every accepted socket).
 */
export function nextFrameOfType(
  socket: WebSocket,
  type: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} frame timed out`)), timeoutMs);
    socket.addEventListener('message', (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if ((parsed as Record<string, unknown>)['type'] !== type) return;
      clearTimeout(timer);
      resolve(parsed as Record<string, unknown>);
    });
  });
}
