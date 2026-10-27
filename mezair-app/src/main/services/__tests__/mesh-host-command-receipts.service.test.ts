import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE mesh_host_command_receipts (
    backend_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('executing', 'completed')),
    result_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (backend_id, account_id, principal_id, request_id),
    CHECK (
      (status = 'executing' AND result_json IS NULL) OR
      (status = 'completed' AND result_json IS NOT NULL)
    )
  )
`);

vi.mock('../../db/database.js', () => ({ getDb: () => db }));

import {
  executeWithMeshHostCommandReceipt,
  MeshHostCommandReceiptConflictError,
  MeshHostCommandReceiptUncertainError,
} from '../mesh-host-command-receipts.service.js';

const scope = { backendId: 'backend-a', accountId: 'account-a' };

function command(overrides: Partial<Parameters<typeof executeWithMeshHostCommandReceipt>[0]> = {}) {
  return {
    scope,
    principalId: 'principal-a',
    requestId: 'request-a',
    operation: 'command.steer',
    payloadHash: 'hash-a',
    execute: vi.fn(() => ({ accepted: true })),
    ...overrides,
  };
}

beforeEach(() => db.exec('DELETE FROM mesh_host_command_receipts'));

describe('native Mesh command receipts', () => {
  it('stores a completed result and replays it without executing again', async () => {
    const execute = vi.fn(() => ({ accepted: true, sessionId: 'session-a' }));
    const input = command({ execute });

    await expect(executeWithMeshHostCommandReceipt(input)).resolves.toEqual({
      accepted: true,
      sessionId: 'session-a',
    });
    await expect(
      executeWithMeshHostCommandReceipt(command({ execute: vi.fn(() => ({ accepted: false })) })),
    ).resolves.toEqual({ accepted: true, sessionId: 'session-a' });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT status FROM mesh_host_command_receipts').get()).toEqual({
      status: 'completed',
    });
  });

  it('leaves failed executions uncertain and never retries the side effect', async () => {
    const firstExecute = vi.fn(() => Promise.reject(new Error('provider connection lost')));
    const input = command({ execute: firstExecute });

    await expect(executeWithMeshHostCommandReceipt(input)).rejects.toMatchObject({
      code: 'mesh-request-outcome-uncertain',
      reason: 'execution-failed',
    });
    await expect(
      executeWithMeshHostCommandReceipt(command({ execute: vi.fn() })),
    ).rejects.toMatchObject({
      code: 'mesh-request-outcome-uncertain',
      reason: 'previously-executing',
    });

    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT status, result_json FROM mesh_host_command_receipts').get()).toEqual({
      status: 'executing',
      result_json: null,
    });
  });

  it('treats an executing row from a previous process as uncertain', async () => {
    db.prepare(
      `INSERT INTO mesh_host_command_receipts
       (backend_id, account_id, principal_id, request_id, operation, payload_hash, status)
       VALUES (?, ?, ?, ?, ?, ?, 'executing')`,
    ).run(scope.backendId, scope.accountId, 'principal-a', 'request-a', 'command.steer', 'hash-a');
    const execute = vi.fn();

    await expect(executeWithMeshHostCommandReceipt(command({ execute }))).rejects.toBeInstanceOf(
      MeshHostCommandReceiptUncertainError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a reused request id with a changed operation or payload digest', async () => {
    await executeWithMeshHostCommandReceipt(command());

    await expect(
      executeWithMeshHostCommandReceipt(command({ operation: 'command.cancel' })),
    ).rejects.toBeInstanceOf(MeshHostCommandReceiptConflictError);
    await expect(
      executeWithMeshHostCommandReceipt(command({ payloadHash: 'hash-b' })),
    ).rejects.toMatchObject({ code: 'mesh-request-id-conflict' });
  });

  it('shares one in-flight execution for concurrent matching requests', async () => {
    let completeExecution: ((value: unknown) => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          completeExecution = resolve;
        }),
    );
    const input = command({ execute });

    const first = executeWithMeshHostCommandReceipt(input);
    const duplicate = executeWithMeshHostCommandReceipt(command({ execute: vi.fn() }));
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);

    completeExecution?.({ accepted: true });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { accepted: true },
      { accepted: true },
    ]);
  });

  it('isolates receipts by backend, account, and principal', async () => {
    const inputs = [
      command(),
      command({ scope: { backendId: 'backend-b', accountId: 'account-a' } }),
      command({ scope: { backendId: 'backend-a', accountId: 'account-b' } }),
      command({ principalId: 'principal-b' }),
    ];

    const results = await Promise.all(
      inputs.map((input, index) =>
        executeWithMeshHostCommandReceipt({
          ...input,
          execute: () => ({ index }),
        }),
      ),
    );

    expect(results).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }]);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM mesh_host_command_receipts').get() as {
          count: number;
        }
      ).count,
    ).toBe(4);
  });

  it('leaves an oversized result uncertain instead of storing or replaying it', async () => {
    const execute = vi.fn(() => 'x'.repeat(512 * 1024));

    await expect(executeWithMeshHostCommandReceipt(command({ execute }))).rejects.toMatchObject({
      code: 'mesh-request-outcome-uncertain',
      reason: 'result-too-large',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT status FROM mesh_host_command_receipts').get()).toEqual({
      status: 'executing',
    });
  });
});
