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
  RpcFailure,
  rpcErrorResponse,
  rpcSuccessResponse,
} from './rpc';
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
  type JobAvailableFrame,
  type SocketFrame,
  type SyncInvalidateFrame,
  type WorkerAvailableFrame,
} from '../../contract/socket';
import type { SyncAccountStats } from '../../contract/auth';
import {
  ATTEMPT_TRANSITIONS,
  canTransitionJob,
  type AttemptReportResult,
  type AttemptRenewParams,
  type AttemptRenewResult,
  type AttemptRenewalRequest,
  type AttemptRenewalResult,
  type AttemptState,
  type CapabilityRequirements,
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
  SNAPSHOT_LIFETIME_MS,
  USER_JOB_DEADLINE_MS,
  WORKER_LEASE_MS,
} from '../../contract/version';

interface SocketAttachment {
  accountId: string;
  enrollmentId: string;
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

  async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment();
    if (!isSocketAttachment(attachment)) {
      ws.close(1008, 'unauthenticated');
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    ws.close(code, reason);
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
      outcome = this.ctx.storage.transactionSync(() =>
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
    const result = this.ctx.storage.transactionSync(() => this.beginScan(begin.epoch));
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
    const result = this.ctx.storage.transactionSync(() =>
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
    const result = this.ctx.storage.transactionSync(() => this.finishScan(finish.scanId));
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
    this.ctx.storage.transactionSync(() => {
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
    const created = this.ctx.storage.transactionSync(() => {
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
    const result = this.ctx.storage.transactionSync(() => {
      this.expireQueuedJobs(Date.now());
      const job = this.readJob(jobId);
      if (job === null) {
        throw new RpcFailure('not-found', { reason: 'job' });
      }
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
    const result = this.ctx.storage.transactionSync(() => {
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
    const result = this.ctx.storage.transactionSync(() => {
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
    this.ctx.storage.transactionSync(() => {
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
    const reported = this.ctx.storage.transactionSync(() => {
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
    const result = this.ctx.storage.transactionSync(() => {
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
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET state = 'failed', state_reason = 'queue-deadline',
           active_attempt_id = NULL, updated_at = ?
         WHERE job_id = ?`,
        now,
        row.job_id,
      );
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
    continued: boolean;
  }> {
    const cutoff = now - RETENTION_MS;
    const workerCutoff = now - WORKER_AUDIT_RETENTION_MS;
    let deletedChanges = 0;
    let deletedReceipts = 0;
    let deletedScans = 0;
    let deletedWorkers = 0;
    let expiredJobs = 0;
    let staleAttempts = 0;
    let freedBytes = 0;
    let maxDeletedSequence: number | null = null;
    this.ctx.storage.transactionSync(() => {
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
        this.ctx.storage.sql.exec(
          "UPDATE attempts SET state = 'unknown-outcome', updated_at = ? WHERE attempt_id = ?",
          now,
          row.attempt_id,
        );
        staleAttempts += 1;
      }
      if (freedBytes > 0) {
        this.addHistoryBytes(-freedBytes);
      }
      this.bumpCounter('sweep_changes_deleted', deletedChanges);
      this.bumpCounter('sweep_receipts_deleted', deletedReceipts);
      this.bumpCounter('sweep_scans_deleted', deletedScans);
      this.bumpCounter('sweep_workers_deleted', deletedWorkers);
      this.bumpCounter('sweep_attempts_unknown', staleAttempts);
    });
    const continued =
      deletedChanges === SWEEP_BATCH_ROWS ||
      deletedReceipts === SWEEP_BATCH_ROWS ||
      deletedWorkers === SWEEP_BATCH_ROWS ||
      expiredJobs === SWEEP_BATCH_ROWS ||
      staleAttempts === SWEEP_BATCH_ROWS;
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
    return {
      historyBytes: this.readHistoryBytes(),
      historyQuotaBytes: HISTORY_QUOTA_BYTES,
      retentionFloor: this.readRetentionFloor(),
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
