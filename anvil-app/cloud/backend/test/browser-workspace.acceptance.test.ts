/**
 * browser-workspace/1 transport acceptance gate.
 *
 * This is deliberately a backend transport test, rather than a hosted-website
 * unit test. It drives the real AccountCoordinator Durable Object with the
 * same opaque envelopes a browser and an approving Desktop exchange. The
 * Desktop provider is deterministic here: the test claims and completes
 * envelopes instead of starting an LLM or a real repository process. That
 * keeps this gate repeatable while still exercising the real authorization,
 * queue, claim-fence, expiry, revocation, and durable-result paths.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type {
  BrowserWorkspaceCommandEnvelope,
  BrowserWorkspaceOperation,
  BrowserWorkspaceResultEnvelope,
  DashboardCommandClaimResult,
  DashboardCommandStatusResult,
} from '../../contract/browser-workspace';
import type { DashboardScope } from '../../contract/dashboard';
import { expectSuccess, postRpc, spikeBearer, uniqueIds } from './helpers';

function accountStub(accountId: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));
}

function fixture(label: string) {
  const ids = uniqueIds(`browser-workspace-${label}`);
  return {
    accountId: ids.accountId,
    enrollmentId: ids.enrollmentId,
    auth: spikeBearer(ids.accountId, ids.enrollmentId),
    workspaceId: 'workspace-allowed',
    repositoryId: 'repository-allowed',
  };
}

const BROWSER_PUB = btoa('b'.repeat(32));
const NONCE = btoa('0123456789ab');
const GRANT_CT = btoa('opaque-dashboard-session-key');

function futureIso(milliseconds = 10 * 60_000): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

function grant(requestId: string, expiresAt: string) {
  return {
    v: 1 as const,
    enc: 'x25519-aes-256-gcm' as const,
    requestId,
    browserPub: BROWSER_PUB,
    expiresAt,
    ephPub: btoa('e'.repeat(32)),
    nonce: NONCE,
    ct: GRANT_CT,
  };
}

function snapshot(seq = 1) {
  return {
    enc: 'aes-256-gcm' as const,
    seq,
    nonce: NONCE,
    ct: btoa(`opaque-dashboard-snapshot-${seq}`),
  };
}

async function postInternal(
  accountId: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await accountStub(accountId).fetch(
    new Request(`https://internal.anvil${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function requestDashboard(
  fx: ReturnType<typeof fixture>,
  requestId: string,
  expiresAt = futureIso(),
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: unknown }> {
  return postInternal(fx.accountId, '/internal/dashboard-request', {
    requestId,
    accountId: fx.accountId,
    browserPub: BROWSER_PUB,
    challenge: `challenge-${requestId}`,
    scopes: ['workspace-read', 'workspace-write', 'submit-task', 'approve-action'],
    workspaceIds: [fx.workspaceId],
    repositoryIds: [fx.repositoryId],
    expiresAt,
    ...overrides,
  });
}

async function approveDashboard(
  fx: ReturnType<typeof fixture>,
  requestId: string,
  expiresAt: string,
  scopes: DashboardScope[] = ['workspace-read', 'workspace-write', 'submit-task', 'approve-action'],
) {
  return expectSuccess(
    await postRpc(
      'dashboard.decide',
      {
        requestId,
        decision: 'approved',
        grant: grant(requestId, expiresAt),
        snapshot: snapshot(),
        workspaceIds: [fx.workspaceId],
        repositoryIds: [fx.repositoryId],
        grantedScopes: scopes,
      },
      fx.auth,
    ),
  );
}

function command(
  requestId: string,
  operation: BrowserWorkspaceOperation = 'chat.send',
  overrides: Partial<BrowserWorkspaceCommandEnvelope> = {},
): BrowserWorkspaceCommandEnvelope {
  return {
    v: 1,
    enc: 'aes-256-gcm',
    requestId,
    commandId: `command-${crypto.randomUUID()}`,
    operation,
    workspaceId: 'workspace-allowed',
    repositoryId: 'repository-allowed',
    expiresAt: futureIso(5 * 60_000),
    nonce: NONCE,
    // The coordinator deliberately stores and forwards this as opaque data.
    ct: btoa('opaque-browser-command-ciphertext-16'),
    ...overrides,
  };
}

function resultFor(input: BrowserWorkspaceCommandEnvelope): BrowserWorkspaceResultEnvelope {
  return {
    v: input.v,
    enc: input.enc,
    requestId: input.requestId,
    commandId: input.commandId,
    operation: input.operation,
    workspaceId: input.workspaceId,
    ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
    expiresAt: input.expiresAt,
    nonce: NONCE,
    ct: btoa('opaque-browser-result-ciphertext-16'),
  };
}

async function submit(
  fx: ReturnType<typeof fixture>,
  requestId: string,
  input: BrowserWorkspaceCommandEnvelope,
) {
  return postInternal(fx.accountId, '/internal/dashboard-command-submit', {
    accountId: fx.accountId,
    requestId,
    command: input,
  });
}

async function status(fx: ReturnType<typeof fixture>, requestId: string, commandId: string) {
  return postInternal(fx.accountId, '/internal/dashboard-command-status', {
    requestId,
    commandId,
  });
}

function expectHttpError(response: { status: number; body: unknown }, statusCode: number): void {
  expect(response.status).toBe(statusCode);
}

describe('browser-workspace/1 acceptance gate', () => {
  it('relays one encrypted command through Desktop and retains the result across reconnect', async () => {
    const fx = fixture('lifecycle');
    const requestId = `request-${crypto.randomUUID()}`;
    const expiresAt = futureIso();
    expect((await requestDashboard(fx, requestId, expiresAt)).status).toBe(200);
    await approveDashboard(fx, requestId, expiresAt);

    const input = command(requestId, 'chat.send');
    const firstSubmit = await submit(fx, requestId, input);
    expect(firstSubmit.status, JSON.stringify(firstSubmit.body)).toBe(200);
    expect(firstSubmit.body).toMatchObject({
      requestId,
      commandId: input.commandId,
      state: 'queued',
      deduplicated: false,
    });

    // Browser refresh/retry is safe: the command id is the durable idempotency
    // key, and the coordinator never creates a second queue item.
    const replay = await submit(fx, requestId, input);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      requestId,
      commandId: input.commandId,
      state: 'queued',
      deduplicated: true,
    });

    // This is the deterministic Desktop provider fixture. It claims the
    // opaque envelope, then reports an opaque result without provider spend.
    const claimed = expectSuccess<DashboardCommandClaimResult>(
      await postRpc('dashboard.command.claim', { requestId, limit: 10 }, fx.auth),
    );
    expect(claimed.commands).toHaveLength(1);
    expect(claimed.commands[0]).toMatchObject({
      commandId: input.commandId,
      requestId,
      envelope: input,
      claimFence: 1,
    });
    const claimFence = claimed.commands[0]!.claimFence;

    const resultEnvelope = resultFor(input);
    const staleCompletion = await postRpc(
      'dashboard.command.complete',
      {
        requestId,
        commandId: input.commandId,
        claimFence: claimFence + 1,
        outcome: 'completed',
        result: resultEnvelope,
      },
      fx.auth,
    );
    expect(staleCompletion.status).toBe(409);

    const completed = expectSuccess(
      await postRpc(
        'dashboard.command.complete',
        {
          requestId,
          commandId: input.commandId,
          claimFence,
          outcome: 'completed',
          result: resultEnvelope,
        },
        fx.auth,
      ),
    );
    expect(completed).toEqual({ requestId, commandId: input.commandId, state: 'completed' });

    const afterCompletion = await status(fx, requestId, input.commandId);
    expect(afterCompletion.status).toBe(200);
    expect(afterCompletion.body).toEqual({
      requestId,
      commandId: input.commandId,
      operation: input.operation,
      state: 'completed',
      expiresAt: input.expiresAt,
      result: resultEnvelope,
    } satisfies DashboardCommandStatusResult);

    // A replacement browser client only has request/command ids and can
    // recover the same result; it cannot cause another Desktop execution.
    const afterClientReplacement = await status(fx, requestId, input.commandId);
    expect(afterClientReplacement).toEqual(afterCompletion);
    const noDuplicateClaim = expectSuccess<DashboardCommandClaimResult>(
      await postRpc('dashboard.command.claim', { requestId }, fx.auth),
    );
    expect(noDuplicateClaim.commands).toEqual([]);
  });

  it('rejects cross-workspace, cross-repository, and under-scoped actions', async () => {
    const fx = fixture('scope');
    const requestId = `request-${crypto.randomUUID()}`;
    const expiresAt = futureIso();
    expect((await requestDashboard(fx, requestId, expiresAt)).status).toBe(200);
    await approveDashboard(fx, requestId, expiresAt, ['workspace-read']);

    expectHttpError(await submit(fx, requestId, command(requestId, 'file.write')), 403);
    expectHttpError(
      await submit(
        fx,
        requestId,
        command(requestId, 'file.read', { workspaceId: 'workspace-other' }),
      ),
      403,
    );
    expectHttpError(
      await submit(
        fx,
        requestId,
        command(requestId, 'file.read', { repositoryId: 'repository-other' }),
      ),
      403,
    );

    // The hosted account binding is authoritative; naming a different
    // account cannot turn this request into a cross-account command.
    const other = fixture('scope-other-account');
    const crossAccount = await postInternal(other.accountId, '/internal/dashboard-command-submit', {
      accountId: other.accountId,
      requestId,
      command: command(requestId, 'workspace.get', {
        repositoryId: undefined,
      }),
    });
    expectHttpError(crossAccount, 404);
  });

  it('does not revive expired, revoked, or uncertain work', async () => {
    const fx = fixture('lifecycle-fences');
    const requestId = `request-${crypto.randomUUID()}`;
    const expiresAt = futureIso();
    expect((await requestDashboard(fx, requestId, expiresAt)).status).toBe(200);
    await approveDashboard(fx, requestId, expiresAt);

    const shortLived = command(requestId, 'workspace.get', { expiresAt: futureIso(100) });
    expect((await submit(fx, requestId, shortLived)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await status(fx, requestId, shortLived.commandId)).body).toMatchObject({
      commandId: shortLived.commandId,
      state: 'expired',
    });
    expect(
      expectSuccess<DashboardCommandClaimResult>(
        await postRpc('dashboard.command.claim', { requestId }, fx.auth),
      ).commands,
    ).toEqual([]);

    const queued = command(requestId, 'workspace.get');
    expect((await submit(fx, requestId, queued)).status).toBe(200);
    expect(expectSuccess(await postRpc('dashboard.revoke', { requestId }, fx.auth))).toMatchObject({
      request: { state: 'revoked' },
    });
    expect((await status(fx, requestId, queued.commandId)).body).toMatchObject({
      commandId: queued.commandId,
      state: 'revoked',
    });

    const secondRequestId = `request-${crypto.randomUUID()}`;
    const secondExpiry = futureIso();
    expect((await requestDashboard(fx, secondRequestId, secondExpiry)).status).toBe(200);
    await approveDashboard(fx, secondRequestId, secondExpiry);
    const claimedInput = command(secondRequestId, 'workspace.get');
    expect((await submit(fx, secondRequestId, claimedInput)).status).toBe(200);
    const claimed = expectSuccess<DashboardCommandClaimResult>(
      await postRpc('dashboard.command.claim', { requestId: secondRequestId }, fx.auth),
    );
    expect(claimed.commands).toHaveLength(1);
    expect(
      expectSuccess(await postRpc('dashboard.revoke', { requestId: secondRequestId }, fx.auth)),
    ).toMatchObject({ request: { state: 'revoked' } });
    const uncertain = expectSuccess(
      await postRpc(
        'dashboard.command.complete',
        {
          requestId: secondRequestId,
          commandId: claimedInput.commandId,
          claimFence: claimed.commands[0]!.claimFence,
          outcome: 'completed',
          result: resultFor(claimedInput),
        },
        fx.auth,
      ),
    );
    expect(uncertain).toMatchObject({
      commandId: claimedInput.commandId,
      state: 'unknown-outcome',
    });
  });

  it('rejects colliding command ids while preserving opaque ciphertext boundaries', async () => {
    const fx = fixture('collision-tamper');
    const requestId = `request-${crypto.randomUUID()}`;
    const expiresAt = futureIso();
    expect((await requestDashboard(fx, requestId, expiresAt)).status).toBe(200);
    await approveDashboard(fx, requestId, expiresAt);

    const input = command(requestId, 'file.read');
    const initialSubmit = await submit(fx, requestId, input);
    expect(initialSubmit.status, JSON.stringify(initialSubmit.body)).toBe(200);

    const malformedCiphertext = await submit(fx, requestId, {
      ...input,
      commandId: `command-${crypto.randomUUID()}`,
      ct: btoa('tiny'),
    });
    expectHttpError(malformedCiphertext, 400);

    const changedCiphertext = { ...input, ct: btoa('tampered-but-well-formed-ciphertext') };
    const collision = await submit(fx, requestId, changedCiphertext);
    expectHttpError(collision, 409);

    const claimed = expectSuccess<DashboardCommandClaimResult>(
      await postRpc('dashboard.command.claim', { requestId }, fx.auth),
    );
    // The backend can route ciphertext but cannot decrypt it. The claimed
    // bytes must be exactly what the browser submitted; Desktop crypto is the
    // boundary that decides whether tampering yields a failed command.
    expect(claimed.commands[0]?.envelope.ct).toBe(input.ct);
    const failed = expectSuccess(
      await postRpc(
        'dashboard.command.complete',
        {
          requestId,
          commandId: input.commandId,
          claimFence: claimed.commands[0]!.claimFence,
          outcome: 'failed',
          result: resultFor(input),
        },
        fx.auth,
      ),
    );
    expect(failed).toMatchObject({ commandId: input.commandId, state: 'failed' });
  });
});
