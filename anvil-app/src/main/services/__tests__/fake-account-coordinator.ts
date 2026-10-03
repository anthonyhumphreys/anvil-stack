import { createHash } from 'node:crypto';
import {
  httpStatusForErrorCode,
  type ErrorCode,
  type RpcError,
  type RpcSuccess,
} from '../../../../cloud/contract/envelope';
import {
  canonicalChangeHashInput,
  type PendingChange,
  type PushItemAccepted,
  type ScannedEntity,
  type SyncCursor,
  type SyncOperation,
  type SyncPullParams,
  type SyncPullResult,
  type SyncPushItemResult,
  type SyncPushParams,
  type SyncPushResult,
  type SyncScanBeginParams,
  type SyncScanBeginResult,
  type SyncScanFinishResult,
  type SyncScanPageResult,
  type SyncedChange,
} from '../../../../cloud/contract/sync';
import { DEFAULT_LIMITS, PROTOCOL } from '../../../../cloud/contract/version';

/**
 * Node-side stand-in for BACKEND-01 `AccountCoordinator` apply rules
 * (receipts, base revision, sequences). It speaks the contract push/pull
 * envelopes over injected `fetch` so SYNC-03 can round-trip in Node vitest
 * without importing `cloud/backend` into Electron src.
 *
 * The workerd Durable Object proof lives in `cloud/backend` vitest.
 */

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SPIKE_INITIAL_EPOCH = 'spike-epoch-1';
const SPIKE_AUTH = /^Bearer\s+spike:([^:\s]+):([^:\s]+)\s*$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

interface SpikeAuth {
  accountId: string;
  enrollmentId: string;
}

interface EnrollmentState {
  accountId: string;
  highWater: number;
}

interface EntityRow {
  revision: number;
  operation: SyncOperation;
  payload: unknown | null;
  schemaVersion: number;
}

interface ReceiptRow {
  contentHash: string;
  result: SyncPushItemResult;
}

interface PreparedChange {
  change: PendingChange;
  payloadJson: string | null;
  entityBytes: number;
  computedHash: string;
}

interface FakeScanState {
  scanId: string;
  watermarkStart: number;
  epoch: string;
  done: boolean;
}

/** One-shot failure injected for the next call to the named operation. */
type InjectedFailureMode = 'reject' | 'drop-response';

class FakeRpcFailure extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, details?: Record<string, unknown>) {
    super(code);
    this.name = 'FakeRpcFailure';
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSyncOperation(value: unknown): value is SyncOperation {
  return value === 'create' || value === 'update' || value === 'delete';
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function retryableFor(code: ErrorCode): boolean {
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

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (headers === undefined) return null;
  const needle = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === needle);
    return found?.[1] ?? null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === needle && typeof value === 'string') return value;
  }
  return null;
}

function parseSpikeAuth(header: string | null): SpikeAuth | null {
  if (header === null) return null;
  const match = SPIKE_AUTH.exec(header);
  if (match === null) return null;
  const accountId = match[1];
  const enrollmentId = match[2];
  if (accountId === undefined || enrollmentId === undefined) return null;
  if (!ID_PATTERN.test(accountId) || !ID_PATTERN.test(enrollmentId)) return null;
  return { accountId, enrollmentId };
}

function entityKey(entityType: string, entityId: string): string {
  return `${entityType}\0${entityId}`;
}

function receiptKey(enrollmentId: string, enrollmentSequence: number): string {
  return `${enrollmentId}\0${enrollmentSequence}`;
}

export class FakeAccountCoordinator {
  /** Injected as `fetchFn` into the BYOB-01 `rpc` client. */
  readonly fetch: typeof fetch = (input, init) => this.dispatchFetch(input, init);

  private epoch = SPIKE_INITIAL_EPOCH;
  private nextSequence = 1;
  private readonly enrollments = new Map<string, EnrollmentState>();
  private readonly entities = new Map<string, EntityRow>();
  private readonly receipts = new Map<string, ReceiptRow>();
  private readonly log: SyncedChange[] = [];
  private readonly scans = new Map<string, FakeScanState>();
  private readonly failureQueue: Array<{
    operation: string;
    mode: InjectedFailureMode;
  }> = [];

