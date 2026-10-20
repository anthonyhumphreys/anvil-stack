import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as sandboxModule from './sandbox-mock';
vi.mock('../src/checkpointing-sandbox', () => ({ ThreadSandbox: class ThreadSandbox {} }));
import handler from '../src/index';

const BOOTSTRAP = {
  kind: 'anvil.mesh-environment',
  schemaVersion: '0.2',
  environmentId: 'env_1',
  provider: 'cloudflare-sandbox',
  backendUrl: 'https://sync.example.test',
  enrollmentCode: 'anvil-ec-AAAAA-BBBBB',
  ttlSeconds: 900,
};

const getSandbox = sandboxModule.getSandbox as unknown as ReturnType<typeof vi.fn>;
const threadGet = vi.fn();
const THREAD_ID = 'remote-00000000-0000-4000-8000-000000000001';

function env(cloudAgentsEnabled?: string) {
  return {
    Sandbox: {},
    ThreadSandbox: { idFromName: (id: string) => id, get: threadGet },
    ANVIL_CLOUD_AGENTS_ENABLED: cloudAgentsEnabled,
    ALLOW_UNAUTHENTICATED: 'true',
  } as never;
}

async function call(path: string, init?: RequestInit, cloudAgentsEnabled?: string) {
  return handler.fetch(
    new Request(`https://provisioner.test${path}`, init),
    env(cloudAgentsEnabled),
  );
}

