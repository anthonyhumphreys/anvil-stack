// Versioned RPC envelope, error codes, and HTTP status agreement.
//
// Per integration-contract section 5 the HTTP status and the error code must
// agree; domain push batches keep per-item outcomes inside a successful
// envelope instead. Error messages are sanitized plain text, never scripts.

import { PROTOCOL } from './version';

export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'conflict'
  | 'payload-too-large'
  | 'throttled'
  | 'unavailable'
  | 'malformed-request'
  | 'unsupported-version'
  | 'unsupported-operation'
  | 'reset-required'
  | 'receipt-expired'
  | 'epoch-mismatch'
  | 'not-found'
  | 'quota-exceeded'
  | 'stale-generation'
  | 'invalid-transition';

export interface RpcRequest<P = unknown> {
  protocol: typeof PROTOCOL;
  requestId: string;
  operation: string;
  params: P;
}

export interface RpcSuccess<R = unknown> {
  requestId: string;
  result: R;
  /** Server wall-clock time (ISO-8601) for skew-tolerant clients. */
  serverTime: string;
}

export interface RpcErrorBody {
  code: ErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

export interface RpcError {
  /** Absent only when the request itself could not be correlated. */
  requestId?: string;
  error: RpcErrorBody;
}

export type RpcResponse<R = unknown> = RpcSuccess<R> | RpcError;

export function isRpcError<R>(response: RpcResponse<R>): response is RpcError {
  return (response as RpcError).error !== undefined;
}

/**
 * HTTP status that must accompany each error code. Domain codes that ride
 * inside a successful push envelope (conflict, reset-required,
 * receipt-expired) map to 409 because a top-level occurrence is a
 * conditional conflict.
 */
export function httpStatusForErrorCode(code: ErrorCode): number {
  switch (code) {
    case 'unauthenticated':
      return 401;
    case 'forbidden':
      return 403;
    case 'conflict':
      return 409;
    case 'reset-required':
      return 409;
    case 'receipt-expired':
      return 409;
    case 'epoch-mismatch':
      return 409;
    case 'stale-generation':
      return 409;
    case 'invalid-transition':
      return 409;
    case 'payload-too-large':
      return 413;
    case 'quota-exceeded':
      return 413;
    case 'throttled':
      return 429;
    case 'unavailable':
      return 503;
    case 'malformed-request':
      return 400;
    case 'unsupported-version':
      return 400;
    case 'unsupported-operation':
      return 400;
    case 'not-found':
      return 404;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}