  /**
   * Queues a one-shot failure for the next call to `operation`:
   * - 'reject': the call fails before executing (clean transport error).
   * - 'drop-response': the mutation executes and commits, but the client sees
   *   a transport error — the lost-acknowledgement case.
   */
  injectFailure(operation: string, mode: InjectedFailureMode): void {
    this.failureQueue.push({ operation, mode });
  }

  /** Rotates the dataset epoch (server restore). Subsequent pushes get reset-required. */
  rotateEpoch(epoch: string): void {
    this.epoch = epoch;
  }

  private takeFailure(operation: string): InjectedFailureMode | null {
    const index = this.failureQueue.findIndex((entry) => entry.operation === operation);
    if (index === -1) return null;
    const [failure] = this.failureQueue.splice(index, 1);
    return failure.mode;
  }

  private currentWatermark(): number {
    return this.nextSequence - 1;
  }

  push(auth: SpikeAuth, params: SyncPushParams): SyncPushResult {
    const prepared = this.prepareBatch(params.changes);
    this.provisionEnrollment(auth);
    this.assertBatchStructure(prepared);
    if (params.epoch !== undefined && params.epoch !== this.epoch) {
      throw new FakeRpcFailure('epoch-mismatch', { expected: this.epoch, actual: params.epoch });
    }
    const results: SyncPushItemResult[] = [];
    for (const item of prepared) {
      results.push(this.applyPrepared(auth, item));
    }
    return { results };
  }

  pull(params: SyncPullParams): SyncPullResult {
    const after = parseCursor(params.cursor);
    const maxChanges = params.maxChanges ?? DEFAULT_LIMITS.batchChanges;
    const maxBytes = Math.min(params.maxBytes, DEFAULT_LIMITS.pageBytes);
    const remainingRows = this.log.filter((change) => change.sequence > after);
    const changes: SyncedChange[] = [];
    let usedBytes = 0;
    let lastSequence = after;
    let hasMore = false;
    for (let index = 0; index < remainingRows.length; index += 1) {
      const synced = remainingRows[index];
      const encoded = JSON.stringify(synced);
      const size = utf8ByteLength(encoded);
      const wouldExceedBytes = changes.length > 0 && usedBytes + size > maxBytes;
      const wouldExceedCount = changes.length >= maxChanges;
      if (wouldExceedBytes || wouldExceedCount) {
        hasMore = true;
        break;
      }
      changes.push(synced);
      usedBytes += size;
      lastSequence = synced.sequence;
    }
    if (!hasMore && changes.length < remainingRows.length) {
      hasMore = true;
    }
    return {
      changes,
      nextCursor: String(lastSequence) as SyncCursor,
      hasMore,
    };
  }

