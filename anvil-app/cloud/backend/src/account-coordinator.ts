import { DurableObject } from 'cloudflare:workers';

import type { SpikeAuth } from './auth';
import { parseSpikeAuth, parseVerifiedAuth } from './auth';
import { sha256Hex, utf8ByteLength } from './hash';
import { ACCOUNT_SCHEMA, SPIKE_INITIAL_EPOCH } from './schema';
import {
  failureResponse,
  isRecord,
  isRpcFailure,
  parseRpcRequest,
  retryableFor,
  RpcFailure,
  rpcErrorResponse,
  rpcSuccessResponse,
} from './rpc';
import type { ErrorCode } from '../../contract/envelope';
import {
  canonicalChangeHashInput,
  type PendingChange,
  type PushItemAccepted,
  type ScannedEntity,
  type SyncCursor,
  type SyncOperation,
  type SyncPullResult,
  type SyncPushItemResult,
  type SyncPushResult,
  type SyncScanBeginResult,
  type SyncScanFinishResult,
  type SyncScanPageResult,
  type SyncedChange,
} from '../../contract/sync';
import {
  SOCKET_FRAME_VERSION,
  type ActivityFrame,
  type ActivityPayload,
  type GapFrame,
  type JobAvailableFrame,
  type SocketErrorFrame,
  type SocketFrame,
  type SyncInvalidateFrame,
  type WorkerAvailableFrame,
} from '../../contract/socket';
import type { SyncAccountStats } from '../../contract/auth';
import {
  ATTEMPT_TRANSITIONS,
  canTransitionJob,
  type ApprovalDecideResult,
  type ApprovalGetResult,
  type ApprovalRecord,
  type ApprovalState,
  type AttemptReportResult,
  type AttemptRenewParams,
  type AttemptRenewResult,
  type AttemptRenewalRequest,
  type AttemptRenewalResult,
  type AttemptState,
  type CapabilityRequirements,
  type DurableEvent,
  type DurableEventKind,
  type EventPullResult,
  type ExecutionAttempt,
  type ExecutionManifest,
  type JobCancelResult,
  type JobClaimResult,
  type JobCreateParams,
  type JobCreateResult,
  type JobGetResult,
  type JobKind,
  type JobListResult,
  type JobState,
  type JobSummary,
  type RequestedTarget,
  type RetryPolicy,
} from '../../contract/jobs';
import {
  canTransitionArtifact,
  type ArtifactDescriptor,
  type ArtifactGetResult,
  type ArtifactListResult,
  type ArtifactManifest,
  type ArtifactReserveResult,
  type ArtifactState,
} from '../../contract/artifacts';
import {
  SAME_ACCOUNT_SOURCE,
  type DevicePolicy,
  type DevicePolicyPublishResult,
  type WorkerCapabilities,
  type WorkerCapabilitiesPublishResult,
  type WorkerConnectResult,
  type WorkerDescribeResult,
  type WorkerReplicaPublishParams,
  type WorkerReplicaPublishResult,
  type WorkerReplicaReadiness,
  type WorkerReplicaSummary,
} from '../../contract/workers';
import {
  SOCKET_SUBPROTOCOL,
  DEFAULT_LIMITS,
  LEASE_DURATION_MS,
  OBSERVER_INTEREST_MS,
  SNAPSHOT_LIFETIME_MS,
  USER_JOB_DEADLINE_MS,
  WORKER_LEASE_MS,
} from '../../contract/version';

/** One live observation subscription stored on the socket attachment. */
interface SocketSubscription {
  subscriptionId: string;
  /** A job id or attempt id within this account. */
  scope: string;
  /** Durable event cursor at subscribe time (replay starts after it). */
  afterSequence: number;
  /** Interest expiry; re-subscribing the same scope renews it. */
  expiresAt: number;
}

interface SocketAttachment {
  accountId: string;
  enrollmentId: string;
  subscriptions?: SocketSubscription[];
}

interface PreparedChange {
  change: PendingChange;
  payloadJson: string | null;
  entityBytes: number;
  computedHash: string;
}

interface SpikePushParams {
  changes: PendingChange[];
  epoch: string | undefined;
}

interface EnrollmentRow {
  high_water: number;
  account_id: string;
  [key: string]: string | number | null;
}

interface EntityRow {
  revision: number;
  operation: string;
  payload: string | null;
  schema_version: number;
  [key: string]: string | number | null;
}

interface ReceiptRow {
  content_hash: string;
  result: string;
  [key: string]: string | number | null;
}

interface ChangeRow {
  sequence: number;
  entity_type: string;
  entity_id: string;
  revision: number;
  operation: string;
  schema_version: number;
  payload: string | null;
  [key: string]: string | number | null;
}

interface MetaRow {
  value: string;
  [key: string]: string | number | null;
}

interface ScanRow {
  scan_id: string;
  watermark_start: number;
  epoch: string;
  created_at: number;
  done: number;
  entity_cursor: string | null;
  [key: string]: string | number | null;
}

interface ScanEntityRow {
  entity_type: string;
  entity_id: string;
  revision: number;
  schema_version: number;
  payload: string | null;
  [key: string]: string | number | null;
}

interface WorkerRow {
  enrollment_id: string;
  account_id: string;
  policy: string;
  incarnation: string | null;
  capabilities: string | null;
  connected_at: number | null;
  last_seen_at: number | null;
  lease_expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
  [key: string]: string | number | null;
}

interface WorkerReplicaRow {
  workspace_id: string;
  definition_revision: string;
  readiness: string;
  observed_at: string;
  [key: string]: string | number | null;
}

interface JobRow {
  job_id: string;
  account_id: string;
  source_enrollment_id: string;
  request_id: string;
  payload_hash: string;
  kind: string;
  requested_target: string;
  target_enrollment_id: string | null;
  placement_explanation: string | null;
  input_manifest: string;
  state: string;
  state_reason: string | null;
  queue_deadline: number;
  retry_policy: string;
  retried: number;
  next_fence: number;
  active_attempt_id: string | null;
  created_at: number;
  updated_at: number;
  [key: string]: string | number | null;
}

interface AttemptRow {
  attempt_id: string;
  job_id: string;
  worker_enrollment_id: string;
  worker_incarnation: string;
  fence: number;
  state: string;
  lease_expires_at: number;
  outcome: string | null;
  result: string | null;
  error: string | null;
  late_result: string | null;
  created_at: number;
  updated_at: number;
  [key: string]: string | number | null;
}

interface PushBatchOutcome {
  results: SyncPushItemResult[];
  acceptedWatermark: number | null;
}

interface EventRow {
  job_id: string;
  event_seq: number;
  attempt_id: string;
  stream_id: string;
  sequence: number;
  kind: string;
  durable: number;
  generation: number;
  payload: string;
  covers_through: number;
  created_at: number;
  [key: string]: string | number | null;
}

interface JobEventMetaRow {
  job_id: string;
  next_event_seq: number;
  activity_bytes: number;
  [key: string]: string | number | null;
}

interface ApprovalRow {
  approval_id: string;
  account_id: string;
  job_id: string;
  attempt_id: string;
  action_digest: string;
  generation: number;
  approver_enrollment_id: string | null;
  approver_role: string;
  state: string;
  decided_by: string | null;
  decided_at: number | null;
  expires_at: number;
  created_at: number;
  [key: string]: string | number | null;
}

interface ArtifactRow {
  artifact_id: string;
  account_id: string;
  job_id: string;
  attempt_id: string;
  byte_length: number;
  sha256: string;
  media_type: string;
  retention_days: number;
  state: string;
  r2_key: string;
  upload_expires_at: number;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  expires_at: number | null;
  deleted_at: number | null;
  [key: string]: string | number | null;
}

/**
 * A socket frame derived from a journaled event row, queued inside the
 * running transaction and delivered to subscribers only after commit.
 * `durable` frames (everything except `activity`) are never coalesced and
 * never silently dropped. `attemptId` is '' on job-scope rows.
 */
interface DeliverableFrame {
  jobId: string;
  attemptId: string;
  frame: SocketFrame;
  durable: boolean;
}

/** Per-socket delivery state for coalescing + backpressure (in-memory only). */
interface PendingDelivery {
  /** Replaceable activity frames keyed `attemptId|streamId|payloadKind`. */
  coalesced: Map<string, { frame: ActivityFrame; firstSequence: number }>;
  /** Socket send failed: stream ranges missed since become gap frames. */
  lagging: boolean;
  missed: Map<string, { attemptId: string; streamId: string; from: number; to: number }>;
  /** Durable frames held while lagging (bounded, never dropped silently). */
  durableBacklog: SocketFrame[];
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Retained sync history lifetime (spec §5: changes, tombstones, receipts). */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Bounded compaction batch per sweep pass — spec §5 requires bounded work. */
const SWEEP_BATCH_ROWS = 500;
/** Regular sweep cadence; each pass reschedules the next. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Quick follow-up while a bounded pass still has expired rows left. */
const SWEEP_CONTINUE_MS = 1_000;
/** Per-account retained-history budget enforced before accepting changes. */
const HISTORY_QUOTA_BYTES = 64 * 1024 * 1024;
/** MESH-01: revoked worker records (+ replicas) are kept this long for audit. */
const WORKER_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Bounds for worker metadata payloads — metadata only, never bulk content. */
const MAX_ID_FIELD_LENGTH = 128;
const MAX_POLICY_SOURCES = 100;
const MAX_CAPABILITY_ENTRIES = 64;
const MAX_REPLICAS_PER_PUBLISH = 256;
const MAX_CONCURRENT_JOBS = 64;
/** MESH-02 bounds: metadata-only payloads, never bulk content. */
const MAX_MANIFEST_REPOSITORIES = 64;
const MAX_MANIFEST_CONFIG_ENTRIES = 64;
const MAX_JOB_INPUTS_BYTES = 32 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_REPORT_RESULT_BYTES = 64 * 1024;
const MAX_REPORT_ERROR_LENGTH = 4096;
const MAX_ATTEMPT_RENEWALS = 64;
const MAX_JOB_LIST_LIMIT = 100;
const DEFAULT_JOB_LIST_LIMIT = 50;
/** Explicit queue deadlines may reach at most this far out (spec bound: ~24h). */
const MAX_QUEUE_DEADLINE_HORIZON_MS = 24 * 60 * 60 * 1000;
/** Grace beyond attempt-lease expiry before the sweep marks unknown-outcome. */
const ATTEMPT_UNKNOWN_GRACE_MS = LEASE_DURATION_MS;

// ---- MESH-03 constants ----------------------------------------------------
/** Raw inbound socket frame cap; payload text is separately bounded below. */
const MAX_SOCKET_FRAME_BYTES = 32 * 1024;
/** Activity `payload.text` cap (contract liveFrameBytes). */
const MAX_ACTIVITY_TEXT_BYTES = DEFAULT_LIMITS.liveFrameBytes;
const MAX_STREAM_ID_LENGTH = 64;
/**
 * Backend-owned stream ids. `lifecycle` carries job/attempt/approval/artifact
 * status text; `control` is the worker→backend request channel (the
 * approval-request path). Worker `activity` frames may not claim either.
 */
const LIFECYCLE_STREAM_ID = 'lifecycle';
const CONTROL_STREAM_ID = 'control';
const MAX_SUBSCRIPTIONS_PER_SOCKET = 8;
/**
 * Per-job durable-journal budget for intermediate (non-durable) metadata —
 * spec §10: 1 MiB. Activity rows past the budget still allocate a durable
 * cursor but materialize as `gap` rows; lifecycle kinds never gate.
 */
const JOB_EVENT_BUDGET_BYTES = 1024 * 1024;
const EVENT_PULL_DEFAULT_LIMIT = 100;
const EVENT_PULL_MAX_LIMIT = 256;
/** Bounded replay on (re)subscribe; deeper history goes through event.pull. */
const SUBSCRIBE_REPLAY_READ = 512;
const SUBSCRIBE_REPLAY_SEND = 128;
/** Coalescing window for replaceable stdout/stderr (spec §10: 100–250ms). */
const ACTIVITY_COALESCE_MS = 150;
/** Cap on one coalesced payload before it flushes early. */
const MAX_COALESCED_TEXT_BYTES = 64 * 1024;
/** Per-account socket-ingest burst ceilings (spec §10 byte/message caps). */
const SOCKET_WINDOW_MS = 1_000;
const SOCKET_MAX_MESSAGES = 64;
const SOCKET_MAX_ACTIVITY_BYTES = 256 * 1024;
/** Durable frames held for a lagging observer before it is dropped. */
const OBSERVER_DURABLE_BACKLOG_MAX = 64;
/** Durable approval lifetime bounds (spec §10: expiring durable request). */
const APPROVAL_DEFAULT_TTL_MS = 10 * 60 * 1000;
const APPROVAL_MIN_TTL_MS = 1_000;
const APPROVAL_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTION_DIGEST_LENGTH = 256;
const MAX_APPROVAL_REASON_LENGTH = 1024;
/** MESH-03 artifact quotas + retention bounds (spec §10). */
const ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const ACCOUNT_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
const ARTIFACT_UPLOAD_TTL_MS = 10 * 60 * 1000;
const ARTIFACT_DEFAULT_RETENTION_DAYS = 7;
const ARTIFACT_MAX_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Terminal artifact rows are kept this long for audit before row purge. */
const ARTIFACT_AUDIT_RETENTION_MS = 30 * DAY_MS;
const MAX_ARTIFACT_LIST_LIMIT = 100;
const DEFAULT_ARTIFACT_LIST_LIMIT = 50;
const MAX_MEDIA_TYPE_LENGTH = 128;
/** Media types served verbatim on artifact download; others fall back. */
const SAFE_DOWNLOAD_MEDIA_TYPES = new Set([
  'text/plain',
  'application/json',
  'application/octet-stream',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/x-ndjson',
]);

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value['accountId'] === 'string' && typeof value['enrollmentId'] === 'string';
}

function isSyncOperation(value: unknown): value is SyncOperation {
  return value === 'create' || value === 'update' || value === 'delete';
}

function parseStoredResult(raw: string): SyncPushItemResult {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed['status'] !== 'string') {
    throw new RpcFailure('unavailable', { reason: 'corrupt-receipt' });
  }
  return parsed as unknown as SyncPushItemResult;
}

function parseRemoteContent(payload: string | null): unknown {
  if (payload === null) {
    return null;
  }
  return JSON.parse(payload) as unknown;
}

/**
 * Account-scoped SQLite coordinator. Constructor only ensures schema so
 * hibernation wake-ups stay cheap; identity lives on WebSocket attachments
 * and all durable state lives in SQL.
 */
