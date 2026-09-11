import { DurableObject } from 'cloudflare:workers';

import type { SpikeAuth } from './auth';
import { parseSpikeAuth } from './auth';
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
  type SyncCursor,
  type SyncOperation,
  type SyncPullResult,
  type SyncPushItemResult,
  type SyncPushResult,
  type SyncedChange,
} from '../../contract/sync';
import { SOCKET_FRAME_VERSION, type SyncInvalidateFrame } from '../../contract/socket';
import { SOCKET_SUBPROTOCOL, DEFAULT_LIMITS } from '../../contract/version';

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

interface PushBatchOutcome {
  results: SyncPushItemResult[];
  acceptedWatermark: number | null;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

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
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.acceptClient(request);
    }
    if (request.method === 'POST') {
      return this.handleRpc(request);
    }
    return rpcErrorResponse(undefined, 'malformed-request');
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
    const auth = parseSpikeAuth(request.headers.get('Authorization'));
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
    const auth = parseSpikeAuth(request.headers.get('Authorization'));
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
      if (storedEpoch !== SPIKE_INITIAL_EPOCH) {
        const resetItem: SyncPushItemResult = {
          status: 'reset-required',
          changeId: item.change.changeId,
          epoch: storedEpoch,
        };
        this.writeReceipt(auth.enrollmentId, item, resetItem);
        this.advanceHighWater(auth.enrollmentId, item.change.enrollmentSequence);
        results.push(resetItem);
        continue;
      }
      const applied = this.applyPrepared(auth, item);
      results.push(applied.item);
      if (applied.acceptedSequence !== null) {
        acceptedWatermark = applied.acceptedSequence;
      }
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
    return { item: accepted, acceptedSequence: sequence };
  }

  private handlePull(requestId: string, params: unknown): Response {
    const pull = parseSpikePullParams(params);
    const after = pull.cursor;
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