  private async dispatchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method !== 'POST') {
      return errorResponse(undefined, 'malformed-request');
    }
    const authorization =
      headerValue(init?.headers, 'Authorization') ??
      (input instanceof Request ? input.headers.get('Authorization') : null);
    const auth = parseSpikeAuth(authorization);
    if (auth === null) {
      return errorResponse(undefined, 'unauthenticated');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(input, init)) as unknown;
    } catch {
      return errorResponse(undefined, 'malformed-request');
    }
    if (!isRecord(parsed)) {
      return errorResponse(undefined, 'malformed-request');
    }
    const requestIdRaw = parsed['requestId'];
    const requestId =
      typeof requestIdRaw === 'string' && requestIdRaw.length > 0 ? requestIdRaw : undefined;
    if (requestId === undefined) {
      return errorResponse(undefined, 'malformed-request');
    }
    if (parsed['protocol'] !== PROTOCOL) {
      return errorResponse(requestId, 'unsupported-version');
    }
    const operation = parsed['operation'];
    if (typeof operation !== 'string' || operation.length === 0) {
      return errorResponse(requestId, 'malformed-request');
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, 'params')) {
      return errorResponse(requestId, 'malformed-request');
    }
    try {
      const injected = this.takeFailure(operation);
      if (injected === 'reject') {
        return errorResponse(requestId, 'unavailable');
      }
      let result: unknown;
      switch (operation) {
        case 'sync.push': {
          result = this.push(auth, parsePushParams(parsed['params']));
          break;
        }
        case 'sync.pull': {
          result = this.pull(parsePullParams(parsed['params']));
          break;
        }
        case 'sync.scan.begin': {
          result = this.scanBegin(parseScanBeginParams(parsed['params']));
          break;
        }
        case 'sync.scan.page': {
          result = this.scanPage(parseScanPageParams(parsed['params']));
          break;
        }
        case 'sync.scan.finish': {
          result = this.scanFinish(parseScanFinishParams(parsed['params']));
          break;
        }
        default:
          return errorResponse(requestId, 'unsupported-operation');
      }
      if (injected === 'drop-response') {
        // Server committed; the client only sees a transport failure.
        return errorResponse(requestId, 'unavailable');
      }
      return successResponse(requestId, result);
    } catch (error) {
      if (error instanceof FakeRpcFailure) {
        return errorResponse(requestId, error.code, error.details);
      }
      return errorResponse(requestId, 'unavailable');
    }
  }

  private scanBegin(params: SyncScanBeginParams): SyncScanBeginResult {
    if (params.epoch !== undefined && params.epoch !== null && params.epoch !== this.epoch) {
      throw new FakeRpcFailure('epoch-mismatch', { expected: this.epoch, actual: params.epoch });
    }
    const watermarkStart = this.currentWatermark();
    const scan: FakeScanState = {
      scanId: `scan-${this.scans.size + 1}`,
      watermarkStart,
      epoch: this.epoch,
      done: false,
    };
    this.scans.set(scan.scanId, scan);
    return {
      scanId: scan.scanId,
      watermarkStart,
      resumeCursor: String(watermarkStart) as SyncCursor,
      epoch: this.epoch,
    };
  }

  private scanPage(params: {
    scanId: string;
    cursor: string | null;
    maxBytes: number;
  }): SyncScanPageResult {
    const scan = this.loadScan(params.scanId);
    const after = params.cursor === null ? null : (JSON.parse(params.cursor) as [string, string]);
    const rows = [...this.entities.entries()]
      .filter(([, row]) => row.operation !== 'delete')
      .map(([key, row]) => {
        const [entityType, entityId] = key.split('\0') as [string, string];
        return { entityType, entityId, row };
      })
      .sort((a, b) =>
        a.entityType === b.entityType
          ? a.entityId < b.entityId
            ? -1
            : a.entityId > b.entityId
              ? 1
              : 0
          : a.entityType < b.entityType
            ? -1
            : 1,
      )
      .filter(
        (entry) =>
          after === null ||
          entry.entityType > after[0] ||
          (entry.entityType === after[0] && entry.entityId > after[1]),
      );
    const maxBytes = Math.min(params.maxBytes, DEFAULT_LIMITS.pageBytes);
    const entities: ScannedEntity[] = [];
    let usedBytes = 0;
    let remaining = false;
    for (const entry of rows) {
      const scanned: ScannedEntity = {
        entityType: entry.entityType,
        entityId: entry.entityId,
        revision: entry.row.revision,
        schemaVersion: entry.row.schemaVersion,
        payload: entry.row.payload,
      };
      const size = utf8ByteLength(JSON.stringify(scanned));
      if (entities.length > 0 && usedBytes + size > maxBytes) {
        remaining = true;
        break;
      }
      entities.push(scanned);
      usedBytes += size;
    }
    const last = entities[entities.length - 1];
    scan.done = !remaining;
    return {
      entities,
      nextCursor: remaining && last ? JSON.stringify([last.entityType, last.entityId]) : null,
      done: scan.done,
    };
  }

  private scanFinish(params: { scanId: string }): SyncScanFinishResult {
    const scan = this.loadScan(params.scanId);
    if (!scan.done) {
      throw new FakeRpcFailure('malformed-request', { reason: 'scan-incomplete' });
    }
    const watermarkEnd = this.currentWatermark();
    return {
      scanId: scan.scanId,
      complete: true,
      watermarkEnd,
      epoch: this.epoch,
      nextCursor: String(watermarkEnd) as SyncCursor,
    };
  }

  private loadScan(scanId: string): FakeScanState {
    const scan = this.scans.get(scanId);
    if (scan === undefined) {
      throw new FakeRpcFailure('not-found', { reason: 'scan' });
    }
    if (scan.epoch !== this.epoch) {
      throw new FakeRpcFailure('epoch-mismatch', { expected: this.epoch, actual: scan.epoch });
    }
    return scan;
  }

  private prepareBatch(changes: PendingChange[]): PreparedChange[] {
    return changes.map((change) => {
      const payloadJson = change.operation === 'delete' ? null : JSON.stringify(change.payload);
      return {
        change,
        payloadJson,
        entityBytes: payloadJson === null ? 0 : utf8ByteLength(payloadJson),
        computedHash: sha256Hex(canonicalChangeHashInput(change)),
      };
    });
  }

  private assertBatchStructure(prepared: PreparedChange[]): void {
    if (prepared.length > DEFAULT_LIMITS.batchChanges) {
      throw new FakeRpcFailure('payload-too-large', {
        limit: DEFAULT_LIMITS.batchChanges,
        actual: prepared.length,
      });
    }
    let totalBytes = 0;
    for (const item of prepared) {
      assertPendingChange(item.change);
      if (item.computedHash !== item.change.payloadHash) {
        throw new FakeRpcFailure('malformed-request', {
          reason: 'payload-hash-mismatch',
          changeId: item.change.changeId,
        });
      }
      if (item.entityBytes > DEFAULT_LIMITS.entityBytes) {
        throw new FakeRpcFailure('payload-too-large', {
          limitBytes: DEFAULT_LIMITS.entityBytes,
          actualBytes: item.entityBytes,
          entityType: item.change.entityType,
        });
      }
      totalBytes += item.entityBytes;
    }
    if (totalBytes > DEFAULT_LIMITS.pageBytes) {
      throw new FakeRpcFailure('payload-too-large', {
        limitBytes: DEFAULT_LIMITS.pageBytes,
        actualBytes: totalBytes,
      });
    }
  }

  private applyPrepared(auth: SpikeAuth, item: PreparedChange): SyncPushItemResult {
    const { change } = item;
    const existingReceipt = this.receipts.get(
      receiptKey(auth.enrollmentId, change.enrollmentSequence),
    );
    if (existingReceipt) {
      if (existingReceipt.contentHash === change.payloadHash) {
        return existingReceipt.result;
      }
      return { status: 'rejected', changeId: change.changeId, reason: 'changed-content' };
    }

    const enrollment = this.readEnrollment(auth.enrollmentId);
    if (change.enrollmentSequence <= enrollment.highWater) {
      const expired: SyncPushItemResult = { status: 'receipt-expired', changeId: change.changeId };
      this.writeReceipt(auth.enrollmentId, item, expired);
      return expired;
    }

    if (this.epoch !== SPIKE_INITIAL_EPOCH) {
      const resetItem: SyncPushItemResult = {
        status: 'reset-required',
        changeId: change.changeId,
        epoch: this.epoch,
      };
      this.writeReceipt(auth.enrollmentId, item, resetItem);
      this.advanceHighWater(auth.enrollmentId, change.enrollmentSequence);
      return resetItem;
    }

    const existing = this.entities.get(entityKey(change.entityType, change.entityId)) ?? null;
    const compared = compareBaseRevision(change, existing);
    if (compared !== null) {
      this.writeReceipt(auth.enrollmentId, item, compared);
      this.advanceHighWater(auth.enrollmentId, change.enrollmentSequence);
      return compared;
    }

    const sequence = this.nextSequence;
    const revision = existing === null ? 1 : existing.revision + 1;
    const payload = change.operation === 'delete' ? null : (change.payload ?? null);
    this.entities.set(entityKey(change.entityType, change.entityId), {
      operation: change.operation,
      payload,
      revision,
      schemaVersion: change.schemaVersion,
    });
    const synced: SyncedChange = {
      entityType: change.entityType,
      entityId: change.entityId,
      revision,
      operation: change.operation,
      schemaVersion: change.schemaVersion,
      sequence,
      ...(payload === null ? {} : { payload }),
    };
    this.log.push(synced);
    const accepted: PushItemAccepted = {
      status: 'accepted',
      changeId: change.changeId,
      revision,
      ...(change.operation === 'delete' ? {} : { content: change.payload }),
    };
    this.writeReceipt(auth.enrollmentId, item, accepted);
    this.nextSequence = sequence + 1;
    this.advanceHighWater(auth.enrollmentId, change.enrollmentSequence);
    return accepted;
  }

  private provisionEnrollment(auth: SpikeAuth): void {
    if (this.enrollments.has(auth.enrollmentId)) return;
    this.enrollments.set(auth.enrollmentId, { accountId: auth.accountId, highWater: 0 });
  }

  private readEnrollment(enrollmentId: string): EnrollmentState {
    const enrollment = this.enrollments.get(enrollmentId);
    if (!enrollment) {
      throw new FakeRpcFailure('unavailable', { reason: 'missing-enrollment' });
    }
    return enrollment;
  }

  private writeReceipt(
    enrollmentId: string,
    item: PreparedChange,
    result: SyncPushItemResult,
  ): void {
    this.receipts.set(receiptKey(enrollmentId, item.change.enrollmentSequence), {
      contentHash: item.change.payloadHash,
      result,
    });
  }

  private advanceHighWater(enrollmentId: string, enrollmentSequence: number): void {
    const enrollment = this.readEnrollment(enrollmentId);
    if (enrollment.highWater < enrollmentSequence) {
      enrollment.highWater = enrollmentSequence;
    }
  }
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (typeof init?.body === 'string') return init.body;
  if (input instanceof Request) return input.text();
  throw new FakeRpcFailure('malformed-request', { reason: 'body-required' });
}