export class AccountCoordinator extends DurableObject<Env> {
  /**
   * MESH-03: socket frames queued by the currently-running `commit()`
   * transaction for post-commit subscriber delivery. Sliced out after a
   * successful commit and truncated on rollback, so observers never see
   * uncommitted events.
   */
  private eventOutbox: DeliverableFrame[] = [];
  /**
   * MESH-03: R2 object keys queued inside `commit()` for post-commit
   * deletion — SQL and R2 are never atomic, so a rolled-back row must never
   * lose its bytes. Drained via ctx.waitUntil after commit.
   */
  private pendingR2Deletes: string[] = [];
  /**
   * MESH-03: per-socket live-delivery state (coalescing + backpressure).
   * In-memory only: hibernation drops pending replaceable frames, which the
   * durable journal and gap semantics recover.
   */
  private deliveries = new Map<WebSocket, PendingDelivery>();
  private flushTimerPending = false;
  private flushDueAt = 0;
  /** MESH-03: per-account socket-ingest rate window (in-memory burst cap). */
  private socketWindow = { start: 0, messages: 0, bytes: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(ACCOUNT_SCHEMA);
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO sync_meta (key, value) VALUES (?, ?)',
      'epoch',
      SPIKE_INITIAL_EPOCH,
    );
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO sync_meta (key, value) VALUES (?, ?)',
      'next_sequence',
      '1',
    );
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO sync_meta (key, value) VALUES (?, ?)',
      'retention_floor',
      '0',
    );
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO sync_meta (key, value) VALUES (?, ?)',
      'history_bytes',
      '0',
    );
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/internal/meta' && request.method === 'GET') {
      // Worker-internal read: the SessionCoordinator resolves the dataset
      // epoch for enroll/refresh/describe responses, and merges these
      // aggregate counters into session.describe for diagnostics.
      return Response.json({ epoch: this.readMeta('epoch'), stats: this.accountStats() });
    }
    if (url.pathname === '/internal/sweep' && request.method === 'POST') {
      // Worker-internal retention pass (also driven by the DO alarm); the
      // worker never routes this externally.
      const stats = await this.runSweep(Date.now());
      return Response.json(stats);
    }
    if (url.pathname === '/internal/revoke-enrollment' && request.method === 'POST') {
      // Worker-internal: close every socket attached to a revoked enrollment,
      // and (MESH-01) mark its worker record revoked so worker.* ops reject
      // until the device re-publishes a local policy (a fresh opt-in).
      const body = (await request.json().catch(() => null)) as {
        enrollmentId?: unknown;
      } | null;
      if (body === null || typeof body.enrollmentId !== 'string') {
        return rpcErrorResponse(undefined, 'malformed-request');
      }
      let closed = 0;
      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment();
        if (isSocketAttachment(attachment) && attachment.enrollmentId === body.enrollmentId) {
          ws.close(1008, 'session revoked');
          closed += 1;
        }
      }
      const workerRevoked =
        this.ctx.storage.sql.exec(
          'UPDATE workers SET revoked_at = ? WHERE enrollment_id = ? AND revoked_at IS NULL',
          Date.now(),
          body.enrollmentId,
        ).rowsWritten > 0;
      return Response.json({ closed, workerRevoked });
    }
    // MESH-03 artifact byte routes: PUT uploads into a reservation, GET
    // downloads a published artifact. Bytes stream to/from R2 — never
    // buffered whole and never inside an RPC envelope.
    const artifactMatch = /^\/v1\/artifacts\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (artifactMatch !== null) {
      const artifactId = artifactMatch[1] as string;
      if (request.method === 'PUT') {
        return this.handleArtifactUpload(request, artifactId);
      }
      if (request.method === 'GET') {
        return this.handleArtifactDownload(request, artifactId);
      }
      return rpcErrorResponse(undefined, 'malformed-request');
    }
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.acceptClient(request);
    }
    if (request.method === 'POST') {
      return this.handleRpc(request);
    }
    return rpcErrorResponse(undefined, 'malformed-request');
  }

  /**
   * Request identity: prefer the worker-verified internal headers, fall back
   * to the spike bearer (which the worker only accepts under ANVIL_DEV_SPIKE).
   */
  private identityOf(request: Request): SpikeAuth | null {
    return parseVerifiedAuth(request) ?? parseSpikeAuth(request.headers.get('Authorization'));
  }

  /**
   * MESH-03 inbound socket protocol. Frames are versioned JSON text with a
   * hard byte cap. `subscribe`/`unsubscribe` manage per-socket observation
   * scopes on the attachment (renewed by re-subscribe, expiring per
   * OBSERVER_INTEREST_MS); `activity` ingests fenced worker frames into the
   * durable journal and fans them out to interested observers.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment();
    if (!isSocketAttachment(attachment)) {
      ws.close(1008, 'unauthenticated');
      return;
    }
    if (typeof message !== 'string') {
      this.sendSocketError(ws, null, 'malformed-request', 'socket frames are JSON text');
      return;
    }
    if (utf8ByteLength(message) > MAX_SOCKET_FRAME_BYTES) {
      this.sendSocketError(ws, null, 'payload-too-large', 'frame exceeds socket limit');
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      this.sendSocketError(ws, null, 'malformed-request', 'invalid JSON');
      return;
    }
    if (!isRecord(frame) || frame['version'] !== SOCKET_FRAME_VERSION) {
      this.sendSocketError(ws, null, 'unsupported-version', 'unsupported frame version');
      return;
    }
    const frameId = isBoundedId(frame['id']) ? frame['id'] : null;
    try {
      this.assertSocketRate(0, true);
      switch (frame['type']) {
        case 'subscribe':
          this.handleSubscribeFrame(ws, attachment, frame);
          return;
        case 'unsubscribe':
          this.handleUnsubscribeFrame(ws, attachment, frame);
          return;
        case 'activity':
          this.handleActivityFrame(ws, attachment, frame);
          return;
        default:
          this.sendSocketError(ws, frameId, 'unsupported-operation', 'unsupported frame type');
          return;
      }
    } catch (error) {
      if (isRpcFailure(error)) {
        this.sendSocketError(ws, frameId, error.code, socketErrorMessage(error));
        return;
      }
      this.sendSocketError(ws, frameId, 'unavailable', 'internal error');
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.deliveries.delete(ws);
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.deliveries.delete(ws);
    try {
      ws.close(1011, 'socket error');
    } catch {
      // already closed
    }
  }

  private sendSocketError(
    ws: WebSocket,
    id: string | null,
    code: ErrorCode,
    message: string,
  ): void {
    const frame: SocketErrorFrame = {
      type: 'error',
      version: SOCKET_FRAME_VERSION,
      id: id ?? crypto.randomUUID(),
      code,
      message,
      retryable: retryableFor(code),
    };
    this.trySend(ws, frame);
  }

  private trySend(ws: WebSocket, frame: SocketFrame): boolean {
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Per-account inbound burst ceiling: bounded messages/window for every
   * frame, plus a byte/window ceiling on activity payloads. Throttling is a
   * typed, retryable socket error — never a silent drop.
   */
  private assertSocketRate(activityBytes: number, countMessage: boolean): void {
    const now = Date.now();
    if (now - this.socketWindow.start >= SOCKET_WINDOW_MS) {
      this.socketWindow = { start: now, messages: 0, bytes: 0 };
    }
    if (countMessage) {
      this.socketWindow.messages += 1;
    }
    this.socketWindow.bytes += activityBytes;
    if (
      this.socketWindow.messages > SOCKET_MAX_MESSAGES ||
      this.socketWindow.bytes > SOCKET_MAX_ACTIVITY_BYTES
    ) {
      throw new RpcFailure('throttled', { reason: 'socket-rate' });
    }
  }

  /**
   * `subscribe`: resolves the scope (a job id or attempt id) inside this
   * account, records/renews the subscription on the attachment, then replays
   * journaled events after the durable cursor — gap frames first when the
   * cursor sits inside a dropped range or history exceeds the replay window.
   */
  private handleSubscribeFrame(
    ws: WebSocket,
    attachment: SocketAttachment,
    frame: Record<string, unknown>,
  ): void {
    const id = frame['id'];
    const scope = frame['scope'];
    const afterRaw = frame['afterSequence'];
    if (!isBoundedId(id)) {
      throw new RpcFailure('malformed-request', { reason: 'id' });
    }
    if (!isBoundedId(scope)) {
      throw new RpcFailure('malformed-request', { reason: 'scope' });
    }
    let after = 0;
    if (afterRaw !== undefined && afterRaw !== null) {
      if (typeof afterRaw !== 'number' || !Number.isSafeInteger(afterRaw) || afterRaw < 0) {
        throw new RpcFailure('malformed-request', { reason: 'afterSequence' });
      }
      after = afterRaw;
    }
    const resolved = this.resolveEventScope(scope, attachment.accountId);
    const now = Date.now();
    let subs = attachmentSubscriptions(attachment).filter((s) => s.expiresAt > now);
    const existing = subs.findIndex((s) => s.scope === scope);
    const record: SocketSubscription = {
      subscriptionId: id,
      scope,
      afterSequence: after,
      expiresAt: now + OBSERVER_INTEREST_MS,
    };
    if (existing >= 0) {
      subs[existing] = record;
    } else {
      if (subs.length >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
        throw new RpcFailure('quota-exceeded', {
          reason: 'subscriptions',
          limit: MAX_SUBSCRIPTIONS_PER_SOCKET,
        });
      }
      subs.push(record);
    }
    attachment.subscriptions = subs;
    ws.serializeAttachment(attachment);
    this.bumpCounter('socket_subscribes', 1);
    this.replaySubscription(ws, resolved.jobId, resolved.attemptId, after);
  }

  private handleUnsubscribeFrame(
    ws: WebSocket,
    attachment: SocketAttachment,
    frame: Record<string, unknown>,
  ): void {
    const subscriptionId = frame['subscriptionId'];
    if (!isBoundedId(subscriptionId)) {
      throw new RpcFailure('malformed-request', { reason: 'subscriptionId' });
    }
    const now = Date.now();
    const subs = attachmentSubscriptions(attachment).filter(
      (s) => s.expiresAt > now && s.subscriptionId !== subscriptionId,
    );
    attachment.subscriptions = subs;
    ws.serializeAttachment(attachment);
    this.bumpCounter('socket_unsubscribes', 1);
  }

  /**
   * `activity`: a worker's fenced stream frame. The socket's enrollment must
   * own the attempt under its current live incarnation and the frame's
   * `generation` must equal the attempt fence. `control` is a reserved
   * backend channel (approval requests); ordinary streams journal under the
   * per-job budget and fan out to subscribers, coalescing under backpressure.
   */
  private handleActivityFrame(
    ws: WebSocket,
    attachment: SocketAttachment,
    frame: Record<string, unknown>,
  ): void {
    const attemptId = frame['attemptId'];
    const streamId = frame['streamId'];
    const generation = frame['generation'];
    const sequence = frame['sequence'];
    const payload = parseActivityPayload(frame['payload']);
    if (!isBoundedId(attemptId)) {
      throw new RpcFailure('malformed-request', { reason: 'attemptId' });
    }
    if (
      typeof streamId !== 'string' ||
      streamId.length === 0 ||
      streamId.length > MAX_STREAM_ID_LENGTH
    ) {
      throw new RpcFailure('malformed-request', { reason: 'streamId' });
    }
    if (
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      throw new RpcFailure('malformed-request', { reason: 'generation' });
    }
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) {
      throw new RpcFailure('malformed-request', { reason: 'sequence' });
    }
    this.assertSocketRate(utf8ByteLength(payload.text), false);
    const now = Date.now();
    const outcome = this.commit((): SocketFrame | null => {
      const attempt = this.readAttempt(attemptId);
      if (attempt === null) {
        throw new RpcFailure('not-found', { reason: 'attempt' });
      }
      const job = this.readJobRequired(attempt.job_id);
      if (job.account_id !== attachment.accountId) {
        throw new RpcFailure('forbidden', { reason: 'wrong-account' });
      }
      if (attempt.worker_enrollment_id !== attachment.enrollmentId) {
        throw new RpcFailure('forbidden', { reason: 'not-attempt-owner' });
      }
      const worker = this.readWorker(attachment.enrollmentId);
      if (worker === null || worker.revoked_at !== null) {
        throw new RpcFailure('forbidden', { reason: 'worker-revoked' });
      }
      if (
        worker.incarnation === null ||
        worker.incarnation !== attempt.worker_incarnation ||
        !isLeaseLive(worker, now)
      ) {
        throw new RpcFailure('forbidden', { reason: 'stale-incarnation' });
      }
      if (attempt.fence !== generation) {
        throw new RpcFailure('stale-generation', {
          expected: attempt.fence,
          actual: generation,
        });
      }
      if (!isActiveAttemptState(attempt.state)) {
        throw new RpcFailure('conflict', { reason: 'attempt-terminal' });
      }
      if (streamId === CONTROL_STREAM_ID) {
        return this.handleControlMessage(attachment, attempt, job, payload);
      }
      if (streamId === LIFECYCLE_STREAM_ID) {
        throw new RpcFailure('forbidden', { reason: 'reserved-stream' });
      }
      this.journalActivityEvent({
        jobId: job.job_id,
        attemptId,
        streamId,
        sequence,
        generation,
        payload,
      });
      this.bumpCounter('socket_activity', 1);
      return null;
    });
    // The commit already flushed queued frames to subscribers; a control
    // request additionally acks the requesting socket directly.
    if (outcome !== null) {
      this.trySend(ws, outcome);
    }
  }

  /**
   * Worker→backend control channel (`streamId: 'control'`, status payload
   * carrying a JSON request document). v1 handles `{request:'approval'}`: an
   * expiring durable approval bound to the attempt, its action digest, and
   * the current fence; the job moves to `awaiting-approval`. Returns the ack
   * frame for the requesting socket.
   */
  private handleControlMessage(
    attachment: SocketAttachment,
    attempt: AttemptRow,
    job: JobRow,
    payload: ActivityPayload,
  ): SocketFrame {
    if (payload.kind !== 'status') {
      throw new RpcFailure('malformed-request', { reason: 'control-kind' });
    }
    let doc: unknown;
    try {
      doc = JSON.parse(payload.text);
    } catch {
      throw new RpcFailure('malformed-request', { reason: 'control-json' });
    }
    if (!isRecord(doc) || doc['request'] !== 'approval') {
      throw new RpcFailure('malformed-request', { reason: 'control-request' });
    }
    const actionDigest = doc['actionDigest'];
    if (
      typeof actionDigest !== 'string' ||
      actionDigest.length === 0 ||
      actionDigest.length > MAX_ACTION_DIGEST_LENGTH
    ) {
      throw new RpcFailure('malformed-request', { reason: 'actionDigest' });
    }
    const approverRaw = doc['approverEnrollmentId'];
    if (approverRaw !== undefined && approverRaw !== null && !isBoundedId(approverRaw)) {
      throw new RpcFailure('malformed-request', { reason: 'approverEnrollmentId' });
    }
    const approverEnrollmentId = approverRaw === undefined ? null : (approverRaw as string | null);
    if (approverEnrollmentId !== null && approverEnrollmentId === attachment.enrollmentId) {
      // A worker may never pin itself as its own approver.
      throw new RpcFailure('conflict', { reason: 'invalid-approver' });
    }
    const ttlRaw = doc['expiresInMs'];
    let ttl = APPROVAL_DEFAULT_TTL_MS;
    if (ttlRaw !== undefined && ttlRaw !== null) {
      if (typeof ttlRaw !== 'number' || !Number.isFinite(ttlRaw)) {
        throw new RpcFailure('malformed-request', { reason: 'expiresInMs' });
      }
      if (ttlRaw < APPROVAL_MIN_TTL_MS || ttlRaw > APPROVAL_MAX_TTL_MS) {
        throw new RpcFailure('malformed-request', { reason: 'expiresInMs' });
      }
      ttl = Math.floor(ttlRaw);
    }
    const now = Date.now();
    if (job.state !== 'running') {
      throw new RpcFailure('conflict', { reason: 'job-not-running', state: job.state });
    }
    const pending = this.readPendingApproval(attempt.attempt_id);
    if (pending !== null) {
      if (pending.action_digest === actionDigest) {
        // Idempotent re-request: renews nothing, re-acks the same approval.
        return this.statusAck(attempt, 'approval.requested', {
          approvalId: pending.approval_id,
          actionDigest: pending.action_digest,
          deduplicated: true,
          expiresAt: new Date(pending.expires_at).toISOString(),
        });
      }
      throw new RpcFailure('conflict', { reason: 'approval-pending' });
    }
    const approvalId = crypto.randomUUID();
    const expiresAt = now + ttl;
    this.ctx.storage.sql.exec(
      `INSERT INTO approvals (
         approval_id, account_id, job_id, attempt_id, action_digest, generation,
         approver_enrollment_id, approver_role, state, decided_by, decided_at,
         expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 'pending', NULL, NULL, ?, ?)`,
      approvalId,
      job.account_id,
      job.job_id,
      attempt.attempt_id,
      actionDigest,
      attempt.fence,
      approverEnrollmentId,
      expiresAt,
      now,
    );
    this.setJobState(job, 'awaiting-approval', now, { stateReason: 'approval-required' });
    this.journalDurableEvent({
      jobId: job.job_id,
      attemptId: attempt.attempt_id,
      generation: attempt.fence,
      kind: 'approval.requested',
      payload: {
        approvalId,
        actionDigest,
        ...(approverEnrollmentId === null ? {} : { approverEnrollmentId }),
        expiresAt: new Date(expiresAt).toISOString(),
      },
    });
    this.bumpCounter('approval_requests', 1);
    return this.statusAck(attempt, 'approval.requested', {
      approvalId,
      actionDigest,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  /** Synthesized status frame acking a control request on its own socket. */
  private statusAck(
    attempt: AttemptRow,
    type: string,
    detail: Record<string, unknown>,
  ): ActivityFrame {
    const text = JSON.stringify({ type, ...detail });
    return {
      type: 'activity',
      version: SOCKET_FRAME_VERSION,
      id: crypto.randomUUID(),
      attemptId: attempt.attempt_id,
      generation: attempt.fence,
      streamId: CONTROL_STREAM_ID,
      sequence: 0,
      payload: { kind: 'status', text, byteLength: utf8ByteLength(text), truncated: false },
    };
  }

  private acceptClient(request: Request): Response {
    const auth = this.identityOf(request);
    if (auth === null) {
      return rpcErrorResponse(undefined, 'unauthenticated');
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const attachment: SocketAttachment = {
      accountId: auth.accountId,
      enrollmentId: auth.enrollmentId,
    };
    pair[1].serializeAttachment(attachment);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { 'Sec-WebSocket-Protocol': SOCKET_SUBPROTOCOL },
    });
  }

  private async handleRpc(request: Request): Promise<Response> {
    const auth = this.identityOf(request);
    if (auth === null) {
      return rpcErrorResponse(undefined, 'unauthenticated');
    }
    let parsed: unknown;
    try {
      parsed = (await request.json()) as unknown;
    } catch {
      return rpcErrorResponse(undefined, 'malformed-request');
    }
    const envelope = parseRpcRequest(parsed);
    if (!envelope.ok) {
      return rpcErrorResponse(envelope.requestId, envelope.code);
    }
    const { request: rpc } = envelope;
    try {
      switch (rpc.operation) {
        case 'sync.push':
          return await this.handlePush(auth, rpc.requestId, rpc.params);
        case 'sync.pull':
          return this.handlePull(rpc.requestId, rpc.params);
        case 'sync.scan.begin':
          return this.handleScanBegin(rpc.requestId, rpc.params);
        case 'sync.scan.page':
          return this.handleScanPage(rpc.requestId, rpc.params);
        case 'sync.scan.finish':
          return this.handleScanFinish(rpc.requestId, rpc.params);
        case 'device.policy.publish':
          return this.handleDevicePolicyPublish(auth, rpc.requestId, rpc.params);
        case 'worker.connect':
          return await this.handleWorkerConnect(auth, rpc.requestId);
        case 'worker.describe':
          return this.handleWorkerDescribe(auth, rpc.requestId);
        case 'worker.capabilities.publish':
          return this.handleWorkerCapabilitiesPublish(auth, rpc.requestId, rpc.params);
        case 'worker.replica.publish':
          return this.handleWorkerReplicaPublish(auth, rpc.requestId, rpc.params);
        // MESH-02 job/attempt lifecycle. job.get/job.list/job.cancel are
        // account-scoped reads/idempotent intents; claim/renew/report carry
        // the worker's fail-closed policy gate.
        case 'job.create':
          return await this.handleJobCreate(auth, rpc.requestId, rpc.params);
        case 'job.get':
          return this.handleJobGet(rpc.requestId, rpc.params);
        case 'job.list':
          return this.handleJobList(rpc.requestId, rpc.params);
        case 'job.claim':
          return await this.handleJobClaim(auth, rpc.requestId, rpc.params);
        case 'attempt.renew':
          return this.handleAttemptRenew(auth, rpc.requestId, rpc.params);
        case 'attempt.report':
          return await this.handleAttemptReport(auth, rpc.requestId, rpc.params);
        case 'job.cancel':
          return this.handleJobCancel(rpc.requestId, rpc.params);
        // MESH-03: durable events, expiring approvals, artifact manifests.
        // Artifact bytes move on the PUT/GET /v1/artifacts routes instead.
        case 'event.pull':
          return this.handleEventPull(auth, rpc.requestId, rpc.params);
        case 'approval.get':
          return this.handleApprovalGet(auth, rpc.requestId, rpc.params);
        case 'approval.decide':
          return this.handleApprovalDecide(auth, rpc.requestId, rpc.params);
        case 'artifact.reserve':
          return this.handleArtifactReserve(auth, rpc.requestId, rpc.params);
        case 'artifact.finalize':
          return await this.handleArtifactFinalize(auth, rpc.requestId, rpc.params);
        case 'artifact.get':
          return this.handleArtifactGet(auth, rpc.requestId, rpc.params);
        case 'artifact.list':
          return this.handleArtifactList(auth, rpc.requestId, rpc.params);
        case 'artifact.delete':
          return await this.handleArtifactDelete(auth, rpc.requestId, rpc.params);
        default:
          return rpcErrorResponse(rpc.requestId, 'unsupported-operation');
      }
    } catch (error) {
      if (isRpcFailure(error)) {
        return failureResponse(rpc.requestId, error);
      }
      return rpcErrorResponse(rpc.requestId, 'unavailable');
    }
  }

  private async handlePush(
    auth: SpikeAuth,
    requestId: string,
    params: unknown,
  ): Promise<Response> {
    const push = parseSpikePushParams(params);
    const prepared: PreparedChange[] = [];
    for (const change of push.changes) {
      const payloadJson = change.operation === 'delete' ? null : JSON.stringify(change.payload);
      const entityBytes = payloadJson === null ? 0 : utf8ByteLength(payloadJson);
      const computedHash = await sha256Hex(canonicalChangeHashInput(change));
      prepared.push({ change, payloadJson, entityBytes, computedHash });
    }

    let outcome: PushBatchOutcome;
    try {
      outcome = this.commit(() =>
        this.pushInTransaction(auth, push.epoch, prepared),
      );
    } catch (error) {
      if (isRpcFailure(error)) {
        return failureResponse(requestId, error);
      }
      throw error;
    }

    if (outcome.acceptedWatermark !== null) {
      this.broadcastInvalidate(outcome.acceptedWatermark);
    }
    await this.ensureSweepScheduled();
    const result: SyncPushResult = { results: outcome.results };
    return rpcSuccessResponse(requestId, result);
  }

  private pushInTransaction(
    auth: SpikeAuth,
    epoch: string | undefined,
    prepared: PreparedChange[],
  ): PushBatchOutcome {
    this.provisionEnrollment(auth);
    this.assertBatchStructure(prepared);

    const storedEpoch = this.readMeta('epoch');
    if (epoch !== undefined && epoch !== storedEpoch) {
      throw new RpcFailure('epoch-mismatch', { expected: storedEpoch, actual: epoch });
    }

    const results: SyncPushItemResult[] = [];
    let acceptedWatermark: number | null = null;
    for (const item of prepared) {
      let result: SyncPushItemResult;
      if (storedEpoch !== SPIKE_INITIAL_EPOCH) {
        result = {
          status: 'reset-required',
          changeId: item.change.changeId,
          epoch: storedEpoch,
        };
        this.writeReceipt(auth.enrollmentId, item, result);
        this.advanceHighWater(auth.enrollmentId, item.change.enrollmentSequence);
      } else {
        const applied = this.applyPrepared(auth, item);
        result = applied.item;
        if (applied.acceptedSequence !== null) {
          acceptedWatermark = applied.acceptedSequence;
          this.bumpCounter('bytes_accepted', item.entityBytes);
        }
      }
      this.bumpCounter(`push_${result.status}`, 1);
      results.push(result);
    }
    return { results, acceptedWatermark };
  }

  private assertBatchStructure(prepared: PreparedChange[]): void {
    if (prepared.length > DEFAULT_LIMITS.batchChanges) {
      throw new RpcFailure('payload-too-large', {
        limit: DEFAULT_LIMITS.batchChanges,
        actual: prepared.length,
      });
    }
    let totalBytes = 0;
    for (const item of prepared) {
      assertPendingChange(item.change);
      if (item.computedHash !== item.change.payloadHash) {
        throw new RpcFailure('malformed-request', {
          reason: 'payload-hash-mismatch',
          changeId: item.change.changeId,
        });
      }
      if (item.entityBytes > DEFAULT_LIMITS.entityBytes) {
        throw new RpcFailure('payload-too-large', {
          limitBytes: DEFAULT_LIMITS.entityBytes,
          actualBytes: item.entityBytes,
          entityType: item.change.entityType,
        });
      }
      totalBytes += item.entityBytes;
    }
    if (totalBytes > DEFAULT_LIMITS.pageBytes) {
      throw new RpcFailure('payload-too-large', {
        limitBytes: DEFAULT_LIMITS.pageBytes,
        actualBytes: totalBytes,
      });
    }
  }

  private applyPrepared(
    auth: SpikeAuth,
    item: PreparedChange,
  ): { item: SyncPushItemResult; acceptedSequence: number | null } {
    const { change } = item;
    const receipts = this.ctx.storage.sql
      .exec<ReceiptRow>(
        'SELECT content_hash, result FROM receipts WHERE enrollment_id = ? AND enrollment_sequence = ?',
        auth.enrollmentId,
        change.enrollmentSequence,
      )
      .toArray();
    if (receipts.length === 1) {
      const receipt = receipts[0];
      if (receipt.content_hash === change.payloadHash) {
        return { item: parseStoredResult(receipt.result), acceptedSequence: null };
      }
      return {
        item: { status: 'rejected', changeId: change.changeId, reason: 'changed-content' },
        acceptedSequence: null,
      };
    }

    const enrollment = this.readEnrollment(auth.enrollmentId);
    if (change.enrollmentSequence <= enrollment.high_water) {
      const expired: SyncPushItemResult = { status: 'receipt-expired', changeId: change.changeId };
      this.writeReceipt(auth.enrollmentId, item, expired);
      return { item: expired, acceptedSequence: null };
    }

    // History-byte quota is enforced before acceptance (spec §5): the change
    // is terminally rejected and consumes its sequence with a receipt; local
    // editing continues and the client can re-queue after retention frees
    // space. Recovery history is never silently discarded.
    if (this.readHistoryBytes() + item.entityBytes > HISTORY_QUOTA_BYTES) {
      const overQuota: SyncPushItemResult = {
        status: 'rejected',
        changeId: change.changeId,
        reason: 'quota-exceeded',
      };
      this.writeReceipt(auth.enrollmentId, item, overQuota);
      this.advanceHighWater(auth.enrollmentId, change.enrollmentSequence);
      return { item: overQuota, acceptedSequence: null };
    }

    const existing = this.readEntity(change.entityType, change.entityId);
    const compared = compareBaseRevision(change, existing);
    if (compared !== null) {
      this.writeReceipt(auth.enrollmentId, item, compared);
      this.advanceHighWater(auth.enrollmentId, change.enrollmentSequence);
      return { item: compared, acceptedSequence: null };
    }

    const sequence = Number(this.readMeta('next_sequence'));
    const now = Date.now();
    const revision = existing === null ? 1 : existing.revision + 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO entities (
         entity_type, entity_id, revision, operation, schema_version, payload, sequence, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
         revision = excluded.revision,
         operation = excluded.operation,
         schema_version = excluded.schema_version,
         payload = excluded.payload,
         sequence = excluded.sequence,
         updated_at = excluded.updated_at`,
      change.entityType,
      change.entityId,
      revision,
      change.operation,
      change.schemaVersion,
      item.payloadJson,
      sequence,
      now,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO changes (
         sequence, entity_type, entity_id, revision, operation, schema_version, payload, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sequence,
      change.entityType,
      change.entityId,
      revision,
      change.operation,
      change.schemaVersion,
      item.payloadJson,
      now,
    );
    const accepted: PushItemAccepted = {
      status: 'accepted',
      changeId: change.changeId,
      revision,
      ...(change.operation === 'delete' ? {} : { content: change.payload }),
    };
    this.writeReceipt(auth.enrollmentId, item, accepted);
    this.ctx.storage.sql.exec(
      "UPDATE sync_meta SET value = ? WHERE key = 'next_sequence'",
      String(sequence + 1),
    );
    this.advanceHighWater(auth.enrollmentId, change.enrollmentSequence);
    this.addHistoryBytes(item.entityBytes);
    return { item: accepted, acceptedSequence: sequence };
  }

  private handlePull(requestId: string, params: unknown): Response {
    const pull = parseSpikePullParams(params);
    this.bumpCounter('pulls', 1);
    const after = pull.cursor;
    // A cursor below the retention floor can no longer be served faithfully:
    // the journal rows it would have consumed are gone, so the client must
    // reset and re-scan (spec §5 cursor-retention check).
    const floor = this.readRetentionFloor();
    if (after < floor) {
      throw new RpcFailure('reset-required', {
        reason: 'retention-floor',
        floor,
        cursor: after,
      });
    }
    const maxChanges = pull.maxChanges ?? DEFAULT_LIMITS.batchChanges;
    const maxBytes = Math.min(pull.maxBytes, DEFAULT_LIMITS.pageBytes);
    const rows = this.ctx.storage.sql
      .exec<ChangeRow>(
        `SELECT sequence, entity_type, entity_id, revision, operation, schema_version, payload
         FROM changes
         WHERE sequence > ?
         ORDER BY sequence ASC`,
        after,
      )
      .toArray();

    const changes: SyncedChange[] = [];
    let usedBytes = 0;
    let lastSequence = after;
    let remaining = false;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!isSyncOperation(row.operation)) {
        throw new RpcFailure('unavailable', { reason: 'corrupt-change-operation' });
      }
      const synced: SyncedChange = {
        entityType: row.entity_type,
        entityId: row.entity_id,
        revision: row.revision,
        operation: row.operation,
        schemaVersion: row.schema_version,
        sequence: row.sequence,
        ...(row.payload === null ? {} : { payload: JSON.parse(row.payload) as unknown }),
      };
      const encoded = JSON.stringify(synced);
      const size = utf8ByteLength(encoded);
      const wouldExceedBytes = changes.length > 0 && usedBytes + size > maxBytes;
      const wouldExceedCount = changes.length >= maxChanges;
      if (wouldExceedBytes || wouldExceedCount) {
        remaining = true;
        break;
      }
      changes.push(synced);
      usedBytes += size;
      lastSequence = row.sequence;
    }
    if (!remaining && changes.length < rows.length) {
      remaining = true;
    }
    const result: SyncPullResult = {
      changes,
      nextCursor: String(lastSequence) as SyncCursor,
      hasMore: remaining,
    };
    return rpcSuccessResponse(requestId, result);
  }

  private handleScanBegin(requestId: string, params: unknown): Response {
    const begin = parseScanBeginParams(params);
    this.bumpCounter('scan_begins', 1);
    const result = this.commit(() => this.beginScan(begin.epoch));
    return rpcSuccessResponse(requestId, result);
  }

  private beginScan(epoch: string | null | undefined): SyncScanBeginResult {
    const storedEpoch = this.readMeta('epoch');
    if (epoch !== undefined && epoch !== null && epoch !== storedEpoch) {
      throw new RpcFailure('epoch-mismatch', { expected: storedEpoch, actual: epoch });
    }
    const watermarkStart = this.currentWatermark();
    const floor = this.readRetentionFloor();
    if (watermarkStart < floor) {
      throw new RpcFailure('reset-required', {
        reason: 'retention-floor',
        floor,
        watermarkStart,
      });
    }
    const scanId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO scans (scan_id, watermark_start, epoch, created_at, done, entity_cursor)
       VALUES (?, ?, ?, ?, 0, NULL)`,
      scanId,
      watermarkStart,
      storedEpoch,
      Date.now(),
    );
    return {
      scanId,
      watermarkStart,
      resumeCursor: String(watermarkStart) as SyncCursor,
      epoch: storedEpoch,
    };
  }

  private handleScanPage(requestId: string, params: unknown): Response {
    const page = parseScanPageParams(params);
    const result = this.commit(() =>
      this.pageScan(page.scanId, page.cursor, page.maxBytes),
    );
    return rpcSuccessResponse(requestId, result);
  }

  private pageScan(
    scanId: string,
    cursor: string | null,
    requestedMaxBytes: number,
  ): SyncScanPageResult {
    const scan = this.loadScan(scanId);
    this.assertScanEpochAndRetention(scan);
    if (scan.done === 1) {
      return { entities: [], nextCursor: null, done: true };
    }
    const after = cursor === null ? null : decodeEntityCursor(cursor);
    const maxBytes = Math.min(requestedMaxBytes, DEFAULT_LIMITS.pageBytes);
    const rows =
      after === null
        ? this.ctx.storage.sql
            .exec<ScanEntityRow>(
              `SELECT entity_type, entity_id, revision, schema_version, payload
               FROM entities
               WHERE operation != 'delete'
               ORDER BY entity_type ASC, entity_id ASC`,
            )
            .toArray()
        : this.ctx.storage.sql
            .exec<ScanEntityRow>(
              `SELECT entity_type, entity_id, revision, schema_version, payload
               FROM entities
               WHERE operation != 'delete'
                 AND (entity_type > ? OR (entity_type = ? AND entity_id > ?))
               ORDER BY entity_type ASC, entity_id ASC`,
              after.entityType,
              after.entityType,
              after.entityId,
            )
            .toArray();

    const entities: ScannedEntity[] = [];
    let usedBytes = 0;
    let remaining = false;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const scanned: ScannedEntity = {
        entityType: row.entity_type,
        entityId: row.entity_id,
        revision: row.revision,
        schemaVersion: row.schema_version,
        payload: row.payload === null ? null : (JSON.parse(row.payload) as unknown),
      };
      const size = utf8ByteLength(JSON.stringify(scanned));
      const wouldExceedBytes = entities.length > 0 && usedBytes + size > maxBytes;
      if (wouldExceedBytes) {
        remaining = true;
        break;
      }
      entities.push(scanned);
      usedBytes += size;
    }
    if (!remaining && entities.length < rows.length) {
      remaining = true;
    }
    const last = entities[entities.length - 1];
    const entityCursor =
      last === undefined ? scan.entity_cursor : encodeEntityCursor(last.entityType, last.entityId);
    const done = remaining ? 0 : 1;
    this.ctx.storage.sql.exec(
      'UPDATE scans SET entity_cursor = ?, done = ? WHERE scan_id = ?',
      entityCursor,
      done,
      scan.scan_id,
    );
    return {
      entities,
      nextCursor: remaining ? entityCursor : null,
      done: done === 1,
    };
  }

  private handleScanFinish(requestId: string, params: unknown): Response {
    const finish = parseScanFinishParams(params);
    const result = this.commit(() => this.finishScan(finish.scanId));
    return rpcSuccessResponse(requestId, result);
  }

  private finishScan(scanId: string): SyncScanFinishResult {
    const scan = this.loadScan(scanId);
    this.assertScanEpochAndRetention(scan);
    if (scan.done !== 1) {
      // The snapshot is only complete once paging has consumed every entity.
      throw new RpcFailure('malformed-request', { reason: 'scan-incomplete' });
    }
    const watermarkEnd = this.currentWatermark();
    return {
      scanId: scan.scan_id,
      complete: true,
      watermarkEnd,
      epoch: this.readMeta('epoch'),
      nextCursor: String(watermarkEnd) as SyncCursor,
    };
  }

  private loadScan(scanId: string): ScanRow {
    const rows = this.ctx.storage.sql
      .exec<ScanRow>(
        `SELECT scan_id, watermark_start, epoch, created_at, done, entity_cursor
         FROM scans WHERE scan_id = ?`,
        scanId,
      )
      .toArray();
    const scan = rows[0];
    if (scan === undefined) {
      throw new RpcFailure('not-found', { reason: 'scan' });
    }
    if (Date.now() - scan.created_at > SNAPSHOT_LIFETIME_MS) {
      throw new RpcFailure('not-found', { reason: 'scan-expired' });
    }
    return scan;
  }

  private assertScanEpochAndRetention(scan: ScanRow): void {
    const storedEpoch = this.readMeta('epoch');
    if (scan.epoch !== storedEpoch) {
      throw new RpcFailure('epoch-mismatch', { expected: storedEpoch, actual: scan.epoch });
    }
    const floor = this.readRetentionFloor();
    if (scan.watermark_start < floor) {
      throw new RpcFailure('reset-required', {
        reason: 'retention-floor',
        floor,
        watermarkStart: scan.watermark_start,
      });
    }
  }

  private currentWatermark(): number {
    const nextSequence = Number(this.readMeta('next_sequence'));
    return nextSequence > 1 ? nextSequence - 1 : 0;
  }

  private readRetentionFloor(): number {
    return Number(this.readMeta('retention_floor'));
  }

  private provisionEnrollment(auth: SpikeAuth): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO enrollments (enrollment_id, account_id, generation, high_water, created_at)
       VALUES (?, ?, 1, 0, ?)
       ON CONFLICT(enrollment_id) DO NOTHING`,
      auth.enrollmentId,
      auth.accountId,
      Date.now(),
    );
  }

  private readEnrollment(enrollmentId: string): EnrollmentRow {
    return this.ctx.storage.sql
      .exec<EnrollmentRow>(
        'SELECT high_water, account_id FROM enrollments WHERE enrollment_id = ?',
        enrollmentId,
      )
      .one();
  }

  private readEntity(entityType: string, entityId: string): EntityRow | null {
    const rows = this.ctx.storage.sql
      .exec<EntityRow>(
        `SELECT revision, operation, payload, schema_version
         FROM entities WHERE entity_type = ? AND entity_id = ?`,
        entityType,
        entityId,
      )
      .toArray();
    return rows[0] ?? null;
  }

  private writeReceipt(
    enrollmentId: string,
    item: PreparedChange,
    result: SyncPushItemResult,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO receipts (
         enrollment_id, enrollment_sequence, change_id, status, revision, content_hash, result, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      enrollmentId,
      item.change.enrollmentSequence,
      item.change.changeId,
      result.status,
      result.status === 'accepted' ? result.revision : null,
      item.change.payloadHash,
      JSON.stringify(result),
      Date.now(),
    );
  }

  private advanceHighWater(enrollmentId: string, enrollmentSequence: number): void {
    this.ctx.storage.sql.exec(
      'UPDATE enrollments SET high_water = ? WHERE enrollment_id = ? AND high_water < ?',
      enrollmentSequence,
      enrollmentId,
      enrollmentSequence,
    );
  }

  private readMeta(key: string): string {
    return this.ctx.storage.sql
      .exec<MetaRow>('SELECT value FROM sync_meta WHERE key = ?', key)
      .one().value;
  }

  private broadcastInvalidate(watermark: number): void {
    const frame: SyncInvalidateFrame = {
      type: 'sync.invalidate',
      version: SOCKET_FRAME_VERSION,
      id: crypto.randomUUID(),
      epoch: this.readMeta('epoch'),
      watermark,
    };
    this.emitSocketFrame(frame);
  }

  /**
   * Live-frame fanout to this account's attached sockets.
   * `excludeEnrollmentId` skips the caller's own attachments — mailbox
   * semantics: a `worker.connect` announcement reaches the account's OTHER
   * sockets, not the connecting device's. `onlyEnrollmentId` narrows delivery
   * to one enrollment's attachments — MESH-02's `job.available` targets the
   * resolved worker's sockets only.
   */
  private emitSocketFrame(
    frame: SocketFrame,
    options?: { excludeEnrollmentId?: string; onlyEnrollmentId?: string },
  ): void {
    const encoded = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets()) {
      if (options?.excludeEnrollmentId !== undefined || options?.onlyEnrollmentId !== undefined) {
        const attachment = socket.deserializeAttachment();
        const enrolled = isSocketAttachment(attachment) ? attachment.enrollmentId : null;
        if (options.onlyEnrollmentId !== undefined && enrolled !== options.onlyEnrollmentId) {
          continue;
        }
        if (options.excludeEnrollmentId !== undefined && enrolled === options.excludeEnrollmentId) {
          continue;
        }
      }
      socket.send(encoded);
    }
  }

  // ---- MESH-01 worker lifecycle --------------------------------------
  // A device opts in locally via `device.policy.publish`; every worker.*
  // operation below fails closed unless the stored policy allows jobs.

  /**
   * Stores the device policy verbatim. Re-publishing over a revoked record
   * is a fresh local opt-in: it clears `revoked_at` and resets the
   * incarnation so the next `worker.connect` mints a new one.
   */
  private handleDevicePolicyPublish(auth: SpikeAuth, requestId: string, params: unknown): Response {
    const policy = parseDevicePolicyParams(params);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO workers (
         enrollment_id, account_id, policy, incarnation, capabilities,
         connected_at, last_seen_at, lease_expires_at, revoked_at, created_at
       ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)
       ON CONFLICT(enrollment_id) DO UPDATE SET
         account_id = excluded.account_id,
         policy = excluded.policy,
         incarnation = CASE WHEN workers.revoked_at IS NOT NULL THEN NULL ELSE workers.incarnation END,
         connected_at = CASE WHEN workers.revoked_at IS NOT NULL THEN NULL ELSE workers.connected_at END,
         last_seen_at = CASE WHEN workers.revoked_at IS NOT NULL THEN NULL ELSE workers.last_seen_at END,
         lease_expires_at = CASE WHEN workers.revoked_at IS NOT NULL THEN NULL ELSE workers.lease_expires_at END,
         revoked_at = NULL`,
      auth.enrollmentId,
      auth.accountId,
      JSON.stringify(policy),
      now,
    );
    this.bumpCounter('policy_publishes', 1);
    const result: DevicePolicyPublishResult = {
      published: true,
      publishedAt: new Date(now).toISOString(),
    };
    return rpcSuccessResponse(requestId, result);
  }

  /**
   * Registers or refreshes the caller's worker incarnation. A live lease
   * (heartbeat reconnect) reuses the stored incarnation; first connect or
   * an expired lease mints a new UUID. Announces `worker.available` to the
   * account's other sockets.
   */
  private async handleWorkerConnect(auth: SpikeAuth, requestId: string): Promise<Response> {
    const { row } = this.requireWorker(auth);
    const now = Date.now();
    const live = isLeaseLive(row, now);
    const incarnation = live ? (row.incarnation as string) : crypto.randomUUID();
    const leaseExpiresAt = now + WORKER_LEASE_MS;
    if (live) {
      this.ctx.storage.sql.exec(
        'UPDATE workers SET last_seen_at = ?, lease_expires_at = ? WHERE enrollment_id = ?',
        now,
        leaseExpiresAt,
        auth.enrollmentId,
      );
    } else {
      this.ctx.storage.sql.exec(
        `UPDATE workers SET incarnation = ?, connected_at = ?, last_seen_at = ?, lease_expires_at = ?
         WHERE enrollment_id = ?`,
        incarnation,
        now,
        now,
        leaseExpiresAt,
        auth.enrollmentId,
      );
    }
    this.bumpCounter('worker_connects', 1);
    const frame: WorkerAvailableFrame = {
      type: 'worker.available',
      version: SOCKET_FRAME_VERSION,
      id: crypto.randomUUID(),
      enrollmentId: auth.enrollmentId,
      incarnation,
    };
    this.emitSocketFrame(frame, { excludeEnrollmentId: auth.enrollmentId });
    await this.ensureSweepScheduled();
    const result: WorkerConnectResult = {
      workerIncarnation: incarnation,
      leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
    };
    return rpcSuccessResponse(requestId, result);
  }

  /** The caller's worker record; `available` is derived from lease freshness. */
  private handleWorkerDescribe(auth: SpikeAuth, requestId: string): Response {
    const { row, policy } = this.requireWorker(auth);
    const now = Date.now();
    const replicas: WorkerReplicaSummary[] = this.ctx.storage.sql
      .exec<WorkerReplicaRow>(
        `SELECT workspace_id, definition_revision, readiness, observed_at
         FROM worker_replicas WHERE enrollment_id = ? ORDER BY workspace_id ASC`,
        auth.enrollmentId,
      )
      .toArray()
      .map((replica) => {
        if (!isReplicaReadiness(replica.readiness)) {
          throw new RpcFailure('unavailable', { reason: 'corrupt-replica-readiness' });
        }
        return {
          workspaceId: replica.workspace_id,
          definitionRevision: replica.definition_revision,
          readiness: replica.readiness,
          observedAt: replica.observed_at,
        };
      });
    const result: WorkerDescribeResult = {
      enrollmentId: row.enrollment_id,
      workerIncarnation: row.incarnation,
      available: isLeaseLive(row, now),
      policy,
      capabilities:
        row.capabilities === null ? null : (JSON.parse(row.capabilities) as WorkerCapabilities),
      replicas,
      connectedAt: row.connected_at === null ? null : new Date(row.connected_at).toISOString(),
      lastSeenAt: row.last_seen_at === null ? null : new Date(row.last_seen_at).toISOString(),
      leaseExpiresAt:
        row.lease_expires_at === null ? null : new Date(row.lease_expires_at).toISOString(),
    };
    return rpcSuccessResponse(requestId, result);
  }

  /** Replaces the live incarnation's capability set verbatim. */
  private handleWorkerCapabilitiesPublish(
    auth: SpikeAuth,
    requestId: string,
    params: unknown,
  ): Response {
    // The fail-closed policy gate runs before payload validation: an
    // unauthorized enrollment learns nothing about param shapes.
    const { row } = this.requireWorker(auth);
    const capabilities = parseWorkerCapabilitiesParams(params);
    const now = Date.now();
    this.requireLiveIncarnation(row, now);
    this.ctx.storage.sql.exec(
      `UPDATE workers SET capabilities = ?, last_seen_at = ?, lease_expires_at = ?
       WHERE enrollment_id = ?`,
      JSON.stringify(capabilities),
      now,
      now + WORKER_LEASE_MS,
      auth.enrollmentId,
    );
    this.bumpCounter('capability_publishes', 1);
    const result: WorkerCapabilitiesPublishResult = { published: true };
    return rpcSuccessResponse(requestId, result);
  }

  /** Upserts replica summaries keyed by workspaceId; metadata only. */
  private handleWorkerReplicaPublish(
    auth: SpikeAuth,
    requestId: string,
    params: unknown,
  ): Response {
    const { row } = this.requireWorker(auth);
    const publish = parseReplicaPublishParams(params);
    const now = Date.now();
    this.requireLiveIncarnation(row, now);
    this.commit(() => {
      for (const replica of publish.replicas) {
        this.ctx.storage.sql.exec(
          `INSERT INTO worker_replicas (
             enrollment_id, workspace_id, definition_revision, readiness, observed_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(enrollment_id, workspace_id) DO UPDATE SET
             definition_revision = excluded.definition_revision,
             readiness = excluded.readiness,
             observed_at = excluded.observed_at,
             updated_at = excluded.updated_at`,
          auth.enrollmentId,
          replica.workspaceId,
          replica.definitionRevision,
          replica.readiness,
          replica.observedAt,
          now,
        );
      }
      this.ctx.storage.sql.exec(
        'UPDATE workers SET last_seen_at = ?, lease_expires_at = ? WHERE enrollment_id = ?',
        now,
        now + WORKER_LEASE_MS,
        auth.enrollmentId,
      );
    });
    this.bumpCounter('replica_publishes', 1);
    const result: WorkerReplicaPublishResult = { published: true };
    return rpcSuccessResponse(requestId, result);
  }

  private readWorker(enrollmentId: string): WorkerRow | null {
    const rows = this.ctx.storage.sql
      .exec<WorkerRow>('SELECT * FROM workers WHERE enrollment_id = ?', enrollmentId)
      .toArray();
    return rows[0] ?? null;
  }

  /**
   * Fail-closed gate for `worker.*` data operations: the calling enrollment
   * must have published a device policy allowing jobs, and its worker record
   * must not be revoked. `device.policy.publish` is the bootstrap and is
   * exempt — any authenticated enrollment may publish its own policy.
   */
  private requireWorker(auth: SpikeAuth): { row: WorkerRow; policy: DevicePolicy } {
    const row = this.readWorker(auth.enrollmentId);
    if (row === null || row.account_id !== auth.accountId) {
      throw new RpcFailure('forbidden', { reason: 'worker-policy-required' });
    }
    if (row.revoked_at !== null) {
      throw new RpcFailure('forbidden', { reason: 'worker-revoked' });
    }
    const policy = parseStoredDevicePolicy(row.policy);
    if (policy.worker.allowJobs !== true) {
      throw new RpcFailure('forbidden', { reason: 'jobs-not-allowed' });
    }
    return { row, policy };
  }

  /**
   * Capability/replica publications belong to a live incarnation. A stale
   * lease must be re-established through `worker.connect` first (which mints
   * a fresh incarnation), so an old process cannot revive dead ownership.
   */
  private requireLiveIncarnation(row: WorkerRow, now: number): void {
    if (!isLeaseLive(row, now)) {
      throw new RpcFailure('forbidden', { reason: 'worker-not-connected' });
    }
  }

  // ---- MESH-02 job/attempt lifecycle --------------------------------------
  // Durable jobs and attempts are account metadata: their writes never touch
  // the sync change sequence and are never entity changes (spec §9/§13).
  // Placement is resolved and persisted at create; claim enforces liveness,
  // source policy, deadline, capacity, and duplicate checks in one
  // transaction before allocating a per-job monotonic fence. Renew and
  // report require attempt + incarnation + fence to match; a stale report is
  // rejected but its recoverable result is retained on the attempt row.

  /**
   * `job.create`: idempotent on (source enrollment, requestId) + payload
   * hash. A replay with the same hash returns the stored job; a different
   * hash under a used requestId is a conflict. Placement is resolved eagerly
   * and persisted with its explanation before the job can be claimed.
   */
  private async handleJobCreate(
    auth: SpikeAuth,
    requestId: string,
    params: unknown,
  ): Promise<Response> {
    const create = parseJobCreateParams(params);
    const now = Date.now();
    let queueDeadline = now + USER_JOB_DEADLINE_MS;
    if (create.queueDeadline !== undefined) {
      queueDeadline = Date.parse(create.queueDeadline);
    }
    if (
      !Number.isFinite(queueDeadline) ||
      queueDeadline <= now ||
      queueDeadline > now + MAX_QUEUE_DEADLINE_HORIZON_MS
    ) {
      throw new RpcFailure('malformed-request', { reason: 'queueDeadline' });
    }
    const created = this.commit(() => {
      this.provisionEnrollment(auth);
      const existing = this.readJobByRequest(auth.enrollmentId, create.requestId);
      if (existing !== null) {
        if (existing.payload_hash !== create.payloadHash) {
          throw new RpcFailure('conflict', {
            reason: 'request-id-hash-mismatch',
            requestId: create.requestId,
          });
        }
        return { job: this.jobSummary(existing), notifyTarget: null as string | null };
      }
      const placement = this.resolvePlacement(auth, create, now);
      const jobId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO jobs (
           job_id, account_id, source_enrollment_id, request_id, payload_hash, kind,
           requested_target, target_enrollment_id, placement_explanation, input_manifest,
           state, state_reason, queue_deadline, retry_policy, retried, next_fence,
           active_attempt_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, 0, 1, NULL, ?, ?)`,
        jobId,
        auth.accountId,
        auth.enrollmentId,
        create.requestId,
        create.payloadHash,
        create.kind,
        JSON.stringify(create.requestedTarget),
        placement.targetEnrollmentId,
        placement.explanation,
        JSON.stringify(create.inputManifest),
        queueDeadline,
        create.retryPolicy,
        now,
        now,
      );
      this.journalDurableEvent({
        jobId,
        attemptId: '',
        generation: 0,
        kind: 'job.created',
        payload: {
          requestId: create.requestId,
          kind: create.kind,
          sourceEnrollmentId: auth.enrollmentId,
          ...(placement.targetEnrollmentId === null
            ? {}
            : { targetEnrollmentId: placement.targetEnrollmentId }),
          state: 'queued',
        },
      });
      this.bumpCounter('job_creates', 1);
      return {
        job: this.jobSummary(this.readJobRequired(jobId)),
        notifyTarget: placement.targetEnrollmentId,
      };
    });
    // A freshly queued job with a resolved target is claimable: nudge exactly
    // that enrollment's attached sockets.
    if (created.notifyTarget !== null) {
      this.emitJobAvailable(created.job.id, created.notifyTarget);
    }
    await this.ensureSweepScheduled();
    const result: JobCreateResult = { job: created.job };
    return rpcSuccessResponse(requestId, result);
  }

  /**
   * Resolve and explain the claim-time target (spec §9/§12).
   * - `device`: the source's explicit choice is validated eagerly — the
   *   target must hold a live worker incarnation under an allowing policy
   *   that authorizes the source. Failure rejects the create: an explicit
   *   target is never silently retargeted or left dangling.
   * - `auto`: deterministic pick — the least-loaded live worker (active
   *   attempts, then enrollment id) whose policy authorizes the source and
   *   whose capabilities satisfy the declared requirements, with free
   *   capacity. Nothing qualifying leaves the job queued-but-unresolved.
   */
  private resolvePlacement(
    auth: SpikeAuth,
    create: JobCreateParams,
    now: number,
  ): { targetEnrollmentId: string | null; explanation: string } {
    const requested = create.requestedTarget;
    if (requested.kind === 'device') {
      const enrollmentId = requested.enrollmentId as string;
      const row = this.readWorker(enrollmentId);
      if (row === null || row.account_id !== auth.accountId || row.revoked_at !== null) {
        throw new RpcFailure('forbidden', {
          reason: 'target-not-eligible',
          targetEnrollmentId: enrollmentId,
        });
      }
      const policy = parseStoredDevicePolicy(row.policy);
      if (
        policy.worker.allowJobs !== true ||
        !policyAllowsSource(policy, auth.enrollmentId, enrollmentId)
      ) {
        throw new RpcFailure('forbidden', {
          reason: 'target-not-eligible',
          targetEnrollmentId: enrollmentId,
        });
      }
      if (!isLeaseLive(row, now)) {
        throw new RpcFailure('conflict', {
          reason: 'target-not-live',
          targetEnrollmentId: enrollmentId,
        });
      }
      return {
        targetEnrollmentId: enrollmentId,
        explanation: `device: explicit target; live worker with allowing policy`,
      };
    }
    const candidates = this.ctx.storage.sql
      .exec<WorkerRow & { active_attempts: number }>(
        `SELECT w.*, (
           SELECT COUNT(*) FROM attempts a
           WHERE a.worker_enrollment_id = w.enrollment_id
             AND a.state IN ('claimed', 'preparing', 'running', 'stopping')
         ) AS active_attempts
         FROM workers w
         WHERE w.account_id = ? AND w.revoked_at IS NULL`,
        auth.accountId,
      )
      .toArray();
    let liveAllowing = 0;
    const eligible: { enrollmentId: string; activeAttempts: number }[] = [];
    for (const row of candidates) {
      const policy = parseStoredDevicePolicy(row.policy);
      if (policy.worker.allowJobs !== true || !isLeaseLive(row, now)) {
        continue;
      }
      liveAllowing += 1;
      if (!policyAllowsSource(policy, auth.enrollmentId, row.enrollment_id)) {
        continue;
      }
      const capabilities = parseStoredCapabilities(row.capabilities);
      if (!capabilitiesSatisfy(capabilities, requested.requirements)) {
        continue;
      }
      const capacity = effectiveConcurrencyCap(policy, capabilities);
      if (row.active_attempts >= capacity) {
        continue;
      }
      eligible.push({ enrollmentId: row.enrollment_id, activeAttempts: row.active_attempts });
    }
    eligible.sort(
      (a, b) => a.activeAttempts - b.activeAttempts || a.enrollmentId.localeCompare(b.enrollmentId),
    );
    const chosen = eligible[0];
    if (chosen === undefined) {
      const explanation =
        `auto: no eligible live worker (${liveAllowing} live worker(s) ` +
        'allowing jobs; none satisfy source authorization, requirements, and capacity)';
      return { targetEnrollmentId: null, explanation };
    }
    return {
      targetEnrollmentId: chosen.enrollmentId,
      explanation: `auto: least-loaded of ${eligible.length} eligible live worker(s)`,
    };
  }

  /** `job.get`: job summary plus its attempts, fence-ordered. */
  private handleJobGet(requestId: string, params: unknown): Response {
    const { jobId } = parseJobIdParams(params);
    const result = this.commit(() => {
      const now = Date.now();
      this.expireQueuedJobs(now);
      const job = this.readJob(jobId);
      if (job === null) {
        throw new RpcFailure('not-found', { reason: 'job' });
      }
      // MESH-03: reads also enforce pending-approval expiry lazily.
      this.expireJobApprovals(jobId, now);
      const attempts = this.ctx.storage.sql
        .exec<AttemptRow>(
          'SELECT * FROM attempts WHERE job_id = ? ORDER BY fence ASC',
          jobId,
        )
        .toArray()
        .map((row) => this.attemptView(row));
      const out: JobGetResult = { job: this.jobSummary(job), attempts };
      return out;
    });
    return rpcSuccessResponse(requestId, result);
  }

  /** `job.list`: newest-first, optional state filter, bounded page. */
  private handleJobList(requestId: string, params: unknown): Response {
    const list = parseJobListParams(params);
    const result = this.commit(() => {
      this.expireQueuedJobs(Date.now());
      const rows =
        list.state === undefined
          ? this.ctx.storage.sql
              .exec<JobRow>(
                'SELECT * FROM jobs ORDER BY created_at DESC, job_id ASC LIMIT ?',
                list.limit,
              )
              .toArray()
          : this.ctx.storage.sql
              .exec<JobRow>(
                'SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC, job_id ASC LIMIT ?',
                list.state,
                list.limit,
              )
              .toArray();
      const out: JobListResult = { jobs: rows.map((row) => this.jobSummary(row)) };
      return out;
    });
    return rpcSuccessResponse(requestId, result);
  }

  /**
   * `job.claim` (worker actor): one transaction checks, in order —
   * 1. caller holds a live worker incarnation (requireWorker + lease);
   * 2. job is `queued`, unresolved-or-targeted-at-caller, inside its
   *    queueDeadline (an expired deadline marks the job failed lazily);
   * 3. the target worker's policy authorizes the source enrollment;
   * 4. capacity: active attempts < min(policy, capabilities, backend cap);
   * 5. no other non-terminal attempt exists for the job.
   * Then it allocates the next fence, creates the `claimed` attempt, and
   * moves the job to `running`.
   */
  private async handleJobClaim(
    auth: SpikeAuth,
    requestId: string,
    params: unknown,
  ): Promise<Response> {
    const { jobId } = parseJobIdParams(params);
    const { row: worker, policy } = this.requireWorker(auth);
    const now = Date.now();
    this.requireLiveIncarnation(worker, now);
    const result = this.commit(() => {
      const job = this.readJob(jobId);
      if (job === null || job.account_id !== auth.accountId) {
        throw new RpcFailure('not-found', { reason: 'job' });
      }
      if (job.state === 'queued' && job.queue_deadline <= now) {
        this.setJobState(job, 'failed', now, {
          stateReason: 'queue-deadline',
          activeAttemptId: null,
        });
        throw new RpcFailure('conflict', { reason: 'queue-deadline', jobId });
      }
      if (job.state !== 'queued') {
        throw new RpcFailure('conflict', { reason: 'job-not-queued', state: job.state });
      }
      if (job.target_enrollment_id !== null && job.target_enrollment_id !== auth.enrollmentId) {
        throw new RpcFailure('forbidden', {
          reason: 'not-the-target',
          targetEnrollmentId: job.target_enrollment_id,
        });
      }
      if (!policyAllowsSource(policy, job.source_enrollment_id, auth.enrollmentId)) {
        throw new RpcFailure('forbidden', { reason: 'source-not-allowed' });
      }
      const capacity = effectiveConcurrencyCap(policy, parseStoredCapabilities(worker.capabilities));
      const active = this.countActiveAttempts(auth.enrollmentId);
      if (active >= capacity) {
        throw new RpcFailure('conflict', { reason: 'worker-at-capacity', limit: capacity });
      }
      const duplicate = this.ctx.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM attempts
           WHERE job_id = ? AND state IN ('claimed', 'preparing', 'running', 'stopping')`,
          jobId,
        )
        .one().n;
      if (duplicate > 0) {
        throw new RpcFailure('conflict', { reason: 'active-attempt-exists' });
      }
      const fence = job.next_fence;
      const attemptId = crypto.randomUUID();
      const leaseExpiresAt = now + LEASE_DURATION_MS;
      this.ctx.storage.sql.exec(
        `INSERT INTO attempts (
           attempt_id, job_id, worker_enrollment_id, worker_incarnation, fence, state,
           lease_expires_at, outcome, result, error, late_result, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, NULL, NULL, NULL, NULL, ?, ?)`,
        attemptId,
        jobId,
        auth.enrollmentId,
        worker.incarnation as string,
        fence,
        leaseExpiresAt,
        now,
        now,
      );
      this.journalDurableEvent({
        jobId,
        attemptId,
        generation: fence,
        kind: 'attempt.created',
        payload: {
          fence,
          workerEnrollmentId: auth.enrollmentId,
          workerIncarnation: worker.incarnation as string,
          leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
        },
      });
      this.setJobState(job, 'running', now, {
        activeAttemptId: attemptId,
        nextFence: fence + 1,
      });
      // Claiming is worker activity: refresh the incarnation lease too.
      this.ctx.storage.sql.exec(
        'UPDATE workers SET last_seen_at = ?, lease_expires_at = ? WHERE enrollment_id = ?',
        now,
        now + WORKER_LEASE_MS,
        auth.enrollmentId,
      );
      this.bumpCounter('job_claims', 1);
      const out: JobClaimResult = {
        job: this.jobSummary(this.readJobRequired(jobId)),
        attempt: this.attemptView(this.readAttemptRequired(attemptId)),
        fence,
        manifest: JSON.parse(job.input_manifest) as ExecutionManifest,
      };
      return out;
    });
    await this.ensureSweepScheduled();
    return rpcSuccessResponse(requestId, result);
  }

  /**
   * `attempt.renew` (worker actor): batched per-item lease renewals. Each
   * item requires the attempt to belong to the caller, the incarnation and
   * fence to match, the caller's incarnation to still be the live one, and
   * the attempt to be non-terminal with an unexpired lease. A rejected item
   * never fails the batch.
   */
  private handleAttemptRenew(auth: SpikeAuth, requestId: string, params: unknown): Response {
    const { row: worker } = this.requireWorker(auth);
    const renew = parseAttemptRenewParams(params);
    const now = Date.now();
    const results: AttemptRenewalResult[] = [];
    this.commit(() => {
      let renewed = 0;
      for (const item of renew.renewals) {
        const reject = (reason: string): AttemptRenewalResult => ({
          attemptId: item.attemptId,
          status: 'rejected',
          reason,
        });
        const attempt = this.readAttempt(item.attemptId);
        if (attempt === null) {
          results.push(reject('not-found'));
          continue;
        }
        if (attempt.worker_enrollment_id !== auth.enrollmentId) {
          results.push(reject('not-owner'));
          continue;
        }
        if (
          attempt.worker_incarnation !== item.incarnation ||
          worker.incarnation !== item.incarnation
        ) {
          results.push(reject('stale-incarnation'));
          continue;
        }
        if (attempt.fence !== item.fence) {
          results.push(reject('stale-fence'));
          continue;
        }
        if (!isActiveAttemptState(attempt.state)) {
          results.push(reject('attempt-terminal'));
          continue;
        }
        if (attempt.lease_expires_at <= now) {
          results.push(reject('lease-expired'));
          continue;
        }
        if (!isLeaseLive(worker, now)) {
          results.push(reject('worker-not-live'));
          continue;
        }
        const leaseExpiresAt = now + LEASE_DURATION_MS;
        this.ctx.storage.sql.exec(
          'UPDATE attempts SET lease_expires_at = ?, updated_at = ? WHERE attempt_id = ?',
          leaseExpiresAt,
          now,
          attempt.attempt_id,
        );
        results.push({
          attemptId: item.attemptId,
          status: 'renewed',
          leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
        });
        renewed += 1;
      }
      if (renewed > 0) {
        this.ctx.storage.sql.exec(
          'UPDATE workers SET last_seen_at = ?, lease_expires_at = ? WHERE enrollment_id = ?',
          now,
          now + WORKER_LEASE_MS,
          auth.enrollmentId,
        );
        this.bumpCounter('attempt_renews', renewed);
      }
    });
    const result: AttemptRenewResult = { results };
    return rpcSuccessResponse(requestId, result);
  }

  /**
   * `attempt.report` (worker actor): fence+incarnation-matched outcome
   * publication. On a match the attempt records the outcome and transitions
   * — `completed` completes the job unless a prior `cancel-requested` masks
   * it (the report is the verified stop, so the job confirms `cancelled`);
   * `failed` fails the job, except a `safe` retry policy returns it to
   * `queued` once with a fresh deadline. A stale fence/incarnation or a
   * terminal attempt rejects the transition but stores the report in
   * `late_result` for forensics. An expired attempt lease does NOT reject a
   * matched report: leases never reassign ownership, so the attempt remains
   * the sole publisher of its outcome.
   */
  private async handleAttemptReport(
    auth: SpikeAuth,
    requestId: string,
    params: unknown,
  ): Promise<Response> {
    const report = parseAttemptReportParams(params);
    const { row: worker } = this.requireWorker(auth);
    const now = Date.now();
    const reported = this.commit(() => {
      const attempt = this.readAttempt(report.attemptId);
      if (attempt === null) {
        throw new RpcFailure('not-found', { reason: 'attempt' });
      }
      if (attempt.worker_enrollment_id !== auth.enrollmentId) {
        throw new RpcFailure('forbidden', { reason: 'not-attempt-owner' });
      }
      const job = this.readJobRequired(attempt.job_id);
      const stale =
        attempt.worker_incarnation !== report.incarnation ||
        attempt.fence !== report.fence ||
        worker.incarnation === null ||
        worker.incarnation !== attempt.worker_incarnation;
      if (stale || !isActiveAttemptState(attempt.state)) {
        this.ctx.storage.sql.exec(
          'UPDATE attempts SET late_result = ?, updated_at = ? WHERE attempt_id = ?',
          JSON.stringify({
            outcome: report.outcome,
            result: report.resultJson === null ? null : (JSON.parse(report.resultJson) as unknown),
            error: report.error ?? null,
            reportedAt: new Date(now).toISOString(),
          }),
          now,
          attempt.attempt_id,
        );
        const out: AttemptReportResult = {
          status: 'late-result-retained',
          job: this.jobSummary(job),
          attempt: this.attemptView(this.readAttemptRequired(attempt.attempt_id)),
        };
        return { result: out, requeueTarget: null as string | null };
      }
      this.ctx.storage.sql.exec(
        'UPDATE attempts SET outcome = ?, result = ?, error = ?, updated_at = ? WHERE attempt_id = ?',
        report.outcome,
        report.resultJson,
        report.error ?? null,
        now,
        attempt.attempt_id,
      );
      let requeueTarget: string | null = null;
      if (job.state === 'cancel-requested') {
        // Cancellation wins: this report is the verified stop. A reported
        // failure keeps its outcome; a reported completion is masked to
        // 'cancelled' (stopping attempts never reach completed).
        this.setAttemptState(attempt, report.outcome === 'failed' ? 'failed' : 'cancelled', now);
        this.setJobState(job, report.outcome === 'failed' ? 'failed' : 'cancelled', now, {
          stateReason: 'cancel-requested',
          activeAttemptId: null,
        });
      } else if (report.outcome === 'completed') {
        this.setAttemptState(attempt, 'completed', now);
        this.setJobState(job, 'completed', now, {
          stateReason: null,
          activeAttemptId: null,
        });
      } else {
        this.setAttemptState(attempt, 'failed', now);
        if (job.retry_policy === 'safe' && job.retried === 0) {
          // One bounded re-queue under a 'safe' retry policy: fresh queue
          // deadline, resolved target preserved.
          this.setJobState(job, 'queued', now, {
            stateReason: 'retry-safe',
            activeAttemptId: null,
            queueDeadline: now + USER_JOB_DEADLINE_MS,
            retried: 1,
          });
          requeueTarget = job.target_enrollment_id;
        } else {
          this.setJobState(job, 'failed', now, {
            stateReason: 'attempt-failed',
            activeAttemptId: null,
          });
        }
      }
      // A fence-matched report is worker activity: refresh its lease.
      this.ctx.storage.sql.exec(
        'UPDATE workers SET last_seen_at = ?, lease_expires_at = ? WHERE enrollment_id = ?',
        now,
        now + WORKER_LEASE_MS,
        auth.enrollmentId,
      );
      this.bumpCounter('attempt_reports', 1);
      const out: AttemptReportResult = {
        status: 'applied',
        job: this.jobSummary(this.readJobRequired(job.job_id)),
        attempt: this.attemptView(this.readAttemptRequired(attempt.attempt_id)),
      };
      return { result: out, requeueTarget };
    });
    // A re-queued job is claimable again: nudge the (preserved) target.
    if (reported.requeueTarget !== null) {
      this.emitJobAvailable(reported.result.job.id, reported.requeueTarget);
    }
    await this.ensureSweepScheduled();
    return rpcSuccessResponse(requestId, reported.result);
  }

  /**
   * `job.cancel` (source enrollment or any account controller): idempotent
   * durable intent per JOB_TRANSITIONS. `queued`/`awaiting-approval` confirm
   * `cancelled` directly; `running` moves to `cancel-requested` and marks
   * the active attempt `stopping` — the verified stop arrives via
   * attempt.report or the lease-lapse sweep. Terminal states are a no-op.
   */
  private handleJobCancel(requestId: string, params: unknown): Response {
    const { jobId } = parseJobIdParams(params);
    const result = this.commit(() => {
      const now = Date.now();
      this.expireQueuedJobs(now);
      const job = this.readJob(jobId);
      if (job === null) {
        throw new RpcFailure('not-found', { reason: 'job' });
      }
      if (!isJobState(job.state)) {
        throw new RpcFailure('unavailable', { reason: 'corrupt-job-state' });
      }
      if (job.state === 'queued' || job.state === 'awaiting-approval') {
        this.setJobState(job, 'cancelled', now, {
          stateReason: 'cancelled',
          activeAttemptId: null,
        });
      } else if (job.state === 'running') {
        this.setJobState(job, 'cancel-requested', now, { stateReason: 'cancel-requested' });
        const active =
          job.active_attempt_id === null ? null : this.readAttempt(job.active_attempt_id);
        if (active !== null && isActiveAttemptState(active.state)) {
          this.setAttemptState(active, 'stopping', now);
        }
      }
      // MESH-03: leaving the wait cancels any still-pending approvals.
      if (job.state === 'cancel-requested' || job.state === 'cancelled') {
        this.cancelPendingApprovals(job.job_id, now);
      }
      // 'cancel-requested' loops to itself and terminal states have no edges:
      // a repeated cancel is an idempotent no-op.
      this.bumpCounter('job_cancels', 1);
      const out: JobCancelResult = { job: this.jobSummary(this.readJobRequired(jobId)) };
      return out;
    });
    return rpcSuccessResponse(requestId, result);
  }

  private emitJobAvailable(jobId: string, targetEnrollmentId: string): void {
    const frame: JobAvailableFrame = {
      type: 'job.available',
      version: SOCKET_FRAME_VERSION,
      id: crypto.randomUUID(),
      jobId,
    };
    this.emitSocketFrame(frame, { onlyEnrollmentId: targetEnrollmentId });
  }

  /**
   * Lazy queue-deadline enforcement (spec §9: reads/claims must enforce
   * expiry without relying on punctual timers). Bounded per pass; the alarm
   * sweep runs the same helper. Returns the number of jobs marked failed.
   */
  private expireQueuedJobs(now: number): number {
    const expired = this.ctx.storage.sql
      .exec<{ job_id: string }>(
        "SELECT job_id FROM jobs WHERE state = 'queued' AND queue_deadline <= ? LIMIT ?",
        now,
        SWEEP_BATCH_ROWS,
      )
      .toArray();
    for (const row of expired) {
      const job = this.readJob(row.job_id);
      if (job === null || job.state !== 'queued') {
        continue;
      }
      this.setJobState(job, 'failed', now, {
        stateReason: 'queue-deadline',
        activeAttemptId: null,
      });
    }
    if (expired.length > 0) {
      this.bumpCounter('sweep_jobs_expired', expired.length);
    }
    return expired.length;
  }

  private readJob(jobId: string): JobRow | null {
    const rows = this.ctx.storage.sql
      .exec<JobRow>('SELECT * FROM jobs WHERE job_id = ?', jobId)
      .toArray();
    return rows[0] ?? null;
  }

  private readJobRequired(jobId: string): JobRow {
    const row = this.readJob(jobId);
    if (row === null) {
      throw new RpcFailure('unavailable', { reason: 'corrupt-job' });
    }
    return row;
  }

  private readJobByRequest(sourceEnrollmentId: string, requestId: string): JobRow | null {
    const rows = this.ctx.storage.sql
      .exec<JobRow>(
        'SELECT * FROM jobs WHERE source_enrollment_id = ? AND request_id = ?',
        sourceEnrollmentId,
        requestId,
      )
      .toArray();
    return rows[0] ?? null;
  }

  private readAttempt(attemptId: string): AttemptRow | null {
    const rows = this.ctx.storage.sql
      .exec<AttemptRow>('SELECT * FROM attempts WHERE attempt_id = ?', attemptId)
      .toArray();
    return rows[0] ?? null;
  }

  private readAttemptRequired(attemptId: string): AttemptRow {
    const row = this.readAttempt(attemptId);
    if (row === null) {
      throw new RpcFailure('unavailable', { reason: 'corrupt-attempt' });
    }
    return row;
  }

  private countActiveAttempts(workerEnrollmentId: string): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM attempts
         WHERE worker_enrollment_id = ?
           AND state IN ('claimed', 'preparing', 'running', 'stopping')`,
        workerEnrollmentId,
      )
      .one().n;
  }

  /**
   * Conditional job transition per the frozen JOB_TRANSITIONS table. The
   * caller's row object is updated so chained transitions see fresh state.
   */
  private setJobState(
    row: JobRow,
    target: JobState,
    now: number,
    extras?: {
      stateReason?: string | null;
      activeAttemptId?: string | null;
      queueDeadline?: number;
      retried?: number;
      nextFence?: number;
    },
  ): void {
    if (!isJobState(row.state) || !canTransitionJob(row.state, target)) {
      throw new RpcFailure('unavailable', {
        reason: 'illegal-job-transition',
        from: row.state,
        to: target,
      });
    }
    const stateReason = extras?.stateReason !== undefined ? extras.stateReason : row.state_reason;
    const activeAttemptId =
      extras?.activeAttemptId !== undefined ? extras.activeAttemptId : row.active_attempt_id;
    const queueDeadline = extras?.queueDeadline ?? row.queue_deadline;
    const retried = extras?.retried ?? row.retried;
    const nextFence = extras?.nextFence ?? row.next_fence;
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET state = ?, state_reason = ?, active_attempt_id = ?, queue_deadline = ?,
         retried = ?, next_fence = ?, updated_at = ?
       WHERE job_id = ?`,
      target,
      stateReason,
      activeAttemptId,
      queueDeadline,
      retried,
      nextFence,
      now,
      row.job_id,
    );
    // MESH-03: every job transition is a durable lifecycle event (spec §10).
    this.journalDurableEvent({
      jobId: row.job_id,
      attemptId: '',
      generation: 0,
      kind: 'job.state',
      payload: {
        from: row.state,
        to: target,
        ...(stateReason === null ? {} : { stateReason }),
      },
    });
    row.state = target;
    row.state_reason = stateReason;
    row.active_attempt_id = activeAttemptId;
    row.queue_deadline = queueDeadline;
    row.retried = retried;
    row.next_fence = nextFence;
    row.updated_at = now;
  }

  /**
   * Conditional attempt transition along the frozen ATTEMPT_TRANSITIONS
   * graph. v1 has no progress op, so a `claimed` attempt reports completion
   * via its legal path (claimed→preparing→running→completed): reachability
   * is verified hop by hop, the final state is stored once. No path (e.g.
   * stopping→completed) throws.
   */
  private setAttemptState(row: AttemptRow, target: AttemptState, now: number): void {
    if (!isAttemptState(row.state)) {
      throw new RpcFailure('unavailable', {
        reason: 'corrupt-attempt-state',
        state: row.state,
      });
    }
    if (row.state === target) {
      return;
    }
    if (!attemptTransitionReachable(row.state, target)) {
      throw new RpcFailure('unavailable', {
        reason: 'illegal-attempt-transition',
        from: row.state,
        to: target,
      });
    }
    this.ctx.storage.sql.exec(
      'UPDATE attempts SET state = ?, updated_at = ? WHERE attempt_id = ?',
      target,
      now,
      row.attempt_id,
    );
    // MESH-03: every attempt transition is a durable lifecycle event.
    this.journalDurableEvent({
      jobId: row.job_id,
      attemptId: row.attempt_id,
      generation: row.fence,
      kind: 'attempt.state',
      payload: { from: row.state, to: target },
    });
    row.state = target;
    row.updated_at = now;
  }

  private jobSummary(row: JobRow): JobSummary {
    if (!isJobKind(row.kind) || !isJobState(row.state) || !isRetryPolicy(row.retry_policy)) {
      throw new RpcFailure('unavailable', { reason: 'corrupt-job' });
    }
    return {
      id: row.job_id,
      requestId: row.request_id,
      payloadHash: row.payload_hash,
      kind: row.kind,
      sourceEnrollmentId: row.source_enrollment_id,
      requestedTarget: JSON.parse(row.requested_target) as RequestedTarget,
      ...(row.target_enrollment_id === null
        ? {}
        : { targetEnrollmentId: row.target_enrollment_id }),
      inputManifest: JSON.parse(row.input_manifest) as ExecutionManifest,
      state: row.state,
      queueDeadline: new Date(row.queue_deadline).toISOString(),
      retryPolicy: row.retry_policy,
      placementExplanation: row.placement_explanation,
      ...(row.state_reason === null ? {} : { stateReason: row.state_reason }),
    };
  }

  private attemptView(row: AttemptRow): ExecutionAttempt {
    if (!isAttemptState(row.state)) {
      throw new RpcFailure('unavailable', { reason: 'corrupt-attempt-state' });
    }
    return {
      id: row.attempt_id,
      jobId: row.job_id,
      workerIncarnation: row.worker_incarnation,
      fence: row.fence,
      leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
      state: row.state,
    };
  }

  // ---- MESH-03 durable event journal + live delivery -----------------------
  // All multi-write paths route through commit(): the transaction's journaled
  // events land in eventOutbox and are delivered to interested observers only
  // after the commit succeeds. A rollback truncates the outbox so subscribers
  // never observe uncommitted state. Two sequence spaces are deliberate
  // (contract): `event_seq` is the per-job durable cursor; `sequence` is the
  // per-(attempt, stream) sequence carried by live activity/gap frames.

  /**
   * transactionSync + post-commit side effects. Journaled frames deliver to
   * subscribed sockets; queued R2 object deletes run under ctx.waitUntil.
   * Call only at handler top level — helpers inside the callback journal via
   * the outbox and must not commit themselves.
   */
  private commit<T>(fn: () => T): T {
    const baseOutbox = this.eventOutbox.length;
    const basePurge = this.pendingR2Deletes.length;
    let result: T;
    try {
      result = this.ctx.storage.transactionSync(fn);
    } catch (error) {
      this.eventOutbox.length = baseOutbox;
      this.pendingR2Deletes.length = basePurge;
      throw error;
    }
    const frames = this.eventOutbox.splice(baseOutbox);
    const purges = this.pendingR2Deletes.splice(basePurge);
    for (const key of purges) {
      this.ctx.waitUntil(this.env.ARTIFACTS.delete(key).catch(() => undefined));
    }
    if (frames.length > 0) {
      this.deliverQueued(frames);
    }
    return result;
  }

  private jobEventMeta(jobId: string): JobEventMetaRow {
    const rows = this.ctx.storage.sql
      .exec<JobEventMetaRow>(
        'SELECT job_id, next_event_seq, activity_bytes FROM job_event_meta WHERE job_id = ?',
        jobId,
      )
      .toArray();
    const existing = rows[0];
    if (existing !== undefined) {
      return existing;
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO job_event_meta (job_id, next_event_seq, activity_bytes) VALUES (?, 1, 0)',
      jobId,
    );
    return { job_id: jobId, next_event_seq: 1, activity_bytes: 0 };
  }

  /** Allocates the next durable cursor for a job (monotonic, gap-inclusive). */
  private allocEventSeq(jobId: string): number {
    const meta = this.jobEventMeta(jobId);
    this.ctx.storage.sql.exec(
      'UPDATE job_event_meta SET next_event_seq = ? WHERE job_id = ?',
      meta.next_event_seq + 1,
      jobId,
    );
    return meta.next_event_seq;
  }

  /**
   * Journals a durable lifecycle event: always written, never budget-gated,
   * never coalesced on delivery. `attemptId ''` marks a job-scope row; an
   * attempt-scoped row carries the attempt's fence as `generation`.
   */
  private journalDurableEvent(input: {
    jobId: string;
    attemptId: string;
    generation: number;
    kind: DurableEventKind;
    payload: Record<string, unknown>;
  }): EventRow {
    const now = Date.now();
    const eventSeq = this.allocEventSeq(input.jobId);
    const sequence = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM events
         WHERE job_id = ? AND attempt_id = ? AND stream_id = ?`,
        input.jobId,
        input.attemptId,
        LIFECYCLE_STREAM_ID,
      )
      .one().n;
    const row: EventRow = {
      job_id: input.jobId,
      event_seq: eventSeq,
      attempt_id: input.attemptId,
      stream_id: LIFECYCLE_STREAM_ID,
      sequence,
      kind: input.kind,
      durable: 1,
      generation: input.generation,
      payload: JSON.stringify(input.payload),
      covers_through: eventSeq,
      created_at: now,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO events (
         job_id, event_seq, attempt_id, stream_id, sequence, kind, durable,
         generation, payload, covers_through, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      row.job_id,
      row.event_seq,
      row.attempt_id,
      row.stream_id,
      row.sequence,
      row.kind,
      row.generation,
      row.payload,
      row.covers_through,
      row.created_at,
    );
    this.queueDeliverable(row);
    this.bumpCounter('events_journaled', 1);
    return row;
  }

  /**
   * Journals a worker `activity` frame under the per-job intermediate
   * metadata budget. Over-budget frames still allocate a durable cursor but
   * materialize as a `gap` row — explicit loss, never a silent drop. A
   * replayed (attempt, stream, sequence) triple is a deduped no-op.
   */
  private journalActivityEvent(input: {
    jobId: string;
    attemptId: string;
    streamId: string;
    sequence: number;
    generation: number;
    payload: ActivityPayload;
  }): 'journaled' | 'dropped' | 'duplicate' {
    const now = Date.now();
    const duplicate = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM events
         WHERE job_id = ? AND attempt_id = ? AND stream_id = ? AND sequence = ?
           AND kind != 'gap'`,
        input.jobId,
        input.attemptId,
        input.streamId,
        input.sequence,
      )
      .one().n;
    if (duplicate > 0) {
      return 'duplicate';
    }
    const eventSeq = this.allocEventSeq(input.jobId);
    const payloadJson = JSON.stringify(input.payload);
    const meta = this.jobEventMeta(input.jobId);
    if (meta.activity_bytes + utf8ByteLength(payloadJson) > JOB_EVENT_BUDGET_BYTES) {
      this.recordEventGap(input, eventSeq, now);
      this.bumpCounter('events_dropped', 1);
      return 'dropped';
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO events (
         job_id, event_seq, attempt_id, stream_id, sequence, kind, durable,
         generation, payload, covers_through, created_at
       ) VALUES (?, ?, ?, ?, ?, 'activity', 0, ?, ?, ?, ?)`,
      input.jobId,
      eventSeq,
      input.attemptId,
      input.streamId,
      input.sequence,
      input.generation,
      payloadJson,
      eventSeq,
      now,
    );
    this.ctx.storage.sql.exec(
      'UPDATE job_event_meta SET activity_bytes = activity_bytes + ? WHERE job_id = ?',
      utf8ByteLength(payloadJson),
      input.jobId,
    );
    this.bumpCounter('events_journaled', 1);
    this.queueDeliverable({
      job_id: input.jobId,
      event_seq: eventSeq,
      attempt_id: input.attemptId,
      stream_id: input.streamId,
      sequence: input.sequence,
      kind: 'activity',
      durable: 0,
      generation: input.generation,
      payload: payloadJson,
      covers_through: eventSeq,
      created_at: now,
    });
    return 'journaled';
  }

  /**
   * Records a budget-dropped activity event as a `gap` row at the allocated
   * cursor. Consecutive drops on one (attempt, stream) extend the trailing
   * gap row's stream-space range instead of writing a row per drop.
   */
  private recordEventGap(
    input: { jobId: string; attemptId: string; streamId: string; sequence: number; generation: number },
    eventSeq: number,
    now: number,
  ): void {
    const prior = this.ctx.storage.sql
      .exec<EventRow>('SELECT * FROM events WHERE job_id = ? AND event_seq = ?', input.jobId, eventSeq - 1)
      .toArray()[0];
    if (
      prior !== undefined &&
      prior.kind === 'gap' &&
      prior.attempt_id === input.attemptId &&
      prior.stream_id === input.streamId &&
      prior.covers_through === eventSeq - 1
    ) {
      const payload = JSON.parse(prior.payload) as {
        attemptId: string;
        streamId: string;
        fromSequence: number;
        toSequence: number;
        droppedEvents: number;
      };
      payload.toSequence = input.sequence;
      payload.droppedEvents += 1;
      this.ctx.storage.sql.exec(
        'UPDATE events SET payload = ?, covers_through = ? WHERE job_id = ? AND event_seq = ?',
        JSON.stringify(payload),
        eventSeq,
        input.jobId,
        prior.event_seq,
      );
      this.queueDeliverable({ ...prior, payload: JSON.stringify(payload), covers_through: eventSeq });
      return;
    }
    const payload = {
      attemptId: input.attemptId,
      streamId: input.streamId,
      fromSequence: input.sequence,
      toSequence: input.sequence,
      droppedEvents: 1,
    };
    const row: EventRow = {
      job_id: input.jobId,
      event_seq: eventSeq,
      attempt_id: input.attemptId,
      stream_id: input.streamId,
      sequence: input.sequence,
      kind: 'gap',
      durable: 1,
      generation: input.generation,
      payload: JSON.stringify(payload),
      covers_through: eventSeq,
      created_at: now,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO events (
         job_id, event_seq, attempt_id, stream_id, sequence, kind, durable,
         generation, payload, covers_through, created_at
       ) VALUES (?, ?, ?, ?, ?, 'gap', 1, ?, ?, ?, ?)`,
      row.job_id,
      row.event_seq,
      row.attempt_id,
      row.stream_id,
      row.sequence,
      row.generation,
      row.payload,
      row.covers_through,
      row.created_at,
    );
    this.queueDeliverable(row);
  }

  /** Maps a journaled row to the socket frame subscribers receive. */
  private frameForEventRow(row: EventRow): SocketFrame {
    if (row.kind === 'gap') {
      const payload = JSON.parse(row.payload) as {
        streamId: string;
        fromSequence: number;
        toSequence: number;
      };
      const gap: GapFrame = {
        type: 'gap',
        version: SOCKET_FRAME_VERSION,
        id: crypto.randomUUID(),
        attemptId: row.attempt_id,
        streamId: payload.streamId,
        fromSequence: payload.fromSequence,
        toSequence: payload.toSequence,
      };
      return gap;
    }
    let payload: ActivityPayload;
    if (row.kind === 'activity') {
      payload = JSON.parse(row.payload) as ActivityPayload;
    } else {
      // Lifecycle/approval/artifact rows reach observers as `status` text.
      const text = JSON.stringify({
        type: row.kind,
        ...(JSON.parse(row.payload) as Record<string, unknown>),
      });
      payload = { kind: 'status', text, byteLength: utf8ByteLength(text), truncated: false };
    }
    const activity: ActivityFrame = {
      type: 'activity',
      version: SOCKET_FRAME_VERSION,
      id: crypto.randomUUID(),
      attemptId: row.attempt_id,
      generation: row.generation,
      streamId: row.stream_id,
      sequence: row.sequence,
      payload,
    };
    return activity;
  }

  private queueDeliverable(row: EventRow): void {
    this.eventOutbox.push({
      jobId: row.job_id,
      attemptId: row.attempt_id,
      frame: this.frameForEventRow(row),
      durable: row.kind !== 'activity',
    });
  }

  /**
   * Post-commit fan-out: each queued frame reaches every socket whose
   * attachment holds a live subscription on the event's attempt or job
   * scope. Revoked enrollments' sockets are already closed by the revoke
   * path, so attachment interest alone authorizes delivery.
   */
  private deliverQueued(frames: DeliverableFrame[]): void {
    const now = Date.now();
    const sockets = this.ctx.getWebSockets();
    const live = new Set<WebSocket>(sockets);
    for (const ws of this.deliveries.keys()) {
      if (!live.has(ws)) {
        this.deliveries.delete(ws);
      }
    }
    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment();
      if (!isSocketAttachment(attachment)) {
        continue;
      }
      const subs = attachmentSubscriptions(attachment);
      for (const deliverable of frames) {
        const interested = subs.some(
          (s) =>
            s.expiresAt > now &&
            (s.scope === deliverable.attemptId || s.scope === deliverable.jobId),
        );
        if (interested) {
          this.deliverToSocket(ws, deliverable);
        }
      }
    }
  }

  /**
   * One frame → one socket. Durable frames flush pending coalesced output
   * first to preserve order, then send immediately. Activity frames
   * coalesce per (attempt, stream, payload-kind) for the batching window.
   */
  private deliverToSocket(ws: WebSocket, deliverable: DeliverableFrame): void {
    let state = this.deliveries.get(ws);
    if (state === undefined) {
      state = { coalesced: new Map(), lagging: false, missed: new Map(), durableBacklog: [] };
      this.deliveries.set(ws, state);
    }
    if (state.lagging) {
      this.queueWhileLagging(state, deliverable);
      this.ensureFlushScheduled();
      return;
    }
    if (deliverable.durable) {
      if (state.coalesced.size > 0) {
        this.flushCoalesced(ws, state);
      }
      if (state.lagging) {
        this.queueWhileLagging(state, deliverable);
        this.ensureFlushScheduled();
        return;
      }
      if (!this.trySend(ws, deliverable.frame)) {
        state.lagging = true;
        this.queueWhileLagging(state, deliverable);
        this.ensureFlushScheduled();
      }
      return;
    }
    const frame = deliverable.frame as ActivityFrame;
    const key = `${frame.attemptId}|${frame.streamId}|${frame.payload.kind}`;
    const existing = state.coalesced.get(key);
    if (existing !== undefined) {
      const mergedBytes = utf8ByteLength(existing.frame.payload.text);
      if (mergedBytes + utf8ByteLength(frame.payload.text) > MAX_COALESCED_TEXT_BYTES) {
        // Cap reached: flush the accumulated frame, start a fresh one.
        if (this.trySend(ws, existing.frame)) {
          state.coalesced.delete(key);
        } else {
          state.lagging = true;
          this.recordMissed(state, existing);
          state.coalesced.delete(key);
          this.queueWhileLagging(state, deliverable);
          this.ensureFlushScheduled();
          return;
        }
      } else {
        existing.frame.payload.text += frame.payload.text;
        existing.frame.payload.byteLength += frame.payload.byteLength;
        existing.frame.payload.truncated =
          existing.frame.payload.truncated || frame.payload.truncated;
        existing.frame.sequence = frame.sequence;
        this.ensureFlushScheduled();
        return;
      }
    }
    state.coalesced.set(key, {
      frame: { ...frame, payload: { ...frame.payload } },
      firstSequence: frame.sequence,
    });
    this.ensureFlushScheduled();
  }

  /** Buffers a frame for a socket whose last send failed. */
  private queueWhileLagging(state: PendingDelivery, deliverable: DeliverableFrame): void {
    if (deliverable.durable) {
      if (state.durableBacklog.length >= OBSERVER_DURABLE_BACKLOG_MAX) {
        return; // hopeless observer; the close path drops it
      }
      state.durableBacklog.push(deliverable.frame);
      return;
    }
    this.recordMissedFrame(state, deliverable.frame as ActivityFrame);
  }

  private recordMissed(
    state: PendingDelivery,
    entry: { frame: ActivityFrame; firstSequence: number },
  ): void {
    const frame = entry.frame;
    const key = `${frame.attemptId}|${frame.streamId}`;
    const missed = state.missed.get(key);
    if (missed !== undefined) {
      missed.from = Math.min(missed.from, entry.firstSequence);
      missed.to = Math.max(missed.to, frame.sequence);
    } else {
      state.missed.set(key, {
        attemptId: frame.attemptId,
        streamId: frame.streamId,
        from: entry.firstSequence,
        to: frame.sequence,
      });
    }
  }

  private recordMissedFrame(state: PendingDelivery, frame: ActivityFrame): void {
    const key = `${frame.attemptId}|${frame.streamId}`;
    const missed = state.missed.get(key);
    if (missed !== undefined) {
      missed.to = Math.max(missed.to, frame.sequence);
    } else {
      state.missed.set(key, {
        attemptId: frame.attemptId,
        streamId: frame.streamId,
        from: frame.sequence,
        to: frame.sequence,
      });
    }
  }

  /** Sends all pending coalesced frames for a socket; failures mark it lagging. */
  private flushCoalesced(ws: WebSocket, state: PendingDelivery): void {
    for (const [key, entry] of state.coalesced) {
      if (this.trySend(ws, entry.frame)) {
        state.coalesced.delete(key);
        continue;
      }
      state.lagging = true;
      this.recordMissed(state, entry);
      state.coalesced.delete(key);
      for (const [, rest] of state.coalesced) {
        this.recordMissed(state, rest);
      }
      state.coalesced.clear();
      return;
    }
  }

  /**
   * Schedules the coalescing flush (spec §10 batching window). If the DO was
   * hibernated past the due time the next deliverable flushes inline, so a
   * lost timer can never strand pending frames.
   */
  private ensureFlushScheduled(): void {
    if (this.flushTimerPending) {
      if (Date.now() >= this.flushDueAt + ACTIVITY_COALESCE_MS) {
        this.flushTimerPending = false;
        this.flushDeliveries();
      }
      return;
    }
    this.flushTimerPending = true;
    this.flushDueAt = Date.now() + ACTIVITY_COALESCE_MS;
    try {
      setTimeout(() => {
        this.flushTimerPending = false;
        this.flushDeliveries();
      }, ACTIVITY_COALESCE_MS);
    } catch {
      this.flushTimerPending = false;
      this.flushDeliveries();
    }
  }

  /**
   * Flush pass over live sockets. Lagging sockets first retry their durable
   * backlog behind gap frames describing the missed stream ranges; a socket
   * that still cannot send stays lagging (bounded backlog, then dropped).
   */
  private flushDeliveries(): void {
    const live = new Set<WebSocket>(this.ctx.getWebSockets());
    for (const [ws, state] of this.deliveries) {
      if (!live.has(ws)) {
        this.deliveries.delete(ws);
        continue;
      }
      if (state.lagging) {
        const recovery: SocketFrame[] = [...state.missed.values()].map((m) => {
          const gap: GapFrame = {
            type: 'gap',
            version: SOCKET_FRAME_VERSION,
            id: crypto.randomUUID(),
            attemptId: m.attemptId,
            streamId: m.streamId,
            fromSequence: m.from,
            toSequence: m.to,
          };
          return gap;
        });
        recovery.push(...state.durableBacklog);
        let recovered = true;
        for (const frame of recovery) {
          if (!this.trySend(ws, frame)) {
            recovered = false;
            break;
          }
        }
        if (recovered) {
          state.missed.clear();
          state.durableBacklog = [];
          state.lagging = false;
        } else if (state.durableBacklog.length > OBSERVER_DURABLE_BACKLOG_MAX) {
          this.deliveries.delete(ws);
          try {
            ws.close(1008, 'observer backlog');
          } catch {
            // already closed
          }
          continue;
        }
      }
      if (!state.lagging) {
        this.flushCoalesced(ws, state);
      }
    }
    let pending = false;
    for (const [, state] of this.deliveries) {
      if (state.lagging || state.coalesced.size > 0) {
        pending = true;
        break;
      }
    }
    if (pending && !this.flushTimerPending) {
      this.flushTimerPending = true;
      this.flushDueAt = Date.now() + ACTIVITY_COALESCE_MS;
      try {
        setTimeout(() => {
          this.flushTimerPending = false;
          this.flushDeliveries();
        }, ACTIVITY_COALESCE_MS);
      } catch {
        this.flushTimerPending = false;
      }
    }
  }

  /**
   * Bounded replay after the durable cursor on (re)subscribe. A cursor
   * inside a dropped range produces gap frames first; history deeper than
   * the replay window collapses into per-stream gap frames before the live
   * tail (deeper history is always available via event.pull).
   */
  private replaySubscription(
    ws: WebSocket,
    jobId: string,
    attemptId: string,
    after: number,
  ): void {
    const covered = (
      attemptId === ''
        ? this.ctx.storage.sql.exec<EventRow>(
            `SELECT * FROM events WHERE job_id = ? AND kind = 'gap'
               AND event_seq <= ? AND covers_through > ? ORDER BY event_seq`,
            jobId,
            after,
            after,
          )
        : this.ctx.storage.sql.exec<EventRow>(
            `SELECT * FROM events WHERE job_id = ? AND attempt_id = ? AND kind = 'gap'
               AND event_seq <= ? AND covers_through > ? ORDER BY event_seq`,
            jobId,
            attemptId,
            after,
            after,
          )
    ).toArray();
    for (const row of covered) {
      this.trySend(ws, this.frameForEventRow(row));
    }
    const rows = (
      attemptId === ''
        ? this.ctx.storage.sql.exec<EventRow>(
            `SELECT * FROM events WHERE job_id = ? AND event_seq > ?
             ORDER BY event_seq LIMIT ?`,
            jobId,
            after,
            SUBSCRIBE_REPLAY_READ,
          )
        : this.ctx.storage.sql.exec<EventRow>(
            `SELECT * FROM events WHERE job_id = ? AND attempt_id = ? AND event_seq > ?
             ORDER BY event_seq LIMIT ?`,
            jobId,
            attemptId,
            after,
            SUBSCRIBE_REPLAY_READ,
          )
    ).toArray();
    let window = rows;
    if (rows.length > SUBSCRIBE_REPLAY_SEND) {
      const skipped = rows.slice(0, rows.length - SUBSCRIBE_REPLAY_SEND);
      window = rows.slice(rows.length - SUBSCRIBE_REPLAY_SEND);
      const ranges = new Map<string, { attemptId: string; streamId: string; from: number; to: number }>();
      for (const row of skipped) {
        const key = `${row.attempt_id}|${row.stream_id}`;
        const range =
          ranges.get(key) ??
          ({ attemptId: row.attempt_id, streamId: row.stream_id, from: row.sequence, to: row.sequence } as {
            attemptId: string;
            streamId: string;
            from: number;
            to: number;
          });
        range.from = Math.min(range.from, row.sequence);
        range.to = Math.max(range.to, row.sequence);
        if (row.kind === 'gap') {
          const payload = JSON.parse(row.payload) as { toSequence: number };
          range.to = Math.max(range.to, payload.toSequence);
        }
        ranges.set(key, range);
      }
      for (const range of ranges.values()) {
        const gap: GapFrame = {
          type: 'gap',
          version: SOCKET_FRAME_VERSION,
          id: crypto.randomUUID(),
          attemptId: range.attemptId,
          streamId: range.streamId,
          fromSequence: range.from,
          toSequence: range.to,
        };
        this.trySend(ws, gap);
      }
    }
    for (const row of window) {
      this.trySend(ws, this.frameForEventRow(row));
    }
  }

  /** Resolves a pull/subscribe scope id to its owning job (account-checked). */
  private resolveEventScope(
    scope: string,
    accountId: string,
  ): { jobId: string; attemptId: string } {
    const job = this.readJob(scope);
    if (job !== null) {
      if (job.account_id !== accountId) {
        throw new RpcFailure('not-found', { reason: 'scope' });
      }
      return { jobId: job.job_id, attemptId: '' };
    }
    const attempt = this.readAttempt(scope);
    if (attempt === null) {
      throw new RpcFailure('not-found', { reason: 'scope' });
    }
    const owner = this.readJobRequired(attempt.job_id);
    if (owner.account_id !== accountId) {
      throw new RpcFailure('not-found', { reason: 'scope' });
    }
    return { jobId: attempt.job_id, attemptId: attempt.attempt_id };
  }

  private eventView(row: EventRow): DurableEvent {
    if (!isDurableEventKind(row.kind)) {
      throw new RpcFailure('unavailable', { reason: 'corrupt-event-kind' });
    }
    return {
      cursor: row.event_seq,
      jobId: row.job_id,
      ...(row.attempt_id === '' ? {} : { attemptId: row.attempt_id }),
      streamId: row.stream_id,
      sequence: row.sequence,
      kind: row.kind,
      generation: row.generation,
      payload: JSON.parse(row.payload) as unknown,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  /**
   * `event.pull`: ordered durable events after a cursor for a job or attempt
   * scope. `nextCursor` resumes; `hasGap` reports dropped intermediate
   * events covered by the window — either `gap` rows inside it or a gap row
   * whose coverage reaches past `afterSequence`.
   */
  private handleEventPull(auth: SpikeAuth, requestId: string, params: unknown): Response {
    const pull = parseEventPullParams(params);
    const now = Date.now();
    const result = this.commit((): EventPullResult => {
      const resolved = this.resolveEventScope(pull.scope, auth.accountId);
      // Reads enforce pending-approval expiry lazily so pulled history
      // reflects it (same model as queue-deadline expiry on job reads).
      this.expireJobApprovals(resolved.jobId, now);
      const rows = (
        resolved.attemptId === ''
          ? this.ctx.storage.sql.exec<EventRow>(
              `SELECT * FROM events WHERE job_id = ? AND event_seq > ?
               ORDER BY event_seq LIMIT ?`,
              resolved.jobId,
              pull.after,
              pull.limit + 1,
            )
          : this.ctx.storage.sql.exec<EventRow>(
              `SELECT * FROM events WHERE job_id = ? AND attempt_id = ? AND event_seq > ?
               ORDER BY event_seq LIMIT ?`,
              resolved.jobId,
              resolved.attemptId,
              pull.after,
              pull.limit + 1,
            )
      ).toArray();
      const hasMore = rows.length > pull.limit;
      const window = hasMore ? rows.slice(0, pull.limit) : rows;
      const nextCursor =
        window.length > 0 ? (window[window.length - 1] as EventRow).event_seq : pull.after;
      const covered =
        resolved.attemptId === ''
          ? this.ctx.storage.sql
              .exec<{ n: number }>(
                `SELECT COUNT(*) AS n FROM events WHERE job_id = ? AND kind = 'gap'
                   AND event_seq <= ? AND covers_through > ?`,
                resolved.jobId,
                pull.after,
                pull.after,
              )
              .one().n
          : this.ctx.storage.sql
              .exec<{ n: number }>(
                `SELECT COUNT(*) AS n FROM events WHERE job_id = ? AND attempt_id = ?
                   AND kind = 'gap' AND event_seq <= ? AND covers_through > ?`,
                resolved.jobId,
                resolved.attemptId,
                pull.after,
                pull.after,
              )
              .one().n;
      const hasGap = covered > 0 || window.some((row) => row.kind === 'gap');
      this.bumpCounter('event_pulls', 1);
      return {
        scopeKind: resolved.attemptId === '' ? 'job' : 'attempt',
        scopeId: pull.scope,
        jobId: resolved.jobId,
        events: window.map((row) => this.eventView(row)),
        nextCursor,
        hasMore,
        hasGap,
      };
    });
    return rpcSuccessResponse(requestId, result);
  }

  // ---- MESH-03 durable approvals ------------------------------------------
  // An approval is an expiring durable request bound to an attempt, an action
  // digest, the attempt fence (generation), and a permitted approver. A
  // decision resolves only the pending request: it never loosens the target's
  // local execution policy. Approved resumes `awaiting-approval → running`;
  // denied fails the attempt and the job. Stale fences cancel the request.

  private readApproval(approvalId: string): ApprovalRow | null {
    const rows = this.ctx.storage.sql
      .exec<ApprovalRow>('SELECT * FROM approvals WHERE approval_id = ?', approvalId)
      .toArray();
    return rows[0] ?? null;
  }

  private readPendingApproval(attemptId: string): ApprovalRow | null {
    const rows = this.ctx.storage.sql
      .exec<ApprovalRow>(
        "SELECT * FROM approvals WHERE attempt_id = ? AND state = 'pending'",
        attemptId,
      )
      .toArray();
    return rows[0] ?? null;
  }

  private setApprovalState(
    row: ApprovalRow,
    target: ApprovalState,
    now: number,
    decidedBy: string | null,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE approvals SET state = ?, decided_by = ?, decided_at = ?
       WHERE approval_id = ?`,
      target,
      decidedBy,
      now,
      row.approval_id,
    );
    row.state = target;
    row.decided_by = decidedBy;
    row.decided_at = now;
  }

  /**
   * Lazily expires one pending approval past its deadline. Returns the row
   * (possibly updated); journaled as `approval.decided{outcome:'expired'}`.
   */
  private expireApprovalIfDue(row: ApprovalRow, now: number): ApprovalRow {
    if (row.state === 'pending' && row.expires_at <= now) {
      this.setApprovalState(row, 'expired', now, null);
      this.journalDurableEvent({
        jobId: row.job_id,
        attemptId: row.attempt_id,
        generation: row.generation,
        kind: 'approval.decided',
        payload: { approvalId: row.approval_id, outcome: 'expired' },
      });
    }
    return row;
  }

  /** Bounded lazy expiry of pending approvals for one job (reads + sweep). */
  private expireJobApprovals(jobId: string, now: number): number {
    const due = this.ctx.storage.sql
      .exec<ApprovalRow>(
        "SELECT * FROM approvals WHERE job_id = ? AND state = 'pending' AND expires_at <= ? LIMIT ?",
        jobId,
        now,
        SWEEP_BATCH_ROWS,
      )
      .toArray();
    for (const row of due) {
      this.expireApprovalIfDue(row, now);
    }
    if (due.length > 0) {
      this.bumpCounter('sweep_approvals_expired', due.length);
    }
    return due.length;
  }

  /**
   * Cancels still-pending approvals for a job — the request can no longer be
   * satisfied (job left `awaiting-approval`). `exceptApprovalId` spares the
   * approval currently being decided.
   */
  private cancelPendingApprovals(jobId: string, now: number, exceptApprovalId?: string): number {
    const pending = this.ctx.storage.sql
      .exec<ApprovalRow>(
        "SELECT * FROM approvals WHERE job_id = ? AND state = 'pending' LIMIT ?",
        jobId,
        SWEEP_BATCH_ROWS,
      )
      .toArray();
    let cancelled = 0;
    for (const row of pending) {
      if (row.approval_id === exceptApprovalId) {
        continue;
      }
      this.setApprovalState(row, 'cancelled', now, null);
      this.journalDurableEvent({
        jobId: row.job_id,
        attemptId: row.attempt_id,
        generation: row.generation,
        kind: 'approval.decided',
        payload: { approvalId: row.approval_id, outcome: 'cancelled' },
      });
      cancelled += 1;
    }
    if (cancelled > 0) {
      this.bumpCounter('approvals_cancelled', cancelled);
    }
    return cancelled;
  }

  private approvalView(row: ApprovalRow): ApprovalRecord {
    if (!isApprovalState(row.state)) {
      throw new RpcFailure('unavailable', { reason: 'corrupt-approval-state' });
    }
    return {
      id: row.approval_id,
      jobId: row.job_id,
      attemptId: row.attempt_id,
      actionDigest: row.action_digest,
      generation: row.generation,
      ...(row.approver_enrollment_id === null
        ? {}
        : { approverEnrollmentId: row.approver_enrollment_id }),
      approverRole: 'user',
      state: row.state,
      ...(row.decided_by === null ? {} : { decidedBy: row.decided_by }),
      ...(row.decided_at === null
        ? {}
        : { decidedAt: new Date(row.decided_at).toISOString() }),
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  /**
   * `approval.get` (either actor): fetch by approvalId or list by
   * jobId/attemptId — exactly one selector. Pending approvals past their
   * deadline expire lazily on read so callers never act on a stale request.
   */
  private handleApprovalGet(auth: SpikeAuth, requestId: string, params: unknown): Response {
    const selector = parseApprovalGetParams(params);
    const now = Date.now();
    const result = this.commit((): ApprovalGetResult => {
      let rows: ApprovalRow[];
      if (selector.approvalId !== undefined) {
        const row = this.readApproval(selector.approvalId);
        if (row === null || row.account_id !== auth.accountId) {
          throw new RpcFailure('not-found', { reason: 'approval' });
        }
        rows = [row];
      } else if (selector.jobId !== undefined) {
        const job = this.readJob(selector.jobId);
        if (job === null || job.account_id !== auth.accountId) {
          throw new RpcFailure('not-found', { reason: 'job' });
        }
        this.expireJobApprovals(job.job_id, now);
        rows = this.ctx.storage.sql
          .exec<ApprovalRow>(
            'SELECT * FROM approvals WHERE job_id = ? ORDER BY created_at ASC',
            selector.jobId,
          )
          .toArray();
      } else {
        const attempt = this.readAttempt(selector.attemptId as string);
        if (attempt === null) {
          throw new RpcFailure('not-found', { reason: 'attempt' });
        }
        const job = this.readJobRequired(attempt.job_id);
        if (job.account_id !== auth.accountId) {
          throw new RpcFailure('not-found', { reason: 'attempt' });
        }
        this.expireJobApprovals(attempt.job_id, now);
        rows = this.ctx.storage.sql
          .exec<ApprovalRow>(
            'SELECT * FROM approvals WHERE attempt_id = ? ORDER BY created_at ASC',
            selector.attemptId,
          )
          .toArray();
      }
      const approvals = rows
        .filter((row) => row.account_id === auth.accountId)
        .map((row) => this.approvalView(this.expireApprovalIfDue(row, now)));
      this.bumpCounter('approval_gets', 1);
      return { approvals };
    });
    return rpcSuccessResponse(requestId, result);
  }

  /**
   * `approval.decide` (user actor): resolves a pending request. The
   * executing worker can never decide its own attempt's approval, and a
   * pinned `approverEnrollmentId` admits only that enrollment. An identical
   * stored decision replays idempotently (`duplicate: true`); a conflicting
   * decision on a decided request is a typed conflict. Stale fences and
   * moved-on jobs cancel the request instead of deciding it.
   */
  private handleApprovalDecide(auth: SpikeAuth, requestId: string, params: unknown): Response {
    const decide = parseApprovalDecideParams(params);
    const now = Date.now();
    // The commit may resolve the request by cancelling/expiring it instead of
    // deciding — those state changes MUST persist, so the transaction returns
    // the rejection and the typed error throws only after it commits.
    const result = this.commit(
      (): { ok: true; result: ApprovalDecideResult } | { ok: false; failure: RpcFailure } => {
        const approval = this.readApproval(decide.approvalId);
        if (approval === null || approval.account_id !== auth.accountId) {
          throw new RpcFailure('not-found', { reason: 'approval' });
        }
        const job = this.readJobRequired(approval.job_id);
        const attempt = this.readAttemptRequired(approval.attempt_id);
        if (approval.state === decide.decision) {
          // Identical replay: idempotent, nothing changes.
          this.bumpCounter('approval_decides', 1);
          return {
            ok: true,
            result: {
              approval: this.approvalView(approval),
              job: this.jobSummary(job),
              duplicate: true,
            },
          };
        }
        if (approval.state !== 'pending') {
          throw new RpcFailure('conflict', {
            reason: 'approval-already-decided',
            state: approval.state,
          });
        }
        if (approval.expires_at <= now) {
          this.expireApprovalIfDue(approval, now);
          return {
            ok: false,
            failure: new RpcFailure('conflict', { reason: 'approval-expired' }),
          };
        }
        if (attempt.fence !== approval.generation) {
          this.setApprovalState(approval, 'cancelled', now, null);
          this.journalDurableEvent({
            jobId: approval.job_id,
            attemptId: approval.attempt_id,
            generation: approval.generation,
            kind: 'approval.decided',
            payload: { approvalId: approval.approval_id, outcome: 'cancelled', reason: 'stale-generation' },
          });
          return {
            ok: false,
            failure: new RpcFailure('stale-generation', {
              expected: attempt.fence,
              actual: approval.generation,
            }),
          };
        }
        if (auth.enrollmentId === attempt.worker_enrollment_id) {
          throw new RpcFailure('forbidden', { reason: 'worker-cannot-decide' });
        }
        if (
          approval.approver_enrollment_id !== null &&
          approval.approver_enrollment_id !== auth.enrollmentId
        ) {
          throw new RpcFailure('forbidden', { reason: 'not-permitted-approver' });
        }
        if (job.state !== 'awaiting-approval') {
          this.setApprovalState(approval, 'cancelled', now, null);
          this.journalDurableEvent({
            jobId: approval.job_id,
            attemptId: approval.attempt_id,
            generation: approval.generation,
            kind: 'approval.decided',
            payload: { approvalId: approval.approval_id, outcome: 'cancelled', reason: 'job-not-awaiting-approval' },
          });
          return {
            ok: false,
            failure: new RpcFailure('conflict', {
              reason: 'job-not-awaiting-approval',
              state: job.state,
            }),
          };
        }
        this.setApprovalState(approval, decide.decision, now, auth.enrollmentId);
        this.journalDurableEvent({
          jobId: approval.job_id,
          attemptId: approval.attempt_id,
          generation: approval.generation,
          kind: 'approval.decided',
          payload: {
            approvalId: approval.approval_id,
            decision: decide.decision,
            decidedBy: auth.enrollmentId,
            ...(decide.reason === undefined ? {} : { reason: decide.reason }),
          },
        });
        if (decide.decision === 'approved') {
          this.setJobState(job, 'running', now, { stateReason: 'approval-granted' });
        } else {
          if (isActiveAttemptState(attempt.state)) {
            this.setAttemptState(attempt, 'failed', now);
          }
          this.setJobState(job, 'failed', now, {
            stateReason: 'approval-denied',
            activeAttemptId: null,
          });
        }
        // The pending request is resolved; any other pendings for this job lapse.
        this.cancelPendingApprovals(job.job_id, now, approval.approval_id);
        this.bumpCounter('approval_decides', 1);
        return {
          ok: true,
          result: {
            approval: this.approvalView(this.readApproval(approval.approval_id) as ApprovalRow),
            job: this.jobSummary(this.readJobRequired(job.job_id)),
            duplicate: false,
          },
        };
      },
    );
    if (!result.ok) {
      throw result.failure;
    }
    return rpcSuccessResponse(requestId, result.result);
  }

  // ---- MESH-03 artifacts ---------------------------------------------------
  // The artifacts row is the state authority; the R2 object at r2_key is
  // reconciled against it. Uploads land on the PUT byte route under a
  // reservation (streamed, byte-capped); finalize verifies size + sha256 of
  // the stored object before publishing. There is deliberately no SQL/R2
  // atomicity — recovery reconciles orphaned/deleting rows idempotently.

  private readArtifact(artifactId: string): ArtifactRow | null {
    const rows = this.ctx.storage.sql
      .exec<ArtifactRow>('SELECT * FROM artifacts WHERE artifact_id = ?', artifactId)
      .toArray();
    return rows[0] ?? null;
  }

  private readArtifactRequired(artifactId: string): ArtifactRow {
    const row = this.readArtifact(artifactId);
    if (row === null) {
      throw new RpcFailure('unavailable', { reason: 'corrupt-artifact' });
    }
    return row;
  }

  private setArtifactState(
    row: ArtifactRow,
    target: ArtifactState,
    now: number,
    extras?: { publishedAt?: number | null; expiresAt?: number | null; deletedAt?: number | null },
  ): void {
    if (!isArtifactState(row.state) || !canTransitionArtifact(row.state, target)) {
      throw new RpcFailure('unavailable', {
        reason: 'illegal-artifact-transition',
        from: row.state,
        to: target,
      });
    }
    const publishedAt = extras?.publishedAt !== undefined ? extras.publishedAt : row.published_at;
    const expiresAt = extras?.expiresAt !== undefined ? extras.expiresAt : row.expires_at;
    const deletedAt = extras?.deletedAt !== undefined ? extras.deletedAt : row.deleted_at;
    this.ctx.storage.sql.exec(
      `UPDATE artifacts SET state = ?, updated_at = ?, published_at = ?, expires_at = ?,
         deleted_at = ?
       WHERE artifact_id = ?`,
      target,
      now,
      publishedAt,
      expiresAt,
      deletedAt,
      row.artifact_id,
    );
    row.state = target;
    row.updated_at = now;
    row.published_at = publishedAt;
    row.expires_at = expiresAt;
    row.deleted_at = deletedAt;
  }

  /**
   * Retention expiry for one artifact row: `published`/`uploaded` past their
   * retention deadline become `expired` (journaled) and their R2 object is
   * queued for post-commit deletion. Reserved rows lapse via the orphan
   * sweep instead (upload window, not retention).
   */
  private expireArtifactIfDue(row: ArtifactRow, now: number): ArtifactRow {
    if (
      (row.state === 'published' || row.state === 'uploaded') &&
      row.expires_at !== null &&
      row.expires_at <= now
    ) {
      this.setArtifactState(row, 'expired', now);
      this.journalDurableEvent({
        jobId: row.job_id,
        attemptId: row.attempt_id,
        generation: this.readAttempt(row.attempt_id)?.fence ?? 0,
        kind: 'artifact.expired',
        payload: { artifactId: row.artifact_id },
      });
      this.pendingR2Deletes.push(row.r2_key);
      this.bumpCounter('sweep_artifacts_expired', 1);
    }
    return row;
  }

  private artifactManifest(row: ArtifactRow): ArtifactManifest {
    if (!isArtifactState(row.state)) {
      throw new RpcFailure('unavailable', { reason: 'corrupt-artifact-state' });
    }
    return {
      id: row.artifact_id,
      attemptId: row.attempt_id,
      byteLength: row.byte_length,
      sha256: row.sha256,
      mediaType: row.media_type,
      retentionDays: row.retention_days,
      state: row.state,
    };
  }

  private artifactDescriptor(row: ArtifactRow): ArtifactDescriptor {
    return {
      ...this.artifactManifest(row),
      jobId: row.job_id,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      publishedAt: row.published_at === null ? null : new Date(row.published_at).toISOString(),
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    };
  }

  /**
   * Asserts the attempt's worker identity for artifact operations (reserve,
   * finalize, byte upload): the caller's worker record must be unrevoked and
   * hold the attempt's pinned incarnation, and the attempt must be active.
   */
  private requireArtifactOwner(
    auth: SpikeAuth,
    worker: WorkerRow,
    artifact: ArtifactRow,
    now: number,
  ): AttemptRow {
    const attempt = this.readAttemptRequired(artifact.attempt_id);
    const job = this.readJobRequired(artifact.job_id);
    if (job.account_id !== auth.accountId) {
      throw new RpcFailure('not-found', { reason: 'artifact' });
    }
    if (attempt.worker_enrollment_id !== auth.enrollmentId) {
      throw new RpcFailure('forbidden', { reason: 'not-attempt-owner' });
    }
    if (
      worker.incarnation === null ||
      worker.incarnation !== attempt.worker_incarnation ||
      !isLeaseLive(worker, now)
    ) {
      throw new RpcFailure('forbidden', { reason: 'stale-incarnation' });
    }
    return attempt;
  }

  /**
   * `artifact.reserve` (worker actor): a byte-length + sha256 reservation
   * under per-artifact and per-account quotas. Returns the bounded upload
   * route and its expiry; the R2 key is `accountId/artifactId`, private to
   * the backend.
   */
  private handleArtifactReserve(auth: SpikeAuth, requestId: string, params: unknown): Response {
    const { row: worker } = this.requireWorker(auth);
    const reserve = parseArtifactReserveParams(params);
    const now = Date.now();
    const result = this.commit((): ArtifactReserveResult => {
      this.requireLiveIncarnation(worker, now);
      const attempt = this.readAttempt(reserve.attemptId);
      if (attempt === null) {
        throw new RpcFailure('not-found', { reason: 'attempt' });
      }
      const job = this.readJobRequired(attempt.job_id);
      if (job.account_id !== auth.accountId) {
        throw new RpcFailure('not-found', { reason: 'attempt' });
      }
      if (attempt.worker_enrollment_id !== auth.enrollmentId) {
        throw new RpcFailure('forbidden', { reason: 'not-attempt-owner' });
      }
      if (
        worker.incarnation === null ||
        worker.incarnation !== attempt.worker_incarnation
      ) {
        throw new RpcFailure('forbidden', { reason: 'stale-incarnation' });
      }
      if (!isActiveAttemptState(attempt.state)) {
        throw new RpcFailure('conflict', { reason: 'attempt-terminal' });
      }
      const used = this.ctx.storage.sql
        .exec<{ total: number | null }>(
          `SELECT COALESCE(SUM(byte_length), 0) AS total FROM artifacts
           WHERE account_id = ? AND state NOT IN ('deleted', 'expired')`,
          auth.accountId,
        )
        .one().total ?? 0;
      if (used + reserve.byteLength > ACCOUNT_ARTIFACT_MAX_BYTES) {
        throw new RpcFailure('quota-exceeded', {
          reason: 'account-artifact-bytes',
          limitBytes: ACCOUNT_ARTIFACT_MAX_BYTES,
          usedBytes: used,
        });
      }
      const artifactId = crypto.randomUUID();
      const uploadExpiresAt = now + ARTIFACT_UPLOAD_TTL_MS;
      this.ctx.storage.sql.exec(
        `INSERT INTO artifacts (
           artifact_id, account_id, job_id, attempt_id, byte_length, sha256,
           media_type, retention_days, state, r2_key, upload_expires_at,
           created_at, updated_at, published_at, expires_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, NULL, NULL, NULL)`,
        artifactId,
        auth.accountId,
        job.job_id,
        attempt.attempt_id,
        reserve.byteLength,
        reserve.sha256,
        reserve.mediaType,
        reserve.retentionDays,
        `${auth.accountId}/${artifactId}`,
        uploadExpiresAt,
        now,
        now,
      );
      this.journalDurableEvent({
        jobId: job.job_id,
        attemptId: attempt.attempt_id,
        generation: attempt.fence,
        kind: 'artifact.reserved',
        payload: {
          artifactId,
          byteLength: reserve.byteLength,
          sha256: reserve.sha256,
          mediaType: reserve.mediaType,
          retentionDays: reserve.retentionDays,
          expiresAt: new Date(uploadExpiresAt).toISOString(),
        },
      });
      this.bumpCounter('artifact_reserves', 1);
      return {
        artifactId,
        uploadPath: `/v1/artifacts/${artifactId}`,
        expiresAt: new Date(uploadExpiresAt).toISOString(),
      };
    });
    return rpcSuccessResponse(requestId, result);
  }

  /**
   * Streams a reservation's bytes into R2. The reservation declares an exact
   * byte length, so the upload must too: `content-length` must equal the
   * reservation, which lets the request body stream straight into R2 (a
   * transformed stream has no known length and workerd's R2 rejects it). The
   * stored object's size is verified again after the write — a mismatch
   * deletes the object and rejects.
   */
  private async handleArtifactUpload(request: Request, artifactId: string): Promise<Response> {
    const auth = this.identityOf(request);
    if (auth === null) {
      return rpcErrorResponse(undefined, 'unauthenticated');
    }
    const now = Date.now();
    let artifact: ArtifactRow;
    try {
      artifact = this.commit((): ArtifactRow => {
        const row = this.readArtifact(artifactId);
        if (row === null || row.account_id !== auth.accountId) {
          throw new RpcFailure('not-found', { reason: 'artifact' });
        }
        const worker = this.readWorker(auth.enrollmentId);
        if (worker === null || worker.revoked_at !== null) {
          throw new RpcFailure('forbidden', { reason: 'worker-revoked' });
        }
        this.requireArtifactOwner(auth, worker, row, now);
        if (row.state !== 'reserved') {
          throw new RpcFailure('conflict', {
            reason: 'artifact-not-reserved',
            state: row.state,
          });
        }
        if (row.upload_expires_at <= now) {
          throw new RpcFailure('conflict', { reason: 'reservation-expired' });
        }
        const declared = Number(request.headers.get('content-length') ?? 'NaN');
        if (!Number.isFinite(declared)) {
          throw new RpcFailure('malformed-request', { reason: 'content-length' });
        }
        if (declared !== row.byte_length) {
          throw new RpcFailure('conflict', {
            reason: 'size-mismatch',
            expected: row.byte_length,
            actual: declared,
          });
        }
        return row;
      });
    } catch (error) {
      if (isRpcFailure(error)) {
        return failureResponse(undefined, error);
      }
      return rpcErrorResponse(undefined, 'unavailable');
    }
    if (request.body === null) {
      return rpcErrorResponse(undefined, 'malformed-request', { reason: 'body' });
    }
    let stored: R2Object;
    try {
      stored = await this.env.ARTIFACTS.put(artifact.r2_key, request.body, {
        httpMetadata: { contentType: artifact.media_type },
      });
    } catch {
      await this.env.ARTIFACTS.delete(artifact.r2_key).catch(() => undefined);
      return rpcErrorResponse(undefined, 'unavailable', { reason: 'artifact-upload-failed' });
    }
    if (stored.size !== artifact.byte_length) {
      await this.env.ARTIFACTS.delete(artifact.r2_key).catch(() => undefined);
      return rpcErrorResponse(undefined, 'conflict', {
        reason: 'size-mismatch',
        expected: artifact.byte_length,
        actual: stored.size,
      });
    }
    this.commit((): void => {
      const fresh = this.readArtifact(artifactId);
      if (fresh !== null && fresh.state === 'reserved') {
        this.setArtifactState(fresh, 'uploaded', Date.now());
      }
    });
    this.bumpCounter('artifact_uploads', 1);
    return Response.json({ artifactId, byteLength: stored.size, state: 'uploaded' });
  }

  /**
   * `artifact.finalize` (worker actor): verifies the stored R2 object
   * against the reservation (exists, exact size, sha256) and publishes.
   * A failed verification discards the object and deletes the row —
   * mismatched bytes are never published. `finalize` also accepts a
   * `reserved` row whose bytes were verified out of band.
   */
  private async handleArtifactFinalize(
    auth: SpikeAuth,
    requestId: string,
    params: unknown,
  ): Promise<Response> {
    const { row: worker } = this.requireWorker(auth);
    const finalize = parseArtifactFinalizeParams(params);
    const now = Date.now();
    const artifact = this.commit((): ArtifactRow => {
      this.requireLiveIncarnation(worker, now);
      const row = this.readArtifact(finalize.artifactId);
      if (row === null || row.account_id !== auth.accountId) {
        throw new RpcFailure('not-found', { reason: 'artifact' });
      }
      this.requireArtifactOwner(auth, worker, row, now);
      if (row.state !== 'reserved' && row.state !== 'uploaded') {
        throw new RpcFailure('conflict', { reason: 'artifact-state', state: row.state });
      }
      if (finalize.byteLength !== row.byte_length || finalize.sha256 !== row.sha256) {
        throw new RpcFailure('conflict', { reason: 'manifest-mismatch' });
      }
      return row;
    });
    const probe = await this.readArtifactObjectDigest(artifact.r2_key);
    if (probe === null) {
      throw new RpcFailure('conflict', { reason: 'artifact-not-uploaded' });
    }
    if (probe.size !== artifact.byte_length || probe.sha256 !== artifact.sha256) {
      await this.discardArtifact(
        artifact.artifact_id,
        'verify-mismatch',
        auth.enrollmentId,
      );
      throw new RpcFailure('conflict', {
        reason: 'checksum-mismatch',
        expectedBytes: artifact.byte_length,
        actualBytes: probe.size,
      });
    }
    const result = this.commit((): { manifest: ArtifactManifest } => {
      const fresh = this.readArtifactRequired(finalize.artifactId);
      if (fresh.state !== 'reserved' && fresh.state !== 'uploaded') {
        throw new RpcFailure('conflict', { reason: 'artifact-state', state: fresh.state });
      }
      // reserved → uploaded → published is the legal path; both hops land in
      // one transaction so a reserved row publishes in a single call.
      if (fresh.state === 'reserved') {
        this.setArtifactState(fresh, 'uploaded', now);
      }
      this.setArtifactState(fresh, 'published', now, {
        publishedAt: now,
        expiresAt: now + fresh.retention_days * DAY_MS,
      });
      this.journalDurableEvent({
        jobId: fresh.job_id,
        attemptId: fresh.attempt_id,
        generation: this.readAttempt(fresh.attempt_id)?.fence ?? 0,
        kind: 'artifact.published',
        payload: {
          artifactId: fresh.artifact_id,
          byteLength: fresh.byte_length,
          sha256: fresh.sha256,
          mediaType: fresh.media_type,
          expiresAt: new Date(fresh.expires_at as number).toISOString(),
        },
      });
      this.bumpCounter('artifact_finalizes', 1);
      return { manifest: this.artifactManifest(fresh) };
    });
    return rpcSuccessResponse(requestId, result);
  }

  /**
   * Failed-verification / user-delete discard path: row → `deleting`, object
   * deleted outside the transaction, row → `deleted` (journaled). Idempotent
   * — an already-terminal row is left as-is.
   */
  private async discardArtifact(
    artifactId: string,
    reason: string,
    actorEnrollmentId: string,
  ): Promise<void> {
    const now = Date.now();
    const r2Key = this.commit((): string | null => {
      const row = this.readArtifactRequired(artifactId);
      if (row.state === 'deleted' || row.state === 'expired') {
        return null;
      }
      if (row.state !== 'deleting') {
        if (!isArtifactState(row.state) || !canTransitionArtifact(row.state, 'deleting')) {
          throw new RpcFailure('conflict', { reason: 'artifact-state', state: row.state });
        }
        this.setArtifactState(row, 'deleting', now);
      }
      return row.r2_key;
    });
    if (r2Key === null) {
      return;
    }
    await this.env.ARTIFACTS.delete(r2Key).catch(() => undefined);
    this.commit((): void => {
      const row = this.readArtifactRequired(artifactId);
      if (row.state === 'deleting') {
        this.setArtifactState(row, 'deleted', now, { deletedAt: now });
        this.journalDurableEvent({
          jobId: row.job_id,
          attemptId: row.attempt_id,
          generation: this.readAttempt(row.attempt_id)?.fence ?? 0,
          kind: 'artifact.deleted',
          payload: { artifactId, reason, deletedBy: actorEnrollmentId },
        });
      }
    });
  }

  /** Streams + verifies an R2 object's sha256 without buffering it whole. */
  private async readArtifactObjectDigest(
    r2Key: string,
  ): Promise<{ size: number; sha256: string } | null> {
    const obj = await this.env.ARTIFACTS.get(r2Key);
    if (obj === null) {
      return null;
    }
    if (typeof crypto.DigestStream === 'function' && obj.body !== null) {
      const stream = new crypto.DigestStream('SHA-256');
      await obj.body.pipeTo(stream);
      const digest = await stream.digest;
      return { size: obj.size, sha256: hexEncode(digest) };
    }
    const bytes = await obj.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return { size: obj.size, sha256: hexEncode(digest) };
  }

  /**
   * `artifact.get` (either actor): manifest descriptor plus the bounded
   * download route while `published` and unexpired. A published row past
   * retention expires lazily here (and its object is purged post-commit).
   */
  private handleArtifactGet(auth: SpikeAuth, requestId: string, params: unknown): Response {
    const { artifactId } = parseArtifactIdParams(params);
    const now = Date.now();
    const result = this.commit((): ArtifactGetResult => {
      this.assertNotRevoked(auth);
      const row = this.readArtifact(artifactId);
      if (row === null || row.account_id !== auth.accountId) {
        throw new RpcFailure('not-found', { reason: 'artifact' });
      }
      const fresh = this.expireArtifactIfDue(row, now);
      this.bumpCounter('artifact_gets', 1);
      return {
        artifact: this.artifactDescriptor(fresh),
        downloadPath: fresh.state === 'published' ? `/v1/artifacts/${fresh.artifact_id}` : null,
      };
    });
    return rpcSuccessResponse(requestId, result);
  }

  /**
   * `artifact.list` (either actor): newest-first descriptors filtered by
   * jobId or attemptId (one is required), optional state filter, bounded
   * page. Published rows past retention expire lazily before listing.
   */
  private handleArtifactList(auth: SpikeAuth, requestId: string, params: unknown): Response {
    const list = parseArtifactListParams(params);
    const now = Date.now();
    const result = this.commit((): ArtifactListResult => {
      this.assertNotRevoked(auth);
      const rows = (
        list.attemptId !== undefined
          ? this.ctx.storage.sql.exec<ArtifactRow>(
              `SELECT * FROM artifacts WHERE account_id = ? AND attempt_id = ?
               ORDER BY created_at DESC, artifact_id ASC LIMIT ?`,
              auth.accountId,
              list.attemptId,
              MAX_ARTIFACT_LIST_LIMIT,
            )
          : this.ctx.storage.sql.exec<ArtifactRow>(
              `SELECT * FROM artifacts WHERE account_id = ? AND job_id = ?
               ORDER BY created_at DESC, artifact_id ASC LIMIT ?`,
              auth.accountId,
              list.jobId as string,
              MAX_ARTIFACT_LIST_LIMIT,
            )
      ).toArray();
      const artifacts = rows
        .map((row) => this.expireArtifactIfDue(row, now))
        .filter((row) => list.state === undefined || row.state === list.state)
        .slice(0, list.limit)
        .map((row) => this.artifactDescriptor(row));
      this.bumpCounter('artifact_lists', 1);
      return { artifacts };
    });
    return rpcSuccessResponse(requestId, result);
  }

  /**
   * `artifact.delete` (user actor): `deleting` → object purge → `deleted`,
   * journaled. Terminal rows are an idempotent no-op; the executing worker
   * may not delete (user role per the frozen operation table).
   */
  private async handleArtifactDelete(
    auth: SpikeAuth,
    requestId: string,
    params: unknown,
  ): Promise<Response> {
    const { artifactId } = parseArtifactIdParams(params);
    const now = Date.now();
    const first = this.commit((): { terminal: boolean } => {
      this.assertNotRevoked(auth);
      const row = this.readArtifact(artifactId);
      if (row === null || row.account_id !== auth.accountId) {
        throw new RpcFailure('not-found', { reason: 'artifact' });
      }
      const attempt = this.readAttemptRequired(row.attempt_id);
      if (attempt.worker_enrollment_id === auth.enrollmentId) {
        throw new RpcFailure('forbidden', { reason: 'worker-role-not-permitted' });
      }
      if (row.state === 'deleted' || row.state === 'expired') {
        return { terminal: true };
      }
      if (!isArtifactState(row.state) || !canTransitionArtifact(row.state, 'deleting')) {
        throw new RpcFailure('conflict', { reason: 'artifact-state', state: row.state });
      }
      this.setArtifactState(row, 'deleting', now);
      return { terminal: false };
    });
    if (!first.terminal) {
      await this.discardArtifact(artifactId, 'deleted', auth.enrollmentId);
    }
    this.bumpCounter('artifact_deletes', 1);
    const result = { artifact: this.artifactDescriptor(this.readArtifactRequired(artifactId)) };
    return rpcSuccessResponse(requestId, result);
  }

  /**
   * Streams a published artifact's bytes. Metadata authorization is the
   * same as `artifact.get` (account-scoped, unrevoked); the content type is
   * constrained to a safe list with `nosniff`, and there are no signed URLs.
   */
  private async handleArtifactDownload(request: Request, artifactId: string): Promise<Response> {
    const auth = this.identityOf(request);
    if (auth === null) {
      return rpcErrorResponse(undefined, 'unauthenticated');
    }
    const now = Date.now();
    let artifact: ArtifactRow;
    try {
      artifact = this.commit((): ArtifactRow => {
        this.assertNotRevoked(auth);
        const row = this.readArtifact(artifactId);
        if (row === null || row.account_id !== auth.accountId) {
          throw new RpcFailure('not-found', { reason: 'artifact' });
        }
        return this.expireArtifactIfDue(row, now);
      });
    } catch (error) {
      if (isRpcFailure(error)) {
        return failureResponse(undefined, error);
      }
      return rpcErrorResponse(undefined, 'unavailable');
    }
    if (artifact.state !== 'published') {
      return rpcErrorResponse(undefined, 'not-found', {
        reason: 'artifact-not-published',
        state: artifact.state,
      });
    }
    const obj = await this.env.ARTIFACTS.get(artifact.r2_key);
    if (obj === null) {
      return rpcErrorResponse(undefined, 'not-found', { reason: 'artifact-bytes-missing' });
    }
    const mediaType = SAFE_DOWNLOAD_MEDIA_TYPES.has(artifact.media_type)
      ? artifact.media_type
      : 'application/octet-stream';
    const headers = new Headers({
      'content-type': mediaType,
      'content-length': String(obj.size),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      etag: obj.etag,
    });
    return new Response(obj.body, { headers });
  }

  /** Any revoked worker record makes its enrollment inert on all new ops. */
  private assertNotRevoked(auth: SpikeAuth): void {
    const worker = this.readWorker(auth.enrollmentId);
    if (worker !== null && worker.revoked_at !== null) {
      throw new RpcFailure('forbidden', { reason: 'worker-revoked' });
    }
  }

  /**
   * OPS-01 retention/compaction. One alarm per account per spec §3: each pass
   * reschedules from the remaining work — soon while a bounded batch still has
   * expired rows, else at the regular cadence. The sweep deletes expired
   * change-journal rows and receipts, advances `retention_floor` past the
   * highest deleted sequence (stale cursors below it already reset), and
   * drops completed scans.
   */
  async alarm(): Promise<void> {
    await this.runSweep(Date.now());
  }

  private async ensureSweepScheduled(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }

  private async runSweep(now: number): Promise<{
    deletedChanges: number;
    deletedReceipts: number;
    deletedScans: number;
    deletedWorkers: number;
    expiredJobs: number;
    staleAttempts: number;
    expiredApprovals: number;
    reconciledArtifacts: number;
    deletedEvents: number;
    continued: boolean;
  }> {
    const cutoff = now - RETENTION_MS;
    const workerCutoff = now - WORKER_AUDIT_RETENTION_MS;
    const artifactCutoff = now - ARTIFACT_AUDIT_RETENTION_MS;
    let deletedChanges = 0;
    let deletedReceipts = 0;
    let deletedScans = 0;
    let deletedWorkers = 0;
    let expiredJobs = 0;
    let staleAttempts = 0;
    let expiredApprovals = 0;
    let deletedEvents = 0;
    let freedBytes = 0;
    let maxDeletedSequence: number | null = null;
    /** Artifact r2_keys whose objects purge after the SQL phase commits. */
    const orphanArtifactKeys: { artifactId: string; r2Key: string }[] = [];
    this.commit(() => {
      const expired = this.ctx.storage.sql
        .exec<{ sequence: number; nbytes: number | null }>(
          `SELECT sequence, length(cast(payload AS blob)) AS nbytes
           FROM changes WHERE created_at < ? ORDER BY sequence ASC LIMIT ?`,
          cutoff,
          SWEEP_BATCH_ROWS,
        )
        .toArray();
      for (const row of expired) {
        this.ctx.storage.sql.exec('DELETE FROM changes WHERE sequence = ?', row.sequence);
        freedBytes += row.nbytes ?? 0;
        maxDeletedSequence = row.sequence;
      }
      deletedChanges = expired.length;
      if (maxDeletedSequence !== null) {
        this.ctx.storage.sql.exec(
          `UPDATE sync_meta SET value = ?
           WHERE key = 'retention_floor' AND CAST(value AS INTEGER) < ?`,
          String(maxDeletedSequence),
          maxDeletedSequence,
        );
      }
      const staleReceipts = this.ctx.storage.sql
        .exec<{ enrollment_id: string; enrollment_sequence: number }>(
          `SELECT enrollment_id, enrollment_sequence FROM receipts
           WHERE created_at < ? LIMIT ?`,
          cutoff,
          SWEEP_BATCH_ROWS,
        )
        .toArray();
      for (const row of staleReceipts) {
        this.ctx.storage.sql.exec(
          'DELETE FROM receipts WHERE enrollment_id = ? AND enrollment_sequence = ?',
          row.enrollment_id,
          row.enrollment_sequence,
        );
        deletedReceipts += 1;
      }
      const staleScans = this.ctx.storage.sql
        .exec<{ scan_id: string }>(
          'SELECT scan_id FROM scans WHERE done = 1 AND created_at < ? LIMIT ?',
          cutoff,
          SWEEP_BATCH_ROWS,
        )
        .toArray();
      for (const row of staleScans) {
        this.ctx.storage.sql.exec('DELETE FROM scans WHERE scan_id = ?', row.scan_id);
        deletedScans += 1;
      }
      // MESH-01: revoked worker records are audit state; drop the row and its
      // replica summaries once the 30-day audit window has passed. Stale (not
      // revoked) incarnations are NOT deleted — availability is derived from
      // lease freshness at read time, so expiry holds without a timer.
      const staleWorkers = this.ctx.storage.sql
        .exec<{ enrollment_id: string }>(
          `SELECT enrollment_id FROM workers
           WHERE revoked_at IS NOT NULL AND revoked_at < ? LIMIT ?`,
          workerCutoff,
          SWEEP_BATCH_ROWS,
        )
        .toArray();
      for (const row of staleWorkers) {
        this.ctx.storage.sql.exec(
          'DELETE FROM worker_replicas WHERE enrollment_id = ?',
          row.enrollment_id,
        );
        this.ctx.storage.sql.exec('DELETE FROM workers WHERE enrollment_id = ?', row.enrollment_id);
        deletedWorkers += 1;
      }
      // MESH-02: queued jobs past their queue deadline fail with
      // 'queue-deadline' (same lazy pass reads/claims run). Attempts whose
      // lease lapsed well past expiry — one full lease of grace — are marked
      // 'unknown-outcome'. The job is deliberately NOT transitioned and no
      // replacement attempt is created: an expired lease never auto-reassigns
      // (spec §9); the job stays 'running'/'cancel-requested' until an
      // explicit report or cancel reconciles it.
      expiredJobs = this.expireQueuedJobs(now);
      const stale = this.ctx.storage.sql
        .exec<{ attempt_id: string }>(
          `SELECT attempt_id FROM attempts
           WHERE state IN ('claimed', 'preparing', 'running', 'stopping')
             AND lease_expires_at < ? LIMIT ?`,
          now - ATTEMPT_UNKNOWN_GRACE_MS,
          SWEEP_BATCH_ROWS,
        )
        .toArray();
      for (const row of stale) {
        const attempt = this.readAttempt(row.attempt_id);
        if (attempt === null || !isActiveAttemptState(attempt.state)) {
          continue;
        }
        this.setAttemptState(attempt, 'unknown-outcome', now);
        staleAttempts += 1;
      }
      // MESH-03: pending approvals past their deadline expire (journaled as
      // approval.decided{outcome:'expired'}); pending approvals whose job can
      // no longer be waiting are cancelled.
      const dueApprovals = this.ctx.storage.sql
        .exec<ApprovalRow>(
          "SELECT * FROM approvals WHERE state = 'pending' AND expires_at <= ? LIMIT ?",
          now,
          SWEEP_BATCH_ROWS,
        )
        .toArray();
      for (const row of dueApprovals) {
        this.expireApprovalIfDue(row, now);
        expiredApprovals += 1;
      }
      // MESH-03: artifact reconciliation. Orphaned reservations/uploads past
      // the upload window move to `deleting` — their objects delete after
      // commit, then a second pass marks them `deleted`. Published rows past
      // retention expire with their object queued for purge. Interrupted
      // `deleting` rows retry. Terminal rows past the audit window purge.
      const orphans = this.ctx.storage.sql
        .exec<ArtifactRow>(
          `SELECT * FROM artifacts
           WHERE (state IN ('reserved', 'uploaded') AND upload_expires_at <= ?)
              OR (state = 'deleting' AND updated_at <= ?)
           LIMIT ?`,
          now,
          now - 60_000,
          SWEEP_BATCH_ROWS,
        )
        .toArray();
      for (const row of orphans) {
        if (row.state !== 'deleting') {
          if (!isArtifactState(row.state) || !canTransitionArtifact(row.state, 'deleting')) {
            continue;
          }
          this.setArtifactState(row, 'deleting', now);
        }
        orphanArtifactKeys.push({ artifactId: row.artifact_id, r2Key: row.r2_key });
      }
      const retainExpired = this.ctx.storage.sql
        .exec<ArtifactRow>(
          "SELECT * FROM artifacts WHERE state = 'published' AND expires_at <= ? LIMIT ?",
          now,
          SWEEP_BATCH_ROWS,
        )
        .toArray();
      for (const row of retainExpired) {
        this.expireArtifactIfDue(row, now);
      }
      const staleArtifacts = this.ctx.storage.sql
        .exec<{ artifact_id: string }>(
          `SELECT artifact_id FROM artifacts
           WHERE state IN ('deleted', 'expired')
             AND COALESCE(deleted_at, updated_at) < ? LIMIT ?`,
          artifactCutoff,
          SWEEP_BATCH_ROWS,
        )
        .toArray();
      for (const row of staleArtifacts) {
        this.ctx.storage.sql.exec(
          'DELETE FROM artifacts WHERE artifact_id = ?',
          row.artifact_id,
        );
      }
      // MESH-03: the durable journal keeps the same 90-day horizon as the
      // change log; job_event_meta rows persist so cursors never rewind.
      const staleEvents = this.ctx.storage.sql
        .exec<{ job_id: string; event_seq: number }>(
          'SELECT job_id, event_seq FROM events WHERE created_at < ? LIMIT ?',
          cutoff,
          SWEEP_BATCH_ROWS,
        )
        .toArray();
      for (const row of staleEvents) {
        this.ctx.storage.sql.exec(
          'DELETE FROM events WHERE job_id = ? AND event_seq = ?',
          row.job_id,
          row.event_seq,
        );
        deletedEvents += 1;
      }
      // MESH-03: prune lapsed observer interest from socket attachments.
      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment();
        if (!isSocketAttachment(attachment) || attachment.subscriptions === undefined) {
          continue;
        }
        const live = attachmentSubscriptions(attachment).filter((s) => s.expiresAt > now);
        if (live.length !== attachmentSubscriptions(attachment).length) {
          attachment.subscriptions = live;
          try {
            ws.serializeAttachment(attachment);
          } catch {
            // socket gone — close/error path cleans delivery state
          }
        }
      }
      if (freedBytes > 0) {
        this.addHistoryBytes(-freedBytes);
      }
      this.bumpCounter('sweep_changes_deleted', deletedChanges);
      this.bumpCounter('sweep_receipts_deleted', deletedReceipts);
      this.bumpCounter('sweep_scans_deleted', deletedScans);
      this.bumpCounter('sweep_workers_deleted', deletedWorkers);
      this.bumpCounter('sweep_attempts_unknown', staleAttempts);
      this.bumpCounter('sweep_artifacts_rows_deleted', staleArtifacts.length);
      this.bumpCounter('sweep_events_deleted', deletedEvents);
    });
    // Post-commit: purge orphaned/interrupted artifact objects, then mark
    // their rows deleted (journaled). Idempotent — a retried `deleting` row
    // simply deletes an already-absent key.
    let reconciledArtifacts = 0;
    for (const orphan of orphanArtifactKeys) {
      await this.env.ARTIFACTS.delete(orphan.r2Key).catch(() => undefined);
      this.commit((): void => {
        const row = this.readArtifact(orphan.artifactId);
        if (row !== null && row.state === 'deleting') {
          this.setArtifactState(row, 'deleted', now, { deletedAt: now });
          this.journalDurableEvent({
            jobId: row.job_id,
            attemptId: row.attempt_id,
            generation: this.readAttempt(row.attempt_id)?.fence ?? 0,
            kind: 'artifact.deleted',
            payload: { artifactId: orphan.artifactId, reason: 'sweep-reconciled' },
          });
        }
      });
      reconciledArtifacts += 1;
    }
    const continued =
      deletedChanges === SWEEP_BATCH_ROWS ||
      deletedReceipts === SWEEP_BATCH_ROWS ||
      deletedWorkers === SWEEP_BATCH_ROWS ||
      expiredJobs === SWEEP_BATCH_ROWS ||
      staleAttempts === SWEEP_BATCH_ROWS ||
      expiredApprovals === SWEEP_BATCH_ROWS ||
      deletedEvents === SWEEP_BATCH_ROWS;
    await this.ctx.storage.setAlarm(
      Date.now() + (continued ? SWEEP_CONTINUE_MS : SWEEP_INTERVAL_MS),
    );
    return {
      deletedChanges,
      deletedReceipts,
      deletedScans,
      deletedWorkers,
      expiredJobs,
      staleAttempts,
      expiredApprovals,
      reconciledArtifacts,
      deletedEvents,
      continued,
    };
  }

  private readHistoryBytes(): number {
    const rows = this.ctx.storage.sql
      .exec<MetaRow>("SELECT value FROM sync_meta WHERE key = 'history_bytes'")
      .toArray();
    return rows[0] === undefined ? 0 : Number(rows[0].value);
  }

  private addHistoryBytes(delta: number): void {
    const next = Math.max(0, this.readHistoryBytes() + delta);
    this.ctx.storage.sql.exec(
      `INSERT INTO sync_meta (key, value) VALUES ('history_bytes', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(next),
    );
  }

  private bumpCounter(key: string, by: number): void {
    if (by === 0) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO counters (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
      key,
      by,
    );
  }

  private accountStats(): SyncAccountStats {
    const counters: Record<string, number> = {};
    for (const row of this.ctx.storage.sql
      .exec<{ key: string; value: number }>('SELECT key, value FROM counters')
      .toArray()) {
      counters[row.key] = row.value;
    }
    const artifactBytes =
      this.ctx.storage.sql
        .exec<{ total: number | null }>(
          `SELECT COALESCE(SUM(byte_length), 0) AS total FROM artifacts
           WHERE state NOT IN ('deleted', 'expired')`,
        )
        .one().total ?? 0;
    return {
      historyBytes: this.readHistoryBytes(),
      historyQuotaBytes: HISTORY_QUOTA_BYTES,
      retentionFloor: this.readRetentionFloor(),
      artifactBytes,
      counters,
    };
  }
}

function parseSpikePushParams(params: unknown): SpikePushParams {
  if (!isRecord(params) || !Array.isArray(params['changes'])) {
    throw new RpcFailure('malformed-request', { reason: 'changes-required' });
  }
  const epochRaw = params['epoch'];
  if (epochRaw !== undefined && typeof epochRaw !== 'string') {
    throw new RpcFailure('malformed-request', { reason: 'epoch-type' });
  }
  const changes: PendingChange[] = [];
  for (const entry of params['changes']) {
    changes.push(parsePendingChange(entry));
  }
  return { changes, epoch: epochRaw };
}

function parseSpikePullParams(params: unknown): { cursor: number; maxBytes: number; maxChanges?: number } {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'pull-params' });
  }
  if (!Object.prototype.hasOwnProperty.call(params, 'cursor')) {
    throw new RpcFailure('malformed-request', { reason: 'cursor-required' });
  }
  const cursorRaw = params['cursor'];
  let cursor = 0;
  if (cursorRaw !== null) {
    if (typeof cursorRaw !== 'string') {
      throw new RpcFailure('malformed-request', { reason: 'cursor-type' });
    }
    if (cursorRaw !== '') {
      if (!/^[0-9]+$/.test(cursorRaw)) {
        throw new RpcFailure('malformed-request', { reason: 'cursor-format' });
      }
      cursor = Number(cursorRaw);
      if (!Number.isSafeInteger(cursor)) {
        throw new RpcFailure('malformed-request', { reason: 'cursor-range' });
      }
    }
  }
  const maxBytes = params['maxBytes'];
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RpcFailure('malformed-request', { reason: 'maxBytes' });
  }
  const maxChangesRaw = params['maxChanges'];
  if (maxChangesRaw === undefined) {
    return { cursor, maxBytes };
  }
  if (typeof maxChangesRaw !== 'number' || !Number.isInteger(maxChangesRaw) || maxChangesRaw < 1) {
    throw new RpcFailure('malformed-request', { reason: 'maxChanges' });
  }
  return { cursor, maxBytes, maxChanges: maxChangesRaw };
}

