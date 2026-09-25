import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { expectSuccess, postRpc, spikeBearer, uniqueIds } from './helpers';
import type { BrowserWorkspaceCommandEnvelope } from '../../contract/browser-workspace';

function accountStub(accountId: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));
}

describe('browser-workspace/1 command relay', () => {
  it('queues, issuer-claims, completes, and relays an opaque result idempotently', async () => {
    const ids = uniqueIds('browser-workspace');
    const requestId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const browserPub = btoa('0123456789abcdef0123456789abcdef');
    const sourceAuth = spikeBearer(ids.accountId, ids.enrollmentId);
    const request = await accountStub(ids.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId,
          accountId: ids.accountId,
          browserPub,
          challenge: 'browser-workspace-test',
          scopes: ['read-dashboard', 'workspace-read'],
          workspaceBindings: [{ workspaceId: 'ws-1', repositoryIds: ['repo-1'] }],
          expiresAt,
        }),
      }),
    );
    expect(request.status).toBe(200);

    expectSuccess(
      await postRpc(
        'dashboard.decide',
        {
          requestId,
          decision: 'approved',
          grantedScopes: ['workspace-read'],
          workspaceBindings: [{ workspaceId: 'ws-1', repositoryIds: ['repo-1'] }],
          grant: {
            v: 1,
            enc: 'x25519-aes-256-gcm',
            requestId,
            browserPub,
            expiresAt,
            ephPub: btoa('fedcba9876543210fedcba9876543210'),
            nonce: btoa('0123456789ab'),
            ct: btoa('sealed-dashboard-session-key'),
          },
          snapshot: {
            enc: 'aes-256-gcm',
            seq: 1,
            nonce: btoa('0123456789ab'),
            ct: btoa('sealed-dashboard-snapshot'),
          },
        },
        sourceAuth,
      ),
    );

    const command = {
      v: 1,
      enc: 'aes-256-gcm',
      requestId,
      commandId,
      operation: 'file.read',
      workspaceId: 'ws-1',
      repositoryId: 'repo-1',
      expiresAt,
      nonce: btoa('0123456789ab'),
      ct: btoa('opaque-command-ciphertext'),
    } as const;
    const submitted = await accountStub(ids.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-command-submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: ids.accountId, requestId, command }),
      }),
    );
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({ commandId, state: 'queued' });

    const claimed = expectSuccess<{
      commands: Array<{ commandId: string; claimFence: number }>;
    }>(await postRpc('dashboard.command.claim', { requestId }, sourceAuth));
    expect(claimed.commands).toHaveLength(1);
    expect(claimed.commands[0]?.commandId).toBe(commandId);

    const result = {
      ...command,
      ct: btoa('opaque-result-ciphertext'),
    };
    const completed = expectSuccess<{ state: string }>(
      await postRpc(
        'dashboard.command.complete',
        {
          requestId,
          commandId,
          claimFence: claimed.commands[0]?.claimFence,
          outcome: 'completed',
          result,
        },
        sourceAuth,
      ),
    );
    expect(completed.state).toBe('completed');

    const status = await accountStub(ids.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-command-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, commandId }),
      }),
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ commandId, state: 'completed', result });
  });

  it('stops serving completed result ciphertext once the grant is revoked', async () => {
    const ids = uniqueIds('browser-workspace-revoked-result');
    const requestId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const browserPub = btoa('0123456789abcdef0123456789abcdef');
    const sourceAuth = spikeBearer(ids.accountId, ids.enrollmentId);
    await accountStub(ids.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId,
          accountId: ids.accountId,
          browserPub,
          challenge: 'browser-workspace-test',
          scopes: ['read-dashboard', 'workspace-read'],
          workspaceBindings: [{ workspaceId: 'ws-1', repositoryIds: ['repo-1'] }],
          expiresAt,
        }),
      }),
    );
    expectSuccess(
      await postRpc(
        'dashboard.decide',
        {
          requestId,
          decision: 'approved',
          grantedScopes: ['workspace-read'],
          workspaceBindings: [{ workspaceId: 'ws-1', repositoryIds: ['repo-1'] }],
          grant: {
            v: 1,
            enc: 'x25519-aes-256-gcm',
            requestId,
            browserPub,
            expiresAt,
            ephPub: btoa('fedcba9876543210fedcba9876543210'),
            nonce: btoa('0123456789ab'),
            ct: btoa('sealed-dashboard-session-key'),
          },
          snapshot: {
            enc: 'aes-256-gcm',
            seq: 1,
            nonce: btoa('0123456789ab'),
            ct: btoa('sealed-dashboard-snapshot'),
          },
        },
        sourceAuth,
      ),
    );

    const command = {
      v: 1,
      enc: 'aes-256-gcm',
      requestId,
      commandId,
      operation: 'file.read',
      workspaceId: 'ws-1',
      repositoryId: 'repo-1',
      expiresAt,
      nonce: btoa('0123456789ab'),
      ct: btoa('opaque-command-ciphertext'),
    } as const;
    await accountStub(ids.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-command-submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: ids.accountId, requestId, command }),
      }),
    );
    const claimed = expectSuccess<{
      commands: Array<{ commandId: string; claimFence: number }>;
    }>(await postRpc('dashboard.command.claim', { requestId }, sourceAuth));
    const result = { ...command, ct: btoa('opaque-result-ciphertext') };
    expectSuccess(
      await postRpc(
        'dashboard.command.complete',
        {
          requestId,
          commandId,
          claimFence: claimed.commands[0]?.claimFence,
          outcome: 'completed',
          result,
        },
        sourceAuth,
      ),
    );
    const statusBefore = await (
      await accountStub(ids.accountId).fetch(
        new Request('https://internal.anvil/internal/dashboard-command-status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId, commandId }),
        }),
      )
    ).json();
    expect(statusBefore).toMatchObject({ state: 'completed', result });

    expectSuccess(await postRpc('dashboard.revoke', { requestId }, sourceAuth));

    const statusAfter = await accountStub(ids.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-command-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, commandId }),
      }),
    );
    expect(statusAfter.status).toBe(200);
    const body = (await statusAfter.json()) as Record<string, unknown>;
    // The terminal state stays honest; the ciphertext is gone for good.
    expect(body).toMatchObject({ commandId, state: 'completed' });
    expect(body.result).toBeUndefined();

    // The issuer's durable outbox can still satisfy the idempotent
    // re-completion check after revocation — the command stays completed.
    const recomplete = expectSuccess<{ state: string }>(
      await postRpc(
        'dashboard.command.complete',
        {
          requestId,
          commandId,
          claimFence: claimed.commands[0]?.claimFence,
          outcome: 'completed',
          result,
        },
        sourceAuth,
      ),
    );
    expect(recomplete.state).toBe('completed');
  });

  it('does not accept a command for an unknown grant', async () => {
    const ids = uniqueIds('browser-workspace-scope');
    const requestId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const response = await accountStub(ids.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-command-submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountId: ids.accountId,
          requestId,
          command: {
            v: 1,
            enc: 'aes-256-gcm',
            requestId,
            commandId: crypto.randomUUID(),
            operation: 'file.read',
            workspaceId: 'ws-unknown',
            repositoryId: 'repo-unknown',
            expiresAt,
            nonce: btoa('0123456789ab'),
            ct: btoa('opaque-command-ciphertext'),
          },
        }),
      }),
    );
    expect(response.status).toBe(404);
  });

  it('accepts bounded large envelopes and sustains a high-volume read queue', async () => {
    const ids = uniqueIds('browser-workspace-limits');
    const requestId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const browserPub = btoa('0123456789abcdef0123456789abcdef');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    const request = await accountStub(ids.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId,
          accountId: ids.accountId,
          browserPub,
          challenge: 'browser-workspace-limits',
          scopes: ['workspace-read', 'workspace-write'],
          workspaceBindings: [{ workspaceId: 'ws-1', repositoryIds: ['repo-1'] }],
          expiresAt,
        }),
      }),
    );
    expect(request.status).toBe(200);
    expectSuccess(
      await postRpc(
        'dashboard.decide',
        {
          requestId,
          decision: 'approved',
          grantedScopes: ['workspace-read', 'workspace-write'],
          workspaceBindings: [{ workspaceId: 'ws-1', repositoryIds: ['repo-1'] }],
          grant: {
            v: 1,
            enc: 'x25519-aes-256-gcm',
            requestId,
            browserPub,
            expiresAt,
            ephPub: btoa('fedcba9876543210fedcba9876543210'),
            nonce: btoa('0123456789ab'),
            ct: btoa('sealed-dashboard-session-key'),
          },
          snapshot: {
            enc: 'aes-256-gcm',
            seq: 1,
            nonce: btoa('0123456789ab'),
            ct: btoa('sealed-dashboard-snapshot'),
          },
        },
        auth,
      ),
    );
    const submit = async (command: unknown) =>
      accountStub(ids.accountId).fetch(
        new Request('https://internal.anvil/internal/dashboard-command-submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accountId: ids.accountId, requestId, command }),
        }),
      );
    for (let index = 0; index < 205; index += 1) {
      const response = await submit({
        v: 1,
        enc: 'aes-256-gcm',
        requestId,
        commandId: `read-${index}-${crypto.randomUUID()}`,
        operation: 'workspace.get',
        workspaceId: 'ws-1',
        expiresAt,
        nonce: btoa('0123456789ab'),
        ct: btoa('bounded-read-cipher'),
      });
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    }

    const largeWrite = await submit({
      v: 1,
      enc: 'aes-256-gcm',
      requestId,
      commandId: `write-${crypto.randomUUID()}`,
      operation: 'file.write',
      workspaceId: 'ws-1',
      repositoryId: 'repo-1',
      expiresAt,
      nonce: btoa('0123456789ab'),
      ct: btoa('w'.repeat(64 * 1024)),
    });
    expect(largeWrite.status).toBe(200);

    let write:
      | { commandId: string; claimFence: number; envelope: BrowserWorkspaceCommandEnvelope }
      | undefined;
    for (let page = 0; page < 21 && write === undefined; page += 1) {
      const claimed = expectSuccess<{
        commands: Array<{
          commandId: string;
          claimFence: number;
          envelope: BrowserWorkspaceCommandEnvelope;
        }>;
      }>(await postRpc('dashboard.command.claim', { requestId, limit: 10 }, auth));
      write = claimed.commands.find((entry) => entry.envelope.operation === 'file.write');
    }
    expect(write).toBeDefined();
    const largeResult = await postRpc(
      'dashboard.command.complete',
      {
        requestId,
        commandId: write!.commandId,
        claimFence: write!.claimFence,
        outcome: 'completed',
        result: {
          ...write!.envelope,
          ct: btoa('p'.repeat(180 * 1024)),
        },
      },
      auth,
    );
    expect(largeResult.status).toBe(200);

    const overCap = await submit({
      v: 1,
      enc: 'aes-256-gcm',
      requestId,
      commandId: `over-${crypto.randomUUID()}`,
      operation: 'workspace.get',
      workspaceId: 'ws-1',
      expiresAt,
      nonce: btoa('0123456789ab'),
      ct: btoa('o'.repeat(300 * 1024)),
    });
    expect(overCap.status).toBe(413);
  });
});