function parsePushParams(params: unknown): SyncPushParams {
  if (!isRecord(params) || !Array.isArray(params['changes'])) {
    throw new FakeRpcFailure('malformed-request', { reason: 'changes-required' });
  }
  const changes: PendingChange[] = [];
  for (const entry of params['changes']) {
    changes.push(parsePendingChange(entry));
  }
  const epochRaw = params['epoch'];
  if (epochRaw !== undefined && typeof epochRaw !== 'string') {
    throw new FakeRpcFailure('malformed-request', { reason: 'epoch-type' });
  }
  return { changes, epoch: epochRaw };
}

function parseScanBeginParams(params: unknown): SyncScanBeginParams {
  if (!isRecord(params)) {
    throw new FakeRpcFailure('malformed-request', { reason: 'scan-begin-params' });
  }
  const epoch = params['epoch'];
  if (epoch !== undefined && epoch !== null && typeof epoch !== 'string') {
    throw new FakeRpcFailure('malformed-request', { reason: 'epoch-type' });
  }
  return { epoch };
}

function parseScanPageParams(params: unknown): {
  scanId: string;
  cursor: string | null;
  maxBytes: number;
} {
  if (!isRecord(params)) {
    throw new FakeRpcFailure('malformed-request', { reason: 'scan-page-params' });
  }
  const scanId = params['scanId'];
  if (typeof scanId !== 'string' || scanId.length === 0) {
    throw new FakeRpcFailure('malformed-request', { reason: 'scanId' });
  }
  const cursorRaw = params['cursor'];
  if (cursorRaw !== null && typeof cursorRaw !== 'string') {
    throw new FakeRpcFailure('malformed-request', { reason: 'cursor' });
  }
  const maxBytes = params['maxBytes'];
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new FakeRpcFailure('malformed-request', { reason: 'maxBytes' });
  }
  return { scanId, cursor: cursorRaw, maxBytes };
}

