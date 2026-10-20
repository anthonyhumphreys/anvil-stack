import { MESH_MACHINE_MAX_FRAME_BYTES } from '../../../cloud/contract/machine.js';
import type { SyncScope } from '../../shared/sync-mesh.js';
import { getDb } from '../db/database.js';

const MAX_RECEIPT_RESULT_BYTES = MESH_MACHINE_MAX_FRAME_BYTES;

export type MeshHostCommandReceiptUncertainReason =
  | 'previously-executing'
  | 'execution-failed'
  | 'result-not-serializable'
  | 'result-too-large'
  | 'receipt-persistence-failed';

export class MeshHostCommandReceiptConflictError extends Error {
  readonly code = 'mesh-request-id-conflict';

  constructor() {
    super('Mesh request id was already used with a different operation or payload.');
    this.name = 'MeshHostCommandReceiptConflictError';
  }
}

export class MeshHostCommandReceiptUncertainError extends Error {
  readonly code = 'mesh-request-outcome-uncertain';

  constructor(
    readonly reason: MeshHostCommandReceiptUncertainReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MeshHostCommandReceiptUncertainError';
  }
}

export class MeshHostCommandReceiptCorruptError extends Error {
  readonly code = 'mesh-command-receipt-corrupt';

  constructor() {
    super('Stored Mesh command receipt is malformed.');
    this.name = 'MeshHostCommandReceiptCorruptError';
  }
}

export interface ExecuteWithMeshHostCommandReceiptInput {
  scope: Pick<SyncScope, 'backendId' | 'accountId'>;
  principalId: string;
  requestId: string;
  operation: string;
  payloadHash: string;
  execute: () => unknown | Promise<unknown>;
}

interface ReceiptRow {
  operation: string;
  payload_hash: string;
  status: 'executing' | 'completed';
  result_json: string | null;
}

interface InFlightReceipt {
  operation: string;
  payloadHash: string;
  result: Promise<unknown>;
}

const inFlightReceipts = new Map<string, InFlightReceipt>();

/**
 * Execute one native Mesh command at most once for its durable account and principal scope.
 * A process restart while a receipt is executing is reported as uncertain and never retried.
 */
export async function executeWithMeshHostCommandReceipt(
  input: ExecuteWithMeshHostCommandReceiptInput,
): Promise<unknown> {
  assertReceiptIdentity(input);

  const key = receiptKey(input);
  const inFlight = inFlightReceipts.get(key);
  if (inFlight !== undefined) {
    if (inFlight.operation !== input.operation || inFlight.payloadHash !== input.payloadHash) {
      return Promise.reject(new MeshHostCommandReceiptConflictError());
    }
    return inFlight.result;
  }

  const db = getDb();
  const reservation = db
    .transaction((): { replay: true; value: unknown } | { replay: false } => {
      const row = db
        .prepare(
          `SELECT operation, payload_hash, status, result_json
           FROM mesh_host_command_receipts
           WHERE backend_id = ? AND account_id = ? AND principal_id = ? AND request_id = ?`,
        )
        .get(input.scope.backendId, input.scope.accountId, input.principalId, input.requestId) as
        | ReceiptRow
        | undefined;

      if (row !== undefined) {
        if (row.operation !== input.operation || row.payload_hash !== input.payloadHash) {
          throw new MeshHostCommandReceiptConflictError();
        }
        if (row.status === 'executing') {
          throw uncertain(
            'previously-executing',
            'A prior Mesh command execution may have completed; it will not be run again.',
          );
        }
        if (row.status !== 'completed' || row.result_json === null) {
          throw new MeshHostCommandReceiptCorruptError();
        }
        try {
          return { replay: true, value: JSON.parse(row.result_json) as unknown };
        } catch {
          throw new MeshHostCommandReceiptCorruptError();
        }
      }

      db.prepare(
        `INSERT INTO mesh_host_command_receipts
           (backend_id, account_id, principal_id, request_id, operation, payload_hash, status)
           VALUES (?, ?, ?, ?, ?, ?, 'executing')`,
      ).run(
        input.scope.backendId,
        input.scope.accountId,
        input.principalId,
        input.requestId,
        input.operation,
        input.payloadHash,
      );

      return { replay: false };
    })
    .immediate();

  if (reservation.replay) return reservation.value;

  let receipt: InFlightReceipt;
  const result = Promise.resolve()
    .then(() => executeAndComplete(input))
    .finally(() => {
      if (inFlightReceipts.get(key) === receipt) inFlightReceipts.delete(key);
    });
  receipt = { operation: input.operation, payloadHash: input.payloadHash, result };
  inFlightReceipts.set(key, receipt);
  return result;
}