function parseScanBeginParams(params: unknown): { epoch?: string | null } {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'scan-begin-params' });
  }
  if (!Object.prototype.hasOwnProperty.call(params, 'epoch')) {
    return {};
  }
  const epoch = params['epoch'];
  if (epoch !== null && typeof epoch !== 'string') {
    throw new RpcFailure('malformed-request', { reason: 'epoch-type' });
  }
  return { epoch };
}

function parseScanPageParams(params: unknown): {
  scanId: string;
  cursor: string | null;
  maxBytes: number;
} {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'scan-page-params' });
  }
  const scanId = params['scanId'];
  if (typeof scanId !== 'string' || scanId.length === 0) {
    throw new RpcFailure('malformed-request', { reason: 'scanId' });
  }
  if (!Object.prototype.hasOwnProperty.call(params, 'cursor')) {
    throw new RpcFailure('malformed-request', { reason: 'cursor-required' });
  }
  const cursorRaw = params['cursor'];
  if (cursorRaw !== null && typeof cursorRaw !== 'string') {
    throw new RpcFailure('malformed-request', { reason: 'cursor-type' });
  }
  if (typeof cursorRaw === 'string' && cursorRaw.length === 0) {
    throw new RpcFailure('malformed-request', { reason: 'cursor-format' });
  }
  const maxBytes = params['maxBytes'];
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RpcFailure('malformed-request', { reason: 'maxBytes' });
  }
  return { scanId, cursor: cursorRaw, maxBytes };
}