function parseScanFinishParams(params: unknown): { scanId: string } {
  if (!isRecord(params)) {
    throw new FakeRpcFailure('malformed-request', { reason: 'scan-finish-params' });
  }
  const scanId = params['scanId'];
  if (typeof scanId !== 'string' || scanId.length === 0) {
    throw new FakeRpcFailure('malformed-request', { reason: 'scanId' });
  }
  return { scanId };
}

function parsePullParams(params: unknown): SyncPullParams {
  if (!isRecord(params)) {
    throw new FakeRpcFailure('malformed-request', { reason: 'pull-params' });
  }
  if (!Object.prototype.hasOwnProperty.call(params, 'cursor')) {
    throw new FakeRpcFailure('malformed-request', { reason: 'cursor-required' });
  }
  const cursorRaw = params['cursor'];
  let cursor: SyncCursor | null = null;
  if (cursorRaw !== null) {
    if (typeof cursorRaw !== 'string') {
      throw new FakeRpcFailure('malformed-request', { reason: 'cursor-type' });
    }
    cursor = cursorRaw as SyncCursor;
  }
  const maxBytes = params['maxBytes'];
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new FakeRpcFailure('malformed-request', { reason: 'maxBytes' });
  }
  const maxChangesRaw = params['maxChanges'];
  if (maxChangesRaw === undefined) {
    return { cursor, maxBytes };
  }
  if (typeof maxChangesRaw !== 'number' || !Number.isInteger(maxChangesRaw) || maxChangesRaw < 1) {
    throw new FakeRpcFailure('malformed-request', { reason: 'maxChanges' });
  }
  return { cursor, maxBytes, maxChanges: maxChangesRaw };
}

