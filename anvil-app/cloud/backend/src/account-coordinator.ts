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
import { SOCKET_FRAME_VERSION, type SyncInvalidateFrame } from '../../contract/socket';
import type { SyncAccountStats } from '../../contract/auth';
import {
  SOCKET_SUBPROTOCOL,
  DEFAULT_LIMITS,
  SNAPSHOT_LIFETIME_MS,
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
      // Worker-internal: close every socket attached to a revoked enrollment.
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
      return Response.json({ closed });
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
    const encoded = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets()) {
      socket.send(encoded);
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
    continued: boolean;
  }> {
    const cutoff = now - RETENTION_MS;
    let deletedChanges = 0;
    let deletedReceipts = 0;
    let deletedScans = 0;
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
      if (freedBytes > 0) {
        this.addHistoryBytes(-freedBytes);
      }
      this.bumpCounter('sweep_changes_deleted', deletedChanges);
      this.bumpCounter('sweep_receipts_deleted', deletedReceipts);
      this.bumpCounter('sweep_scans_deleted', deletedScans);
    });
    const continued =
      deletedChanges === SWEEP_BATCH_ROWS || deletedReceipts === SWEEP_BATCH_ROWS;
    await this.ctx.storage.setAlarm(
      Date.now() + (continued ? SWEEP_CONTINUE_MS : SWEEP_INTERVAL_MS),
    );
    return { deletedChanges, deletedReceipts, deletedScans, continued };
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