describe('mesh provisioner HTTP contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadGet.mockReturnValue({});
  });

  it('fails closed when authentication is not configured', async () => {
    const response = await handler.fetch(new Request('https://provisioner.test/v1/health'), {
      PROVISIONER_TOKEN: undefined,
    } as never);
    expect(response.status).toBe(401);
  });

  it('rejects malformed bootstrap, mismatched ids, and mismatched TTL', async () => {
    expect((await call('/v1/environments', { method: 'POST', body: 'null' })).status).toBe(400);
    expect((await call('/v1/environments', { method: 'POST', body: '[]' })).status).toBe(400);
    expect((await call('/v1/environments', { method: 'POST', body: '{}' })).status).toBe(400);
    expect(
      (await call(`/v1/environments/${THREAD_ID}/boot`, { method: 'POST', body: 'null' })).status,
    ).toBe(400);
    expect(
      (await call(`/v1/environments/${THREAD_ID}/boot`, { method: 'POST', body: '[]' })).status,
    ).toBe(400);
    expect(
      (
        await call('/v1/environments/remote-00000000-0000-4000-8000-000000000002/boot', {
          method: 'POST',
          body: JSON.stringify({ bootstrap: BOOTSTRAP }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('/v1/environments', {
          method: 'POST',
          body: JSON.stringify({ environmentId: 'env_1', ttlSeconds: 901, bootstrap: BOOTSTRAP }),
        })
      ).status,
    ).toBe(400);
  });

  it('preserves the legacy namespace and rejects unsupported legacy snapshots', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockRejectedValue(new Error('provider unavailable')),
      destroy: vi.fn().mockRejectedValue(new Error('destroy failed')),
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
    };
    getSandbox.mockReturnValue(sandbox);
    expect((await call('/v1/environments/env_1')).status).toBe(502);
    expect(
      (
        await call('/v1/environments/env_1/boot', {
          method: 'POST',
          body: JSON.stringify({ bootstrap: BOOTSTRAP }),
        })
      ).status,
    ).toBe(409);
    expect((await call('/v1/environments/env_1/suspend', { method: 'POST' })).status).toBe(409);
    expect((await call('/v1/environments/env_1', { method: 'DELETE' })).status).toBe(502);
  });

  it('reports unknown for a cold legacy sandbox and deletes it through its original app', async () => {
    const sandbox = {
      setKeepAlive: vi.fn().mockResolvedValue(undefined),
      listProcesses: vi.fn().mockResolvedValue([]),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    getSandbox.mockReturnValue(sandbox);
    expect(await (await call('/v1/environments/env_1')).json()).toEqual({ status: 'unknown' });
    expect(sandbox.listProcesses).toHaveBeenCalledOnce();
    expect(await (await call('/v1/environments/env_1', { method: 'DELETE' })).json()).toEqual({
      ok: true,
    });
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('reports only the legacy worker boot process as running', async () => {
    const sandbox = {
      listProcesses: vi
        .fn()
        .mockResolvedValue([{ id: 'other', state: 'running', command: ['/bin/sh'] }]),
    };
    getSandbox.mockReturnValue(sandbox);
    expect(await (await call('/v1/environments/env_1')).json()).toEqual({ status: 'unknown' });
  });

  it('reports paused thread snapshots without querying processes or waking the container', async () => {
    const sandbox = {
      lifecycleStatus: vi.fn().mockResolvedValue({ running: false, hasSnapshot: true }),
      listProcesses: vi.fn(),
    };
    threadGet.mockReturnValue(sandbox);
    expect(await (await call(`/v1/environments/${THREAD_ID}`)).json()).toEqual({
      status: 'suspended',
    });
    expect(sandbox.listProcesses).not.toHaveBeenCalled();
  });

  it('boots and suspends the new thread namespace while legacy IDs stay separate', async () => {
    const bootstrap = { ...BOOTSTRAP, environmentId: THREAD_ID };
    const sandbox = {
      boot: vi.fn().mockResolvedValue({ processId: '42', reused: false }),
      suspendAndSnapshot: vi.fn().mockResolvedValue({ snapshotId: 'snapshot-1', size: 42 }),
      discardSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    threadGet.mockReturnValue(sandbox);
    const started = await call('/v1/environments', {
      method: 'POST',
      body: JSON.stringify({ environmentId: THREAD_ID, ttlSeconds: 900, bootstrap }),
    });
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({ providerRef: THREAD_ID, processId: '42' });
    expect(sandbox.boot).toHaveBeenCalledWith(bootstrap);
    expect((await call(`/v1/environments/${THREAD_ID}/suspend`, { method: 'POST' })).status).toBe(
      200,
    );
    expect((await call(`/v1/environments/${THREAD_ID}`, { method: 'DELETE' })).status).toBe(200);
    expect(sandbox.discardSnapshot).toHaveBeenCalledOnce();
    expect(threadGet).toHaveBeenCalled();
  });

  it('fails closed for Anvil-managed create and resume while preserving cleanup', async () => {
    const bootstrap = { ...BOOTSTRAP, environmentId: THREAD_ID, provider: 'anvil-managed' };
    const sandbox = {
      boot: vi.fn().mockResolvedValue({ processId: '42', reused: false }),
      hasSnapshot: vi.fn().mockResolvedValue(true),
      suspendAndSnapshot: vi.fn().mockResolvedValue({ snapshotId: 'snapshot-1', size: 42 }),
      discardSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    threadGet.mockReturnValue(sandbox);

    const create = {
      method: 'POST',
      body: JSON.stringify({ environmentId: THREAD_ID, ttlSeconds: 900, bootstrap }),
    };
    const deniedCreate = await call('/v1/environments', create);
    expect(deniedCreate.status).toBe(503);
    expect(await deniedCreate.json()).toEqual({ error: 'anvil_cloud_agents_disabled' });
    expect(threadGet).not.toHaveBeenCalled();

    const deniedResume = await call(
      `/v1/environments/${THREAD_ID}/boot`,
      { method: 'POST', body: JSON.stringify({ bootstrap }) },
      'false',
    );
    expect(deniedResume.status).toBe(503);
    expect(sandbox.hasSnapshot).not.toHaveBeenCalled();

    expect((await call(`/v1/environments/${THREAD_ID}/suspend`, { method: 'POST' })).status).toBe(
      200,
    );
    expect((await call(`/v1/environments/${THREAD_ID}`, { method: 'DELETE' })).status).toBe(200);
    expect(sandbox.suspendAndSnapshot).toHaveBeenCalledOnce();
    expect(sandbox.discardSnapshot).toHaveBeenCalledOnce();
  });

  it('allows Anvil-managed creation only when explicitly enabled', async () => {
    const bootstrap = { ...BOOTSTRAP, environmentId: THREAD_ID, provider: 'anvil-managed' };
    const sandbox = { boot: vi.fn().mockResolvedValue({ processId: '42', reused: false }) };
    threadGet.mockReturnValue(sandbox);

    const response = await call(
      '/v1/environments',
      {
        method: 'POST',
        body: JSON.stringify({ environmentId: THREAD_ID, ttlSeconds: 900, bootstrap }),
      },
      'true',
    );

    expect(response.status).toBe(201);
    expect(sandbox.boot).toHaveBeenCalledWith(bootstrap);
  });
});