async function executeAndComplete(input: ExecuteWithMeshHostCommandReceiptInput): Promise<unknown> {
  let result: unknown;
  try {
    result = await input.execute();
  } catch (cause) {
    throw uncertain(
      'execution-failed',
      'Mesh command execution failed after its durable receipt was recorded; its outcome is uncertain.',
      cause,
    );
  }

  let resultJson: string;
  let persistedResult: unknown;
  try {
    const serialized = JSON.stringify(result);
    if (serialized === undefined) throw new TypeError('Result is not JSON serializable.');
    resultJson = serialized;
    persistedResult = JSON.parse(resultJson) as unknown;
    const responseJson = JSON.stringify({
      kind: 'response',
      requestId: input.requestId,
      result: persistedResult,
    });
    if (
      responseJson === undefined ||
      Buffer.byteLength(responseJson, 'utf8') > MAX_RECEIPT_RESULT_BYTES
    ) {
      throw new ResultTooLargeError();
    }
  } catch (cause) {
    const tooLarge = cause instanceof ResultTooLargeError;
    throw uncertain(
      tooLarge ? 'result-too-large' : 'result-not-serializable',
      tooLarge
        ? 'Mesh command completed, but its result exceeds the Mesh frame limit; its outcome is uncertain.'
        : 'Mesh command completed, but its result could not be stored as JSON; its outcome is uncertain.',
      cause,
    );
  }

  try {
    const update = getDb()
      .transaction(() =>
        getDb()
          .prepare(
            `UPDATE mesh_host_command_receipts
             SET status = 'completed', result_json = ?, updated_at = datetime('now')
             WHERE backend_id = ? AND account_id = ? AND principal_id = ? AND request_id = ?
               AND operation = ? AND payload_hash = ? AND status = 'executing'`,
          )
          .run(
            resultJson,
            input.scope.backendId,
            input.scope.accountId,
            input.principalId,
            input.requestId,
            input.operation,
            input.payloadHash,
          ),
      )
      .immediate();
    if (update.changes !== 1) throw new Error('Mesh command receipt was not in executing state.');
  } catch (cause) {
    throw uncertain(
      'receipt-persistence-failed',
      'Mesh command completed, but its result could not be durably recorded; its outcome is uncertain.',
      cause,
    );
  }

  return persistedResult;
}

function assertReceiptIdentity(input: ExecuteWithMeshHostCommandReceiptInput): void {
  const identifiers = [
    input.scope.backendId,
    input.scope.accountId,
    input.principalId,
    input.requestId,
    input.operation,
    input.payloadHash,
  ];
  if (identifiers.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new TypeError('Mesh command receipt identifiers must be non-empty strings.');
  }
  if (typeof input.execute !== 'function') {
    throw new TypeError('Mesh command receipt execute callback must be a function.');
  }
}

function receiptKey(input: ExecuteWithMeshHostCommandReceiptInput): string {
  return JSON.stringify([
    input.scope.backendId,
    input.scope.accountId,
    input.principalId,
    input.requestId,
  ]);
}

function uncertain(
  reason: MeshHostCommandReceiptUncertainReason,
  message: string,
  cause?: unknown,
): MeshHostCommandReceiptUncertainError {
  return new MeshHostCommandReceiptUncertainError(reason, message, { cause });
}

class ResultTooLargeError extends Error {}
