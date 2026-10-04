import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  handleMeshMachineEndpointRequest,
  isMeshMachineEndpointEnabled,
  MESH_MACHINE_ENDPOINT_FLAG,
  type MachineCommandDispatchResult,
  type MeshMachineEndpointOptions,
} from '../mesh-machine-endpoint.service.js';

let server: Server;
let baseUrl: string;
let endpointOptions: MeshMachineEndpointOptions;

beforeAll(async () => {
  endpointOptions = {
    enabled: false,
    machineId: 'machine-1',
    originForGrant: vi.fn(async (requestId: string) =>
      requestId === 'grant-1' ? 'https://anvil.dev' : null,
    ),
    dispatchGrantCommands: vi.fn(
      async (): Promise<MachineCommandDispatchResult> => ({ state: 'dispatched', commands: [] }),
    ),
  };
  server = createServer((req, res) => {
    void handleMeshMachineEndpointRequest(req, res, endpointOptions).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('machine endpoint rollout gate', () => {
  it('requires the separate flag to be exactly true', () => {
    expect(isMeshMachineEndpointEnabled('true')).toBe(true);
    expect(isMeshMachineEndpointEnabled('TRUE')).toBe(false);
    expect(isMeshMachineEndpointEnabled('1')).toBe(false);
    const previous = process.env[MESH_MACHINE_ENDPOINT_FLAG];
    try {
      delete process.env[MESH_MACHINE_ENDPOINT_FLAG];
      expect(isMeshMachineEndpointEnabled()).toBe(false);
      process.env[MESH_MACHINE_ENDPOINT_FLAG] = 'true';
      expect(isMeshMachineEndpointEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env[MESH_MACHINE_ENDPOINT_FLAG];
      else process.env[MESH_MACHINE_ENDPOINT_FLAG] = previous;
    }
  });

  it('hides its routes while the rollout flag is off', async () => {
    endpointOptions.enabled = false;
    const response = await fetch(`${baseUrl}/api/machine/v1/grants/grant-1/info`, {
      headers: { Origin: 'https://anvil.dev' },
    });
    expect(response.status).toBe(404);
  });
});

describe('authenticated companion machine routes', () => {
  beforeAll(() => {
    endpointOptions.enabled = true;
  });

  it('negotiates a stable machine identity and supported capability for a live grant', async () => {
    const response = await fetch(`${baseUrl}/api/machine/v1/grants/grant-1/info`, {
      headers: { Origin: 'https://anvil.dev' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      machineId: 'machine-1',
      protocolVersion: 1,
      capabilities: ['dashboard.command.wake/1'],
    });
  });

  it('dispatches only a grant-scoped queue and returns the coordinator-sealed results', async () => {
    const dispatch = vi.mocked(endpointOptions.dispatchGrantCommands);
    dispatch.mockResolvedValueOnce({
      state: 'dispatched',
      commands: [
        {
          commandId: 'command-1',
          state: 'completed',
          result: {
            v: 1,
            enc: 'aes-256-gcm',
            requestId: 'grant-1',
            commandId: 'command-1',
            operation: 'workspace.get',
            workspaceId: 'workspace-1',
            expiresAt: '2030-01-01T00:00:00.000Z',
            nonce: 'encrypted-nonce',
            ct: 'encrypted-result',
          },
        },
      ],
    });

    const response = await fetch(
      `${baseUrl}/api/machine/v1/machines/machine-1/grants/grant-1/commands/dispatch`,
      { method: 'POST', headers: { Origin: 'https://anvil.dev' } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      machineId: 'machine-1',
      protocolVersion: 1,
      state: 'dispatched',
      commands: [
        { commandId: 'command-1', state: 'completed', result: { ct: 'encrypted-result' } },
      ],
    });
    expect(dispatch).toHaveBeenCalledWith('grant-1');
  });

  it('rejects a stale grant origin, wrong machine identity, and caller payloads', async () => {
    const wrongOrigin = await fetch(`${baseUrl}/api/machine/v1/grants/grant-1/info`, {
      headers: { Origin: 'https://attacker.example' },
    });
    expect(wrongOrigin.status).toBe(403);

    const wrongMachine = await fetch(
      `${baseUrl}/api/machine/v1/machines/other-machine/grants/grant-1/commands/dispatch`,
      { method: 'POST', headers: { Origin: 'https://anvil.dev' } },
    );
    expect(wrongMachine.status).toBe(404);

    const payload = await fetch(
      `${baseUrl}/api/machine/v1/machines/machine-1/grants/grant-1/commands/dispatch`,
      {
        method: 'POST',
        headers: { Origin: 'https://anvil.dev', 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(payload.status).toBe(400);
  });
});
