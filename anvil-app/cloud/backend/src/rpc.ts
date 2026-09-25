import {
  httpStatusForErrorCode,
  type ErrorCode,
  type RpcError,
  type RpcRequest,
  type RpcSuccess,
} from '../../contract/envelope';
import { PROTOCOL } from '../../contract/version';

export class RpcFailure extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, details?: Record<string, unknown>, retryable?: boolean) {
    super(code);
    this.name = 'RpcFailure';
    this.code = code;
    this.retryable = retryable ?? retryableFor(code);
    this.details = details;
  }
}

export function isRpcFailure(error: unknown): error is RpcFailure {
  return error instanceof RpcFailure;
}

export function retryableFor(code: ErrorCode): boolean {
  switch (code) {
    case 'throttled':
    case 'unavailable':
      return true;
    case 'unauthenticated':
    case 'forbidden':
    case 'conflict':
    case 'payload-too-large':
    case 'malformed-request':
    case 'unsupported-version':
    case 'unsupported-operation':
    case 'reset-required':
    case 'receipt-expired':
    case 'epoch-mismatch':
    case 'not-found':
    case 'quota-exceeded':
    case 'stale-generation':
    case 'invalid-transition':
      return false;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ParseRpcResult =
  | { ok: true; request: RpcRequest }
  | { ok: false; requestId?: string; code: ErrorCode };

/**
 * Structural parse of a versioned RPC envelope. Does not interpret `params`.
 */
export function parseRpcRequest(input: unknown): ParseRpcResult {
  if (!isRecord(input)) {
    return { ok: false, code: 'malformed-request' };
  }
  const requestIdRaw = input['requestId'];
  const requestId =
    typeof requestIdRaw === 'string' && requestIdRaw.length > 0 ? requestIdRaw : undefined;
  if (requestId === undefined) {
    return { ok: false, code: 'malformed-request' };
  }
  const protocol = input['protocol'];
  if (protocol === undefined) {
    return { ok: false, requestId, code: 'malformed-request' };
  }
  if (protocol !== PROTOCOL) {
    return { ok: false, requestId, code: 'unsupported-version' };
  }
  const operation = input['operation'];
  if (typeof operation !== 'string' || operation.length === 0) {
    return { ok: false, requestId, code: 'malformed-request' };
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'params')) {
    return { ok: false, requestId, code: 'malformed-request' };
  }
  return {
    ok: true,
    request: {
      protocol: PROTOCOL,
      requestId,
      operation,
      params: input['params'],
    },
  };
}

export function rpcErrorResponse(
  requestId: string | undefined,
  code: ErrorCode,
  details?: Record<string, unknown>,
  retryable?: boolean,
): Response {
  const body: RpcError = {
    ...(requestId === undefined ? {} : { requestId }),
    error: {
      code,
      retryable: retryable ?? retryableFor(code),
      ...(details === undefined ? {} : { details }),
    },
  };
  return Response.json(body, { status: httpStatusForErrorCode(code) });
}

export function rpcSuccessResponse<R>(requestId: string, result: R): Response {
  const body: RpcSuccess<R> = {
    requestId,
    result,
    serverTime: new Date().toISOString(),
  };
  return Response.json(body, { status: 200 });
}

export function failureResponse(requestId: string | undefined, error: RpcFailure): Response {
  return rpcErrorResponse(requestId, error.code, error.details, error.retryable);
}
