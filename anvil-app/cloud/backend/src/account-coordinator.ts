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
  type SocketFrame,
  type SyncInvalidateFrame,
  type WorkerAvailableFrame,
} from '../../contract/socket';
import type { SyncAccountStats } from '../../contract/auth';
import {
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
  SNAPSHOT_LIFETIME_MS,
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
   * sockets, not the connecting device's. MESH-02's `job.available` fanout
   * lands here as one call.
   */
  private emitSocketFrame(frame: SocketFrame, options?: { excludeEnrollmentId?: string }): void {
    const encoded = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets()) {
      if (options?.excludeEnrollmentId !== undefined) {
        const attachment = socket.deserializeAttachment();
        if (
          isSocketAttachment(attachment) &&
          attachment.enrollmentId === options.excludeEnrollmentId
        ) {
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
    continued: boolean;
  }> {
    const cutoff = now - RETENTION_MS;
    const workerCutoff = now - WORKER_AUDIT_RETENTION_MS;
    let deletedChanges = 0;
    let deletedReceipts = 0;
    let deletedScans = 0;
    let deletedWorkers = 0;
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
      if (freedBytes > 0) {
        this.addHistoryBytes(-freedBytes);
      }
      this.bumpCounter('sweep_changes_deleted', deletedChanges);
      this.bumpCounter('sweep_receipts_deleted', deletedReceipts);
      this.bumpCounter('sweep_scans_deleted', deletedScans);
      this.bumpCounter('sweep_workers_deleted', deletedWorkers);
    });
    const continued =
      deletedChanges === SWEEP_BATCH_ROWS ||
      deletedReceipts === SWEEP_BATCH_ROWS ||
      deletedWorkers === SWEEP_BATCH_ROWS;
    await this.ctx.storage.setAlarm(
      Date.now() + (continued ? SWEEP_CONTINUE_MS : SWEEP_INTERVAL_MS),
    );
    return { deletedChanges, deletedReceipts, deletedScans, deletedWorkers, continued };
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
