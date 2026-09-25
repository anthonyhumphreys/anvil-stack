import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as sandboxModule from './sandbox-mock';
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

function env() {
  return { Sandbox: {}, ALLOW_UNAUTHENTICATED: 'true' } as never;
}

async function call(path: string, init?: RequestInit) {
  return handler.fetch(new Request(`https://provisioner.test${path}`, init), env());
}

describe('mesh provisioner HTTP contract', () => {
  beforeEach(() => vi.clearAllMocks());

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
    expect((await call('/v1/environments/env_1/boot', { method: 'POST', body: 'null' })).status).toBe(400);
    expect((await call('/v1/environments/env_1/boot', { method: 'POST', body: '[]' })).status).toBe(400);
    expect(
      (await call('/v1/environments/env_2/boot', {
        method: 'POST', body: JSON.stringify({ bootstrap: BOOTSTRAP }),
      })).status,
    ).toBe(400);
    expect(
      (await call('/v1/environments', {
        method: 'POST', body: JSON.stringify({ environmentId: 'env_1', ttlSeconds: 901, bootstrap: BOOTSTRAP }),
      })).status,
    ).toBe(400);
  });

  it('returns provider errors for status, boot, and termination', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockRejectedValue(new Error('provider unavailable')),
      exec: vi.fn().mockRejectedValue(new Error('spawn failed')),
      destroy: vi.fn().mockRejectedValue(new Error('destroy failed')),
    };
    getSandbox.mockReturnValue(sandbox);
    expect((await call('/v1/environments/env_1')).status).toBe(502);
    expect((await call('/v1/environments/env_1/boot', {
      method: 'POST', body: JSON.stringify({ bootstrap: BOOTSTRAP }),
    })).status).toBe(502);
    expect((await call('/v1/environments/env_1', { method: 'DELETE' })).status).toBe(502);
  });

  it('reports unknown for a cold sandbox and treats successful delete as idempotent', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockResolvedValue([]),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    getSandbox.mockReturnValue(sandbox);
    expect(await (await call('/v1/environments/env_1')).json()).toEqual({ status: 'unknown' });
    expect(await (await call('/v1/environments/env_1', { method: 'DELETE' })).json()).toEqual({ ok: true });
  });

  it('reports only the worker boot process as running', async () => {
    const sandbox = {
      listProcesses: vi.fn().mockResolvedValue([
        { id: 'other', state: 'running', command: ['/bin/sh'] },
      ]),
    };
    getSandbox.mockReturnValue(sandbox);
    expect(await (await call('/v1/environments/env_1')).json()).toEqual({ status: 'unknown' });
  });
});