function parseScanFinishParams(params: unknown): { scanId: string } {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'scan-finish-params' });
  }
  const scanId = params['scanId'];
  if (typeof scanId !== 'string' || scanId.length === 0) {
    throw new RpcFailure('malformed-request', { reason: 'scanId' });
  }
  return { scanId };
}

function encodeEntityCursor(entityType: string, entityId: string): string {
  return JSON.stringify([entityType, entityId]);
}

function decodeEntityCursor(cursor: string): { entityType: string; entityId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor) as unknown;
  } catch {
    throw new RpcFailure('malformed-request', { reason: 'cursor-format' });
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new RpcFailure('malformed-request', { reason: 'cursor-format' });
  }
  const entityType = parsed[0];
  const entityId = parsed[1];
  if (typeof entityType !== 'string' || typeof entityId !== 'string') {
    throw new RpcFailure('malformed-request', { reason: 'cursor-format' });
  }
  if (entityType.length === 0 || entityId.length === 0) {
    throw new RpcFailure('malformed-request', { reason: 'cursor-format' });
  }
  return { entityType, entityId };
}

function parsePendingChange(input: unknown): PendingChange {
  if (!isRecord(input)) {
    throw new RpcFailure('malformed-request', { reason: 'change-object' });
  }
  const changeId = input['changeId'];
  const enrollmentSequence = input['enrollmentSequence'];
  const entityType = input['entityType'];
  const entityId = input['entityId'];
  const schemaVersion = input['schemaVersion'];
  const baseRevision = input['baseRevision'];
  const operation = input['operation'];
  const payloadHash = input['payloadHash'];
  if (typeof changeId !== 'string' || changeId.length === 0) {
    throw new RpcFailure('malformed-request', { reason: 'changeId' });
  }
  if (typeof enrollmentSequence !== 'number' || !Number.isInteger(enrollmentSequence) || enrollmentSequence < 1) {
    throw new RpcFailure('malformed-request', { reason: 'enrollmentSequence' });
  }
  if (typeof entityType !== 'string' || entityType.length === 0) {
    throw new RpcFailure('malformed-request', { reason: 'entityType' });
  }
  if (typeof entityId !== 'string' || entityId.length === 0) {
    throw new RpcFailure('malformed-request', { reason: 'entityId' });
  }
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new RpcFailure('malformed-request', { reason: 'schemaVersion' });
  }
  if (!(baseRevision === null || (typeof baseRevision === 'number' && Number.isInteger(baseRevision)))) {
    throw new RpcFailure('malformed-request', { reason: 'baseRevision' });
  }
  if (!isSyncOperation(operation)) {
    throw new RpcFailure('malformed-request', { reason: 'operation' });
  }
  if (typeof payloadHash !== 'string' || !HASH_PATTERN.test(payloadHash)) {
    throw new RpcFailure('malformed-request', { reason: 'payloadHash' });
  }
  const hasPayload = Object.prototype.hasOwnProperty.call(input, 'payload');
  if (operation === 'delete') {
    if (baseRevision === null) {
      throw new RpcFailure('malformed-request', { reason: 'delete-base' });
    }
    if (hasPayload) {
      throw new RpcFailure('malformed-request', { reason: 'delete-payload' });
    }
    return {
      changeId,
      enrollmentSequence,
      entityType,
      entityId,
      schemaVersion,
      baseRevision,
      operation,
      payloadHash,
    };
  }
  if (operation === 'create' && baseRevision !== null) {
    throw new RpcFailure('malformed-request', { reason: 'create-base' });
  }
  if (operation === 'update' && baseRevision === null) {
    throw new RpcFailure('malformed-request', { reason: 'update-base' });
  }
  if (!hasPayload) {
    throw new RpcFailure('malformed-request', { reason: 'payload-required' });
  }
  return {
    changeId,
    enrollmentSequence,
    entityType,
    entityId,
    schemaVersion,
    baseRevision,
    operation,
    payload: input['payload'],
    payloadHash,
  };
}

