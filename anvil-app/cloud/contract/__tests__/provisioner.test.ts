import { describe, expect, it, vi } from 'vitest';
import { validBootstrap, type MeshEnvironmentBootstrap } from '../../provisioner/src/bootstrap';
import { bootWithSandbox } from '../../provisioner/src/lifecycle';

const BOOTSTRAP = {
  kind: 'anvil.mesh-environment',
  schemaVersion: '0.2',
  environmentId: 'env_1',
  provider: 'cloudflare-sandbox',
  backendUrl: 'https://sync.example.test',
  enrollmentCode: 'anvil-ec-AAAAA-BBBBB',
  ttlSeconds: 900,
} satisfies MeshEnvironmentBootstrap;

describe('mesh provisioner bootstrap contract', () => {
  it('accepts backend 0.2 enrollment bootstrap and rejects legacy key-bearing payloads', () => {
    expect(validBootstrap(BOOTSTRAP)).toBe(true);
    expect(
      validBootstrap({
        ...BOOTSTRAP,
        schemaVersion: '0.1',
        pairing: 'anvil-pair-AAAAA',
        enrollmentCode: undefined,
      }),
    ).toBe(false);
    expect(
      validBootstrap({ ...BOOTSTRAP, pairing: 'anvil-pair-AAAAA' }),
    ).toBe(false);
    expect(
      validBootstrap({ ...BOOTSTRAP, enrollmentCode: 'anvil-pair-AAAAA' }),
    ).toBe(false);
  });

  it('starts the boot process asynchronously and reuses a live process', async () => {
    const sandbox = {
      listProcesses: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'other-process', state: 'running', command: ['/bin/sh'] },
          { id: 'process-1', state: 'running', command: ['/opt/anvil/bin/anvil-worker-boot'] },
        ]),
      exec: vi.fn().mockResolvedValue({ id: 'process-1' }),
    };
    const create = await bootWithSandbox(sandbox, BOOTSTRAP);
    expect(create).toEqual({ processId: 'process-1', reused: false });
    expect(sandbox.exec).toHaveBeenCalledWith(['/opt/anvil/bin/anvil-worker-boot'], {
      env: { ANVIL_BOOTSTRAP_JSON: JSON.stringify(BOOTSTRAP) },
    });
    const retry = await bootWithSandbox(sandbox, BOOTSTRAP);
    expect(retry).toEqual({ processId: 'process-1', reused: true });
    expect(sandbox.exec).toHaveBeenCalledTimes(1);
  });
});
