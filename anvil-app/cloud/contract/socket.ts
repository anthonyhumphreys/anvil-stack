// WebSocket frame contract for the live channel.
//
// The socket only accelerates delivery: durable job reads and event cursors
// recover anything missed. Frames carry a versioned type plus a
// correlation/stream id; payloads are schema-bounded. No tokens appear in
// URLs; the device bearer travels in the authorization header.

import { ErrorCode } from './envelope';

export const SOCKET_FRAME_VERSION = 1;

export type SocketFrameType =
  | 'hello'
  | 'subscribe'
  | 'unsubscribe'
  | 'sync.invalidate'
  | 'worker.available'
  | 'job.available'
  | 'activity'
  | 'gap'
  | 'auth.expiring'
  | 'error';

export interface HelloFrame {
  type: 'hello';
  version: typeof SOCKET_FRAME_VERSION;
  id: string;
  enrollmentId: string;
  workerIncarnation?: string;
  profiles: string[];
}

export interface SubscribeFrame {
  type: 'subscribe';
  version: typeof SOCKET_FRAME_VERSION;
  id: string;
  /** Scope under observation, e.g. an attempt or job id. */
  scope: string;
  afterSequence?: number | null;
}

export interface UnsubscribeFrame {
  type: 'unsubscribe';
  version: typeof SOCKET_FRAME_VERSION;
  id: string;
  subscriptionId: string;
}

export interface SyncInvalidateFrame {
  type: 'sync.invalidate';
  version: typeof SOCKET_FRAME_VERSION;
  id: string;
  epoch: string;
  watermark: number;
}

export interface WorkerAvailableFrame {
  type: 'worker.available';
  version: typeof SOCKET_FRAME_VERSION;
  id: string;
  enrollmentId: string;
  incarnation: string;
}

export interface JobAvailableFrame {
  type: 'job.available';
  version: typeof SOCKET_FRAME_VERSION;
  id: string;
  jobId: string;
}

export interface ActivityPayload {
  kind: 'stdout' | 'stderr' | 'status';
  text: string;
  byteLength: number;
  truncated: boolean;
}

export interface ActivityFrame {
  type: 'activity';
  version: typeof SOCKET_FRAME_VERSION;
  id: string;
  attemptId: string;
  generation: number;
  streamId: string;
  sequence: number;
  payload: ActivityPayload;
}

export interface GapFrame {
  type: 'gap';
  version: typeof SOCKET_FRAME_VERSION;
  id: string;
  attemptId: string;
  streamId: string;
  fromSequence: number;
  toSequence: number;
}

export interface AuthExpiringFrame {
  type: 'auth.expiring';
  version: typeof SOCKET_FRAME_VERSION;
  id: string;
  expiresAt: string;
}

export interface SocketErrorFrame {
  type: 'error';
  version: typeof SOCKET_FRAME_VERSION;
  id: string;
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export type SocketFrame =
  | HelloFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | SyncInvalidateFrame
  | WorkerAvailableFrame
  | JobAvailableFrame
  | ActivityFrame
  | GapFrame
  | AuthExpiringFrame
  | SocketErrorFrame;