function parseCursor(cursor: SyncCursor | null): number {
  if (cursor === null || cursor === '') return 0;
  if (!/^[0-9]+$/.test(cursor)) {
    throw new FakeRpcFailure('malformed-request', { reason: 'cursor-format' });
  }
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed)) {
    throw new FakeRpcFailure('malformed-request', { reason: 'cursor-range' });
  }
  return parsed;
}

function parsePendingChange(input: unknown): PendingChange {
  if (!isRecord(input)) {
    throw new FakeRpcFailure('malformed-request', { reason: 'change-object' });
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
    throw new FakeRpcFailure('malformed-request', { reason: 'changeId' });
  }
  if (
    typeof enrollmentSequence !== 'number' ||
    !Number.isInteger(enrollmentSequence) ||
    enrollmentSequence < 1
  ) {
    throw new FakeRpcFailure('malformed-request', { reason: 'enrollmentSequence' });
  }
  if (typeof entityType !== 'string' || entityType.length === 0) {
    throw new FakeRpcFailure('malformed-request', { reason: 'entityType' });
  }
  if (typeof entityId !== 'string' || entityId.length === 0) {
    throw new FakeRpcFailure('malformed-request', { reason: 'entityId' });
  }
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new FakeRpcFailure('malformed-request', { reason: 'schemaVersion' });
  }
  if (
    !(baseRevision === null || (typeof baseRevision === 'number' && Number.isInteger(baseRevision)))
  ) {
    throw new FakeRpcFailure('malformed-request', { reason: 'baseRevision' });
  }
  if (!isSyncOperation(operation)) {
    throw new FakeRpcFailure('malformed-request', { reason: 'operation' });
  }
  if (typeof payloadHash !== 'string' || !HASH_PATTERN.test(payloadHash)) {
    throw new FakeRpcFailure('malformed-request', { reason: 'payloadHash' });
  }
  const hasPayload = Object.prototype.hasOwnProperty.call(input, 'payload');
  if (operation === 'delete') {
    if (baseRevision === null) {
      throw new FakeRpcFailure('malformed-request', { reason: 'delete-base' });
    }
    if (hasPayload) {
      throw new FakeRpcFailure('malformed-request', { reason: 'delete-payload' });
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
    throw new FakeRpcFailure('malformed-request', { reason: 'create-base' });
  }
  if (operation === 'update' && baseRevision === null) {
    throw new FakeRpcFailure('malformed-request', { reason: 'update-base' });
  }
  if (!hasPayload) {
    throw new FakeRpcFailure('malformed-request', { reason: 'payload-required' });
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
        throw new FakeRpcFailure('malformed-request', { reason: 'create-base' });
      }
      return;
    case 'update':
      if (change.baseRevision === null) {
        throw new FakeRpcFailure('malformed-request', { reason: 'update-base' });
      }
      return;
    case 'delete':
      if (change.baseRevision === null) {
        throw new FakeRpcFailure('malformed-request', { reason: 'delete-base' });
      }
      return;
    default: {
      const exhaustive: never = change.operation;
      throw new FakeRpcFailure('malformed-request', { reason: String(exhaustive) });
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
          remoteContent: existing.payload,
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
          remoteContent: existing.payload,
        };
      }
      return null;
    }
    default: {
      const exhaustive: never = change.operation;
      throw new FakeRpcFailure('malformed-request', { reason: String(exhaustive) });
    }
  }
}

function successResponse<R>(requestId: string, result: R): Response {
  const body: RpcSuccess<R> = {
    requestId,
    result,
    serverTime: new Date().toISOString(),
  };
  return Response.json(body, { status: 200 });
}

function errorResponse(
  requestId: string | undefined,
  code: ErrorCode,
  details?: Record<string, unknown>,
): Response {
  const body: RpcError = {
    ...(requestId === undefined ? {} : { requestId }),
    error: {
      code,
      retryable: retryableFor(code),
      ...(details === undefined ? {} : { details }),
    },
  };
  return Response.json(body, { status: httpStatusForErrorCode(code) });
}