function assertPendingChange(change: PendingChange): void {
  switch (change.operation) {
    case 'create':
      if (change.baseRevision !== null) {
        throw new RpcFailure('malformed-request', { reason: 'create-base' });
      }
      return;
    case 'update':
      if (change.baseRevision === null) {
        throw new RpcFailure('malformed-request', { reason: 'update-base' });
      }
      return;
    case 'delete':
      if (change.baseRevision === null) {
        throw new RpcFailure('malformed-request', { reason: 'delete-base' });
      }
      return;
    default: {
      const exhaustive: never = change.operation;
      throw new RpcFailure('malformed-request', { reason: String(exhaustive) });
    }
  }
}

function compareBaseRevision(
  change: PendingChange,
  existing: EntityRow | null,
): SyncPushItemResult | null {
  switch (change.operation) {
    case 'create': {
      if (existing !== null) {
        return {
          status: 'conflict',
          changeId: change.changeId,
          remoteRevision: existing.revision,
          remoteContent: parseRemoteContent(existing.payload),
        };
      }
      return null;
    }
    case 'update':
    case 'delete': {
      if (existing === null) {
        return {
          status: 'conflict',
          changeId: change.changeId,
          remoteRevision: 0,
          remoteContent: null,
        };
      }
      if (existing.revision !== change.baseRevision) {
        return {
          status: 'conflict',
          changeId: change.changeId,
          remoteRevision: existing.revision,
          remoteContent: parseRemoteContent(existing.payload),
        };
      }
      return null;
    }
    default: {
      const exhaustive: never = change.operation;
      throw new RpcFailure('malformed-request', { reason: String(exhaustive) });
    }
  }
}

// ---- MESH-01 worker param/storage parsing ------------------------------

/** An incarnation is live while its lease has not lapsed. */
function isLeaseLive(row: WorkerRow, now: number): boolean {
  return row.incarnation !== null && row.lease_expires_at !== null && row.lease_expires_at > now;
}

function isReplicaReadiness(value: unknown): value is WorkerReplicaReadiness {
  return value === 'ready' || value === 'cloning' || value === 'error' || value === 'not-ready';
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_FIELD_LENGTH;
}

function parseOptionalConcurrency(value: unknown, reason: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_CONCURRENT_JOBS
  ) {
    throw new RpcFailure('malformed-request', { reason });
  }
  return value;
}

/**
 * Validates a `device.policy.publish` payload. The stored document keeps
 * only the fields the contract defines (unknown keys are dropped so a
 * client cannot smuggle unbounded metadata into the worker record).
 */
function parseDevicePolicyParams(params: unknown): DevicePolicy {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'policy-params' });
  }
  const worker = params['worker'];
  if (!isRecord(worker)) {
    throw new RpcFailure('malformed-request', { reason: 'worker-section-required' });
  }
  const allowJobs = worker['allowJobs'];
  if (typeof allowJobs !== 'boolean') {
    throw new RpcFailure('malformed-request', { reason: 'allowJobs' });
  }
  const sourcesRaw = worker['allowedSources'];
  let allowedSources: string[] | undefined;
  if (sourcesRaw !== undefined) {
    if (!Array.isArray(sourcesRaw) || sourcesRaw.length > MAX_POLICY_SOURCES) {
      throw new RpcFailure('malformed-request', { reason: 'allowedSources' });
    }
    const seen = new Set<string>();
    allowedSources = [];
    for (const entry of sourcesRaw) {
      if (!isBoundedId(entry) || seen.has(entry)) {
        throw new RpcFailure('malformed-request', { reason: 'allowedSources' });
      }
      seen.add(entry);
      allowedSources.push(entry);
    }
  }
  const maxConcurrentJobs = parseOptionalConcurrency(
    worker['maxConcurrentJobs'],
    'maxConcurrentJobs',
  );
  return {
    worker: {
      allowJobs,
      ...(allowedSources === undefined ? {} : { allowedSources }),
      ...(maxConcurrentJobs === undefined ? {} : { maxConcurrentJobs }),
    },
  };
}

/**
 * Reads a stored policy document. Rows are written only by
 * parseDevicePolicyParams output; a shape violation means storage
 * corruption and maps to `unavailable`, not `malformed-request`.
 */
function parseStoredDevicePolicy(raw: string): DevicePolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RpcFailure('unavailable', { reason: 'corrupt-worker-policy' });
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed['worker']) ||
    typeof parsed['worker']['allowJobs'] !== 'boolean'
  ) {
    throw new RpcFailure('unavailable', { reason: 'corrupt-worker-policy' });
  }
  return parsed as unknown as DevicePolicy;
}

function parseWorkerCapabilitiesParams(params: unknown): WorkerCapabilities {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'capabilities-params' });
  }
  const os = params['os'];
  const arch = params['arch'];
  if (!isBoundedId(os)) {
    throw new RpcFailure('malformed-request', { reason: 'os' });
  }
  if (!isBoundedId(arch)) {
    throw new RpcFailure('malformed-request', { reason: 'arch' });
  }
  const memoryMb = params['memoryMb'];
  if (
    memoryMb !== undefined &&
    (typeof memoryMb !== 'number' || !Number.isInteger(memoryMb) || memoryMb < 1)
  ) {
    throw new RpcFailure('malformed-request', { reason: 'memoryMb' });
  }
  const capabilitiesRaw = params['capabilities'];
  if (!Array.isArray(capabilitiesRaw) || capabilitiesRaw.length > MAX_CAPABILITY_ENTRIES) {
    throw new RpcFailure('malformed-request', { reason: 'capabilities' });
  }
  const seen = new Set<string>();
  const capabilities: string[] = [];
  for (const entry of capabilitiesRaw) {
    if (!isBoundedId(entry) || seen.has(entry)) {
      throw new RpcFailure('malformed-request', { reason: 'capabilities' });
    }
    seen.add(entry);
    capabilities.push(entry);
  }
  const maxConcurrentJobs = parseOptionalConcurrency(
    params['maxConcurrentJobs'],
    'maxConcurrentJobs',
  );
  return {
    os,
    arch,
    ...(memoryMb === undefined ? {} : { memoryMb }),
    capabilities,
    ...(maxConcurrentJobs === undefined ? {} : { maxConcurrentJobs }),
  };
}

function parseReplicaPublishParams(params: unknown): WorkerReplicaPublishParams {
  if (!isRecord(params) || !Array.isArray(params['replicas'])) {
    throw new RpcFailure('malformed-request', { reason: 'replicas-required' });
  }
  if (params['replicas'].length > MAX_REPLICAS_PER_PUBLISH) {
    throw new RpcFailure('payload-too-large', {
      limit: MAX_REPLICAS_PER_PUBLISH,
      actual: params['replicas'].length,
    });
  }
  const replicas: WorkerReplicaSummary[] = [];
  const seen = new Set<string>();
  for (const entry of params['replicas']) {
    if (!isRecord(entry)) {
      throw new RpcFailure('malformed-request', { reason: 'replica-object' });
    }
    const workspaceId = entry['workspaceId'];
    const definitionRevision = entry['definitionRevision'];
    const readiness = entry['readiness'];
    const observedAt = entry['observedAt'];
    if (!isBoundedId(workspaceId)) {
      throw new RpcFailure('malformed-request', { reason: 'workspaceId' });
    }
    if (seen.has(workspaceId)) {
      throw new RpcFailure('malformed-request', { reason: 'replica-duplicate' });
    }
    if (!isBoundedId(definitionRevision)) {
      throw new RpcFailure('malformed-request', { reason: 'definitionRevision' });
    }
    if (!isReplicaReadiness(readiness)) {
      throw new RpcFailure('malformed-request', { reason: 'readiness' });
    }
    if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) {
      throw new RpcFailure('malformed-request', { reason: 'observedAt' });
    }
    seen.add(workspaceId);
    replicas.push({ workspaceId, definitionRevision, readiness, observedAt });
  }
  return { replicas };
}

// ---- MESH-02 job/attempt param/storage parsing -----------------------------

const JOB_KINDS: readonly string[] = [
  'diagnostic',
  'prepare-workspace',
  'start-session',
  'workflow-node',
];
const JOB_STATES: readonly string[] = [
  'queued',
  'running',
  'awaiting-approval',
  'completed',
  'failed',
  'cancel-requested',
  'cancelled',
  'unknown-outcome',
];
const ATTEMPT_STATES: readonly string[] = [
  'claimed',
  'preparing',
  'running',
  'stopping',
  'completed',
  'failed',
  'cancelled',
  'unknown-outcome',
];
const RETRY_POLICIES: readonly string[] = ['safe', 'inspect-before-retry', 'never'];
/** Non-terminal attempt states: an attempt that may still hold ownership. */
const ACTIVE_ATTEMPT_STATES: readonly string[] = ['claimed', 'preparing', 'running', 'stopping'];

function isJobKind(value: unknown): value is JobKind {
  return typeof value === 'string' && JOB_KINDS.includes(value);
}

function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && JOB_STATES.includes(value);
}

function isAttemptState(value: unknown): value is AttemptState {
  return typeof value === 'string' && ATTEMPT_STATES.includes(value);
}

function isRetryPolicy(value: unknown): value is RetryPolicy {
  return typeof value === 'string' && RETRY_POLICIES.includes(value);
}

function isActiveAttemptState(state: string): boolean {
  return ACTIVE_ATTEMPT_STATES.includes(state);
}

/**
 * Reachability through the frozen attempt transition graph, hop by hop. v1
 * reports only terminal outcomes, so intermediate progress states collapse:
 * `claimed` reaches `completed` via preparing→running. Returns false where
 * the graph forbids the outcome entirely (e.g. stopping→completed).
 */
function attemptTransitionReachable(from: AttemptState, to: AttemptState): boolean {
  const seen = new Set<AttemptState>([from]);
  const queue: AttemptState[] = [from];
  while (queue.length > 0) {
    const current = queue.shift() as AttemptState;
    for (const next of ATTEMPT_TRANSITIONS[current]) {
      if (next === to) {
        return true;
      }
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * The worker-side source authorization check, used identically at placement
 * (auto candidates, explicit-device validation) and at claim: the source
 * enrollment must be listed in `allowedSources` or covered by the
 * `same-account` literal. A job sourced on the target device itself is
 * local consent, not remote authorization.
 */
function policyAllowsSource(
  policy: DevicePolicy,
  sourceEnrollmentId: string,
  workerEnrollmentId: string,
): boolean {
  if (sourceEnrollmentId === workerEnrollmentId) {
    return true;
  }
  const sources = policy.worker.allowedSources;
  if (sources === undefined) {
    return false;
  }
  return sources.includes(sourceEnrollmentId) || sources.includes(SAME_ACCOUNT_SOURCE);
}

/** min(policy.maxConcurrentJobs, capabilities.maxConcurrentJobs, backend cap). */
function effectiveConcurrencyCap(
  policy: DevicePolicy,
  capabilities: WorkerCapabilities | null,
): number {
  return Math.min(
    policy.worker.maxConcurrentJobs ?? MAX_CONCURRENT_JOBS,
    capabilities?.maxConcurrentJobs ?? MAX_CONCURRENT_JOBS,
    MAX_CONCURRENT_JOBS,
  );
}

/**
 * Does a published capability set satisfy a job's declared requirements?
 * `capabilities` must cover every required entry; `os`/`cpu`/`memoryMb`
 * match exactly/at-least when declared. No published set never satisfies a
 * declared requirement.
 */
function capabilitiesSatisfy(
  capabilities: WorkerCapabilities | null,
  requirements: CapabilityRequirements | undefined,
): boolean {
  if (requirements === undefined) {
    return true;
  }
  if (capabilities === null) {
    return false;
  }
  for (const required of requirements.capabilities) {
    if (!capabilities.capabilities.includes(required)) {
      return false;
    }
  }
  if (requirements.os !== undefined && capabilities.os !== requirements.os) {
    return false;
  }
  if (requirements.cpu !== undefined && capabilities.arch !== requirements.cpu) {
    return false;
  }
  if (
    requirements.memoryMb !== undefined &&
    (capabilities.memoryMb === undefined || capabilities.memoryMb < requirements.memoryMb)
  ) {
    return false;
  }
  return true;
}

/**
 * Reads a stored capabilities document. Rows are written only by
 * parseWorkerCapabilitiesParams output; a shape violation is corruption.
 */
function parseStoredCapabilities(raw: string | null): WorkerCapabilities | null {
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as WorkerCapabilities;
  } catch {
    throw new RpcFailure('unavailable', { reason: 'corrupt-worker-capabilities' });
  }
}

function parseJobCreateParams(params: unknown): JobCreateParams {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'create-params' });
  }
  const requestId = params['requestId'];
  const payloadHash = params['payloadHash'];
  const kind = params['kind'];
  if (!isBoundedId(requestId)) {
    throw new RpcFailure('malformed-request', { reason: 'requestId' });
  }
  if (typeof payloadHash !== 'string' || !HASH_PATTERN.test(payloadHash)) {
    throw new RpcFailure('malformed-request', { reason: 'payloadHash' });
  }
  if (!isJobKind(kind)) {
    throw new RpcFailure('malformed-request', { reason: 'kind' });
  }
  const requestedTarget = parseRequestedTarget(params['requestedTarget']);
  const inputManifest = parseExecutionManifest(params['inputManifest']);
  const queueDeadline = params['queueDeadline'];
  if (
    queueDeadline !== undefined &&
    (typeof queueDeadline !== 'string' || !Number.isFinite(Date.parse(queueDeadline)))
  ) {
    throw new RpcFailure('malformed-request', { reason: 'queueDeadline' });
  }
  const retryPolicy = params['retryPolicy'];
  if (retryPolicy !== undefined && !isRetryPolicy(retryPolicy)) {
    throw new RpcFailure('malformed-request', { reason: 'retryPolicy' });
  }
  return {
    requestId,
    payloadHash,
    kind,
    requestedTarget,
    inputManifest,
    ...(queueDeadline === undefined ? {} : { queueDeadline }),
    // Spec §9: remote coding/bootstrap default to inspect-before-retry.
    retryPolicy: retryPolicy ?? 'inspect-before-retry',
  };
}

function parseRequestedTarget(value: unknown): RequestedTarget {
  if (!isRecord(value)) {
    throw new RpcFailure('malformed-request', { reason: 'requestedTarget' });
  }
  const requirements =
    value['requirements'] === undefined
      ? undefined
      : parseCapabilityRequirements(value['requirements']);
  const kind = value['kind'];
  if (kind === 'device') {
    const enrollmentId = value['enrollmentId'];
    if (!isBoundedId(enrollmentId)) {
      throw new RpcFailure('malformed-request', { reason: 'requestedTarget.enrollmentId' });
    }
    return {
      kind: 'device',
      enrollmentId,
      ...(requirements === undefined ? {} : { requirements }),
    };
  }
  if (kind === 'auto') {
    return { kind: 'auto', ...(requirements === undefined ? {} : { requirements }) };
  }
  throw new RpcFailure('malformed-request', { reason: 'requestedTarget.kind' });
}

function parseCapabilityRequirements(value: unknown): CapabilityRequirements {
  if (!isRecord(value)) {
    throw new RpcFailure('malformed-request', { reason: 'requirements' });
  }
  const capabilitiesRaw = value['capabilities'];
  if (!Array.isArray(capabilitiesRaw) || capabilitiesRaw.length > MAX_CAPABILITY_ENTRIES) {
    throw new RpcFailure('malformed-request', { reason: 'requirements.capabilities' });
  }
  const capabilities: string[] = [];
  for (const entry of capabilitiesRaw) {
    if (!isBoundedId(entry)) {
      throw new RpcFailure('malformed-request', { reason: 'requirements.capabilities' });
    }
    capabilities.push(entry);
  }
  const os = value['os'];
  const cpu = value['cpu'];
  const memoryMb = value['memoryMb'];
  if (os !== undefined && !isBoundedId(os)) {
    throw new RpcFailure('malformed-request', { reason: 'requirements.os' });
  }
  if (cpu !== undefined && !isBoundedId(cpu)) {
    throw new RpcFailure('malformed-request', { reason: 'requirements.cpu' });
  }
  if (
    memoryMb !== undefined &&
    (typeof memoryMb !== 'number' || !Number.isInteger(memoryMb) || memoryMb < 1)
  ) {
    throw new RpcFailure('malformed-request', { reason: 'requirements.memoryMb' });
  }
  return {
    capabilities,
    ...(os === undefined ? {} : { os }),
    ...(cpu === undefined ? {} : { cpu }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
  };
}

/**
 * Validates the pinned input manifest. Only contract fields are kept
 * (unknown keys are dropped) and every field is bounded; `inputs` and the
 * serialized whole carry byte caps since they hold client-declared data.
 */
function parseExecutionManifest(value: unknown): ExecutionManifest {
  if (!isRecord(value)) {
    throw new RpcFailure('malformed-request', { reason: 'inputManifest' });
  }
  const workspaceDefinitionRevision = value['workspaceDefinitionRevision'];
  const bootstrapDigest = value['bootstrapDigest'];
  const provider = value['provider'];
  const model = value['model'];
  if (!isBoundedId(workspaceDefinitionRevision)) {
    throw new RpcFailure('malformed-request', { reason: 'manifest.workspaceDefinitionRevision' });
  }
  if (!isBoundedId(bootstrapDigest)) {
    throw new RpcFailure('malformed-request', { reason: 'manifest.bootstrapDigest' });
  }
  if (!isBoundedId(provider)) {
    throw new RpcFailure('malformed-request', { reason: 'manifest.provider' });
  }
  if (!isBoundedId(model)) {
    throw new RpcFailure('malformed-request', { reason: 'manifest.model' });
  }
  const repositoriesRaw = value['repositories'];
  if (!Array.isArray(repositoriesRaw) || repositoriesRaw.length > MAX_MANIFEST_REPOSITORIES) {
    throw new RpcFailure('malformed-request', { reason: 'manifest.repositories' });
  }
  const repositories: ExecutionManifest['repositories'] = [];
  for (const entry of repositoriesRaw) {
    if (!isRecord(entry) || !isBoundedId(entry['repositoryId']) || !isBoundedId(entry['commit'])) {
      throw new RpcFailure('malformed-request', { reason: 'manifest.repositories' });
    }
    repositories.push({ repositoryId: entry['repositoryId'], commit: entry['commit'] });
  }
  const configRaw = value['configVersions'];
  if (!isRecord(configRaw)) {
    throw new RpcFailure('malformed-request', { reason: 'manifest.configVersions' });
  }
  const configEntries = Object.entries(configRaw);
  if (configEntries.length > MAX_MANIFEST_CONFIG_ENTRIES) {
    throw new RpcFailure('malformed-request', { reason: 'manifest.configVersions' });
  }
  const configVersions: Record<string, string> = {};
  for (const [key, configValue] of configEntries) {
    if (!isBoundedId(key) || !isBoundedId(configValue)) {
      throw new RpcFailure('malformed-request', { reason: 'manifest.configVersions' });
    }
    configVersions[key] = configValue;
  }
  const inputs = value['inputs'];
  if (!isRecord(inputs)) {
    throw new RpcFailure('malformed-request', { reason: 'manifest.inputs' });
  }
  const inputsBytes = utf8ByteLength(JSON.stringify(inputs));
  if (inputsBytes > MAX_JOB_INPUTS_BYTES) {
    throw new RpcFailure('payload-too-large', {
      limitBytes: MAX_JOB_INPUTS_BYTES,
      actualBytes: inputsBytes,
      field: 'manifest.inputs',
    });
  }
  const manifest: ExecutionManifest = {
    workspaceDefinitionRevision,
    repositories,
    bootstrapDigest,
    provider,
    model,
    configVersions,
    inputs,
  };
  const manifestBytes = utf8ByteLength(JSON.stringify(manifest));
  if (manifestBytes > MAX_MANIFEST_BYTES) {
    throw new RpcFailure('payload-too-large', {
      limitBytes: MAX_MANIFEST_BYTES,
      actualBytes: manifestBytes,
      field: 'inputManifest',
    });
  }
  return manifest;
}

function parseJobIdParams(params: unknown): { jobId: string } {
  if (!isRecord(params) || !isBoundedId(params['jobId'])) {
    throw new RpcFailure('malformed-request', { reason: 'jobId' });
  }
  return { jobId: params['jobId'] };
}

function parseJobListParams(params: unknown): { state?: JobState; limit: number } {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'list-params' });
  }
  const state = params['state'];
  if (state !== undefined && !isJobState(state)) {
    throw new RpcFailure('malformed-request', { reason: 'state' });
  }
  const limit = params['limit'];
  if (
    limit !== undefined &&
    (typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_JOB_LIST_LIMIT)
  ) {
    throw new RpcFailure('malformed-request', { reason: 'limit' });
  }
  return { ...(state === undefined ? {} : { state }), limit: limit ?? DEFAULT_JOB_LIST_LIMIT };
}

function parseAttemptRenewParams(params: unknown): AttemptRenewParams {
  if (!isRecord(params) || !Array.isArray(params['renewals'])) {
    throw new RpcFailure('malformed-request', { reason: 'renewals-required' });
  }
  if (params['renewals'].length < 1 || params['renewals'].length > MAX_ATTEMPT_RENEWALS) {
    throw new RpcFailure('malformed-request', { reason: 'renewals' });
  }
  const renewals: AttemptRenewalRequest[] = [];
  for (const entry of params['renewals']) {
    if (!isRecord(entry) || !isBoundedId(entry['attemptId']) || !isBoundedId(entry['incarnation'])) {
      throw new RpcFailure('malformed-request', { reason: 'renewal' });
    }
    const fence = entry['fence'];
    if (typeof fence !== 'number' || !Number.isSafeInteger(fence) || fence < 1) {
      throw new RpcFailure('malformed-request', { reason: 'fence' });
    }
    renewals.push({ attemptId: entry['attemptId'], incarnation: entry['incarnation'], fence });
  }
  return { renewals };
}

interface ParsedAttemptReport {
  attemptId: string;
  incarnation: string;
  fence: number;
  outcome: 'completed' | 'failed';
  /** Pre-serialized result JSON; null when absent. */
  resultJson: string | null;
  error: string | undefined;
}

function parseAttemptReportParams(params: unknown): ParsedAttemptReport {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'report-params' });
  }
  const attemptId = params['attemptId'];
  const incarnation = params['incarnation'];
  const fence = params['fence'];
  const outcome = params['outcome'];
  if (!isBoundedId(attemptId)) {
    throw new RpcFailure('malformed-request', { reason: 'attemptId' });
  }
  if (!isBoundedId(incarnation)) {
    throw new RpcFailure('malformed-request', { reason: 'incarnation' });
  }
  if (typeof fence !== 'number' || !Number.isSafeInteger(fence) || fence < 1) {
    throw new RpcFailure('malformed-request', { reason: 'fence' });
  }
  if (outcome !== 'completed' && outcome !== 'failed') {
    throw new RpcFailure('malformed-request', { reason: 'outcome' });
  }
  let resultJson: string | null = null;
  if (Object.prototype.hasOwnProperty.call(params, 'result')) {
    resultJson = JSON.stringify(params['result']);
    const resultBytes = utf8ByteLength(resultJson);
    if (resultBytes > MAX_REPORT_RESULT_BYTES) {
      throw new RpcFailure('payload-too-large', {
        limitBytes: MAX_REPORT_RESULT_BYTES,
        actualBytes: resultBytes,
        field: 'result',
      });
    }
  }
  const error = params['error'];
  if (
    error !== undefined &&
    (typeof error !== 'string' || error.length === 0 || error.length > MAX_REPORT_ERROR_LENGTH)
  ) {
    throw new RpcFailure('malformed-request', { reason: 'error' });
  }
  return { attemptId, incarnation, fence, outcome, resultJson, error };
}

// ---- MESH-03 param/storage parsing + socket helpers ---------------------------

const DURABLE_EVENT_KINDS: readonly string[] = [
  'job.created',
  'job.state',
  'attempt.created',
  'attempt.state',
  'approval.requested',
  'approval.decided',
  'artifact.reserved',
  'artifact.published',
  'artifact.deleted',
  'artifact.expired',
  'activity',
  'gap',
];
const APPROVAL_STATES: readonly string[] = [
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
];
const ARTIFACT_STATES: readonly string[] = [
  'reserved',
  'uploaded',
  'published',
  'deleting',
  'deleted',
  'expired',
];

function isDurableEventKind(value: unknown): value is DurableEventKind {
  return typeof value === 'string' && DURABLE_EVENT_KINDS.includes(value);
}

function isApprovalState(value: unknown): value is ApprovalState {
  return typeof value === 'string' && APPROVAL_STATES.includes(value);
}

function isArtifactState(value: unknown): value is ArtifactState {
  return typeof value === 'string' && ARTIFACT_STATES.includes(value);
}

/** Hex-encodes an ArrayBuffer digest (R2 object verification). */
function hexEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Sanitized socket-error text: the machine reason, never internals. */
function socketErrorMessage(error: RpcFailure): string {
  const reason = error.details?.['reason'];
  return typeof reason === 'string' ? reason : error.code;
}

/** Reads + sanitizes the subscription list off a socket attachment. */
function attachmentSubscriptions(attachment: SocketAttachment): SocketSubscription[] {
  const raw = attachment.subscriptions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SocketSubscription[] = [];
  for (const entry of raw) {
    if (
      isRecord(entry) &&
      isBoundedId(entry['subscriptionId']) &&
      isBoundedId(entry['scope']) &&
      typeof entry['afterSequence'] === 'number' &&
      Number.isSafeInteger(entry['afterSequence']) &&
      entry['afterSequence'] >= 0 &&
      typeof entry['expiresAt'] === 'number' &&
      Number.isFinite(entry['expiresAt'])
    ) {
      out.push({
        subscriptionId: entry['subscriptionId'],
        scope: entry['scope'],
        afterSequence: entry['afterSequence'],
        expiresAt: entry['expiresAt'],
      });
    }
  }
  return out;
}

/**
 * Validates an `activity` payload. `byteLength` must equal the wire text's
 * UTF-8 length so journaled and forwarded sizes always agree.
 */
function parseActivityPayload(value: unknown): ActivityPayload {
  if (!isRecord(value)) {
    throw new RpcFailure('malformed-request', { reason: 'payload' });
  }
  const kind = value['kind'];
  if (kind !== 'stdout' && kind !== 'stderr' && kind !== 'status') {
    throw new RpcFailure('malformed-request', { reason: 'payload.kind' });
  }
  const text = value['text'];
  if (typeof text !== 'string') {
    throw new RpcFailure('malformed-request', { reason: 'payload.text' });
  }
  const textBytes = utf8ByteLength(text);
  if (textBytes > MAX_ACTIVITY_TEXT_BYTES) {
    throw new RpcFailure('payload-too-large', {
      reason: 'payload.text',
      limitBytes: MAX_ACTIVITY_TEXT_BYTES,
      actualBytes: textBytes,
    });
  }
  const byteLength = value['byteLength'];
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RpcFailure('malformed-request', { reason: 'payload.byteLength' });
  }
  if (byteLength !== textBytes) {
    throw new RpcFailure('malformed-request', { reason: 'payload.byteLength-mismatch' });
  }
  const truncated = value['truncated'];
  if (typeof truncated !== 'boolean') {
    throw new RpcFailure('malformed-request', { reason: 'payload.truncated' });
  }
  return { kind, text, byteLength, truncated };
}

function parseEventPullParams(params: unknown): {
  scope: string;
  after: number;
  limit: number;
} {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'pull-params' });
  }
  const scope = params['scope'];
  if (!isBoundedId(scope)) {
    throw new RpcFailure('malformed-request', { reason: 'scope' });
  }
  const afterRaw = params['afterSequence'];
  let after = 0;
  if (afterRaw !== undefined && afterRaw !== null) {
    if (typeof afterRaw !== 'number' || !Number.isSafeInteger(afterRaw) || afterRaw < 0) {
      throw new RpcFailure('malformed-request', { reason: 'afterSequence' });
    }
    after = afterRaw;
  }
  const limit = params['limit'];
  if (
    limit !== undefined &&
    (typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > EVENT_PULL_MAX_LIMIT)
  ) {
    throw new RpcFailure('malformed-request', { reason: 'limit' });
  }
  return { scope, after, limit: limit ?? EVENT_PULL_DEFAULT_LIMIT };
}

function parseApprovalGetParams(params: unknown): {
  approvalId?: string;
  jobId?: string;
  attemptId?: string;
} {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'get-params' });
  }
  const approvalId = params['approvalId'];
  const jobId = params['jobId'];
  const attemptId = params['attemptId'];
  if (approvalId !== undefined && !isBoundedId(approvalId)) {
    throw new RpcFailure('malformed-request', { reason: 'approvalId' });
  }
  if (jobId !== undefined && !isBoundedId(jobId)) {
    throw new RpcFailure('malformed-request', { reason: 'jobId' });
  }
  if (attemptId !== undefined && !isBoundedId(attemptId)) {
    throw new RpcFailure('malformed-request', { reason: 'attemptId' });
  }
  const count =
    (approvalId === undefined ? 0 : 1) +
    (jobId === undefined ? 0 : 1) +
    (attemptId === undefined ? 0 : 1);
  if (count !== 1) {
    throw new RpcFailure('malformed-request', { reason: 'selector' });
  }
  return {
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(attemptId === undefined ? {} : { attemptId }),
  };
}

function parseApprovalDecideParams(params: unknown): {
  approvalId: string;
  decision: 'approved' | 'denied';
  reason?: string;
} {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'decide-params' });
  }
  const approvalId = params['approvalId'];
  if (!isBoundedId(approvalId)) {
    throw new RpcFailure('malformed-request', { reason: 'approvalId' });
  }
  const decision = params['decision'];
  if (decision !== 'approved' && decision !== 'denied') {
    throw new RpcFailure('malformed-request', { reason: 'decision' });
  }
  const reason = params['reason'];
  if (
    reason !== undefined &&
    (typeof reason !== 'string' ||
      reason.length === 0 ||
      reason.length > MAX_APPROVAL_REASON_LENGTH)
  ) {
    throw new RpcFailure('malformed-request', { reason: 'reason' });
  }
  return { approvalId, decision, ...(reason === undefined ? {} : { reason }) };
}

function parseArtifactReserveParams(params: unknown): {
  attemptId: string;
  byteLength: number;
  sha256: string;
  mediaType: string;
  retentionDays: number;
} {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'reserve-params' });
  }
  const attemptId = params['attemptId'];
  if (!isBoundedId(attemptId)) {
    throw new RpcFailure('malformed-request', { reason: 'attemptId' });
  }
  const byteLength = params['byteLength'];
  if (
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1
  ) {
    throw new RpcFailure('malformed-request', { reason: 'byteLength' });
  }
  if (byteLength > ARTIFACT_MAX_BYTES) {
    throw new RpcFailure('payload-too-large', {
      reason: 'artifact-bytes',
      limitBytes: ARTIFACT_MAX_BYTES,
      actualBytes: byteLength,
    });
  }
  const sha256 = params['sha256'];
  if (typeof sha256 !== 'string' || !HASH_PATTERN.test(sha256)) {
    throw new RpcFailure('malformed-request', { reason: 'sha256' });
  }
  const mediaType = params['mediaType'];
  if (
    typeof mediaType !== 'string' ||
    mediaType.length === 0 ||
    mediaType.length > MAX_MEDIA_TYPE_LENGTH
  ) {
    throw new RpcFailure('malformed-request', { reason: 'mediaType' });
  }
  const retentionDays = params['retentionDays'];
  if (
    retentionDays !== undefined &&
    (typeof retentionDays !== 'number' ||
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > ARTIFACT_MAX_RETENTION_DAYS)
  ) {
    throw new RpcFailure('malformed-request', { reason: 'retentionDays' });
  }
  return {
    attemptId,
    byteLength,
    sha256,
    mediaType,
    retentionDays: retentionDays ?? ARTIFACT_DEFAULT_RETENTION_DAYS,
  };
}

function parseArtifactFinalizeParams(params: unknown): {
  artifactId: string;
  byteLength: number;
  sha256: string;
} {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'finalize-params' });
  }
  const artifactId = params['artifactId'];
  if (!isBoundedId(artifactId)) {
    throw new RpcFailure('malformed-request', { reason: 'artifactId' });
  }
  const byteLength = params['byteLength'];
  if (
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1
  ) {
    throw new RpcFailure('malformed-request', { reason: 'byteLength' });
  }
  const sha256 = params['sha256'];
  if (typeof sha256 !== 'string' || !HASH_PATTERN.test(sha256)) {
    throw new RpcFailure('malformed-request', { reason: 'sha256' });
  }
  return { artifactId, byteLength, sha256 };
}

function parseArtifactIdParams(params: unknown): { artifactId: string } {
  if (!isRecord(params) || !isBoundedId(params['artifactId'])) {
    throw new RpcFailure('malformed-request', { reason: 'artifactId' });
  }
  return { artifactId: params['artifactId'] };
}

function parseArtifactListParams(params: unknown): {
  jobId?: string;
  attemptId?: string;
  state?: ArtifactState;
  limit: number;
} {
  if (!isRecord(params)) {
    throw new RpcFailure('malformed-request', { reason: 'list-params' });
  }
  const jobId = params['jobId'];
  const attemptId = params['attemptId'];
  if (jobId !== undefined && !isBoundedId(jobId)) {
    throw new RpcFailure('malformed-request', { reason: 'jobId' });
  }
  if (attemptId !== undefined && !isBoundedId(attemptId)) {
    throw new RpcFailure('malformed-request', { reason: 'attemptId' });
  }
  if (jobId === undefined && attemptId === undefined) {
    throw new RpcFailure('malformed-request', { reason: 'scope' });
  }
  const state = params['state'];
  if (state !== undefined && !isArtifactState(state)) {
    throw new RpcFailure('malformed-request', { reason: 'state' });
  }
  const limit = params['limit'];
  if (
    limit !== undefined &&
    (typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_ARTIFACT_LIST_LIMIT)
  ) {
    throw new RpcFailure('malformed-request', { reason: 'limit' });
  }
  return {
    ...(jobId === undefined ? {} : { jobId }),
    ...(attemptId === undefined ? {} : { attemptId }),
    ...(state === undefined ? {} : { state }),
    limit: limit ?? DEFAULT_ARTIFACT_LIST_LIMIT,
  };
}
