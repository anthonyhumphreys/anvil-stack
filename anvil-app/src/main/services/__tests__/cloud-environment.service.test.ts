import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf-8');
      if (!text.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext.');
      return text.slice('enc:'.length);
    },
  },
}));

const backendRpc = vi.hoisted(() => vi.fn());
vi.mock('../sync-backend-client.service.js', () => ({ rpc: backendRpc }));

const sdkSend = vi.hoisted(() => vi.fn());
const sdkCommands = vi.hoisted(() => [] as Array<{ kind: string; input: Record<string, unknown> }>);
vi.mock('@aws-sdk/client-lambda-microvms', () => {
  class Command {
    readonly kind: string;
    readonly input: Record<string, unknown>;
    constructor(kind: string, input: Record<string, unknown>) {
      this.kind = kind;
      this.input = input;
      sdkCommands.push({ kind, input });
    }
  }
  return {
    LambdaMicrovmsClient: class {
      send(command: Command) {
        return sdkSend(command);
      }
    },
    RunMicrovmCommand: class extends Command {
      constructor(input: Record<string, unknown>) {
        super('run', input);
      }
    },
    GetMicrovmCommand: class extends Command {
      constructor(input: Record<string, unknown>) {
        super('get', input);
      }
    },
    TerminateMicrovmCommand: class extends Command {
      constructor(input: Record<string, unknown>) {
        super('terminate', input);
      }
    },
  };
});

import {
  addProviderConnection,
  listLocalEnvironments,
  listProviderConnections,
  provisionCapabilities,
  provisionEnvironment,
  reapExpiredEnvironments,
  removeProviderConnection,
  terminateEnvironment,
  type ProvisionerScope,
} from '../cloud-environment.service';

const SCOPE: ProvisionerScope = {
  backendId: 'backend-1',
  accountId: 'account-1',
  enrollmentId: 'enr-prov',
  apiUrl: 'https://api.test',
  accessToken: 'tok',
};
const OTHER_SCOPE = { backendId: 'backend-2', accountId: 'account-2' };

function addAwsConnection(overrides: Record<string, unknown> = {}) {
  return addProviderConnection(SCOPE, {
    provider: 'aws-lambda-microvm',
    displayName: 'prod-aws',
    config: {
      region: 'eu-west-1',
      imageIdentifier: 'arn:aws:lambda:img/anvil-worker:1',
      ...overrides,
    },
    secret: JSON.stringify({ accessKeyId: 'AKIA…', secretAccessKey: 'sekret' }),
  });
}

beforeEach(() => {
  db.exec('DELETE FROM cloud_provider_connections');
  db.exec('DELETE FROM cloud_environments');
  backendRpc.mockReset();
  sdkSend.mockReset();
  sdkCommands.length = 0;
});

describe('provider connections', () => {
  it('stores config, encrypts the secret, and never exposes it in summaries', () => {
    const created = addAwsConnection();
    expect(created.id).toMatch(/^cpc_/);
    expect(created.provider).toBe('aws-lambda-microvm');
    expect(created.hasSecret).toBe(true);
    expect(created.config['imageIdentifier']).toBe('arn:aws:lambda:img/anvil-worker:1');
    expect(JSON.stringify(created)).not.toContain('sekret');
    // The raw row holds the encryptSecret output (the mock wraps with an
    // `enc:` marker — proves the blob went through safeStorage, never a
    // bare plaintext column).
    const raw = db
      .prepare('SELECT secret_blob FROM cloud_provider_connections WHERE id = ?')
      .get(created.id) as { secret_blob: Buffer };
    expect(raw.secret_blob.toString('utf-8').startsWith('enc:')).toBe(true);
  });

  it('scopes connections to (backend, account) and advertises provision capabilities', () => {
    addAwsConnection();
    addProviderConnection(OTHER_SCOPE, { provider: 'vercel-sandbox', config: {} });
    const list = listProviderConnections(SCOPE);
    expect(list).toHaveLength(1);
    expect(list[0]?.provider).toBe('aws-lambda-microvm');
    expect(provisionCapabilities(SCOPE)).toEqual(['provision:aws-lambda-microvm']);
    expect(listProviderConnections(OTHER_SCOPE)[0]?.provider).toBe('vercel-sandbox');
  });

  it('removes a connection within its scope only', () => {
    const created = addAwsConnection();
    expect(removeProviderConnection(OTHER_SCOPE, created.id)).toBe(false);
    expect(removeProviderConnection(SCOPE, created.id)).toBe(true);
    expect(listProviderConnections(SCOPE)).toHaveLength(0);
  });
});

describe('provisionEnvironment', () => {
  const inputs = {
    environmentId: 'env_test1',
    provider: 'aws-lambda-microvm' as const,
    ttlSeconds: 1800,
  };

  it('maps inputs onto RunMicrovm and reports provisioning lifecycle', async () => {
    addAwsConnection();
    backendRpc.mockResolvedValue({ result: { environment: {} }, serverTime: '' });
    sdkSend.mockResolvedValue({
      microvmId: 'mvm-123',
      state: 'PENDING',
      startedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const out = await provisionEnvironment(SCOPE, inputs, 'anvil-pair-AAAAA');
    expect(out['providerRef']).toBe('mvm-123');

    const run = sdkCommands.find((c) => c.kind === 'run');
    expect(run).toBeDefined();
    const input = run?.input as Record<string, unknown>;
    expect(input['imageIdentifier']).toBe('arn:aws:lambda:img/anvil-worker:1');
    expect(input['maximumDurationInSeconds']).toBe(1800);
    expect(input['clientToken']).toBe('anvil-env-env_test1');
    const hook = JSON.parse(input['runHookPayload'] as string) as Record<string, unknown>;
    expect(hook['pairing']).toBe('anvil-pair-AAAAA');
    expect(hook['backendUrl']).toBe('https://api.test');
    expect(hook['environmentId']).toBe('env_test1');

    const reports = backendRpc.mock.calls.map((call) => call[2] as Record<string, unknown>);
    expect(reports.map((r) => r['state'])).toEqual(['provisioning', 'provisioning']);
    const local = listLocalEnvironments(SCOPE);
    expect(local).toHaveLength(1);
    expect(local[0]?.handle?.['providerRef']).toBe('mvm-123');
    expect(local[0]?.state).toBe('provisioning');
  });

  it('prefers the job imageRef over the connection imageIdentifier', async () => {
    addAwsConnection();
    backendRpc.mockResolvedValue({ result: { environment: {} }, serverTime: '' });
    sdkSend.mockResolvedValue({ microvmId: 'mvm-9', state: 'PENDING' });
    await provisionEnvironment(SCOPE, { ...inputs, imageRef: 'img-override' }, 'anvil-pair-BBBBB');
    const run = sdkCommands.find((c) => c.kind === 'run');
    expect((run?.input as Record<string, unknown>)['imageIdentifier']).toBe('img-override');
  });

  it('marks the environment failed when provider.create rejects', async () => {
    addAwsConnection();
    backendRpc.mockResolvedValue({ result: { environment: {} }, serverTime: '' });
    sdkSend.mockRejectedValue(new Error('access denied'));
    await expect(provisionEnvironment(SCOPE, inputs, 'anvil-pair-CCCCC')).rejects.toThrow(
      'access denied',
    );
    expect(listLocalEnvironments(SCOPE)[0]?.state).toBe('failed');
    const reports = backendRpc.mock.calls.map((call) => call[2] as Record<string, unknown>);
    expect(reports.map((r) => r['state'])).toContain('failed');
  });

  it('rejects an unimplemented provider before touching the backend', async () => {
    addProviderConnection(SCOPE, { provider: 'vercel-sandbox', config: {} });
    await expect(
      provisionEnvironment(
        SCOPE,
        { environmentId: 'env_v', provider: 'vercel-sandbox', ttlSeconds: 60 },
        'anvil-pair-DDDDD',
      ),
    ).rejects.toThrow('not implemented');
    expect(backendRpc).not.toHaveBeenCalled();
  });
});

describe('terminate + reap', () => {
  async function provisioned(environmentId = 'env_term'): Promise<void> {
    addAwsConnection();
    backendRpc.mockResolvedValue({ result: { environment: {} }, serverTime: '' });
    sdkSend.mockResolvedValue({ microvmId: 'mvm-t', state: 'PENDING' });
    await provisionEnvironment(
      SCOPE,
      { environmentId, provider: 'aws-lambda-microvm', ttlSeconds: 3600 },
      'anvil-pair-EEEEE',
    );
  }

  it('terminates a tracked environment and reports terminated', async () => {
    await provisioned();
    sdkSend.mockResolvedValue({});
    const outcome = await terminateEnvironment(SCOPE, 'env_term');
    expect(outcome).toBe('requested');
    const terminate = sdkCommands.find((c) => c.kind === 'terminate');
    expect((terminate?.input as Record<string, unknown>)['microvmIdentifier']).toBe('mvm-t');
    expect(listLocalEnvironments(SCOPE)[0]?.state).toBe('terminated');
    const reports = backendRpc.mock.calls.map((call) => call[2] as Record<string, unknown>);
    expect(reports.map((r) => r['state'])).toContain('terminated');
  });

  it('returns untracked for unknown environments', async () => {
    expect(await terminateEnvironment(SCOPE, 'env_nope')).toBe('untracked');
  });

  it('reaps locally-expired environments and honors backend reap intent', async () => {
    await provisioned('env_stale');
    // Age the row past its TTL.
    db.prepare(
      "UPDATE cloud_environments SET expires_at = '2000-01-01T00:00:00Z' WHERE environment_id = 'env_stale'",
    ).run();
    backendRpc.mockImplementation((_conn: unknown, op: string) => {
      if (op === 'environment.list') {
        return Promise.resolve({ result: { environments: [] }, serverTime: '' });
      }
      return Promise.resolve({ result: { environment: {} }, serverTime: '' });
    });
    sdkSend.mockResolvedValue({});
    expect(await reapExpiredEnvironments(SCOPE)).toBe(1);
    expect(listLocalEnvironments(SCOPE)[0]?.state).toBe('terminated');
  });

  it('terminates locally-tracked envs the backend marked reap-requested', async () => {
    await provisioned('env_intent');
    backendRpc.mockImplementation((_conn: unknown, op: string) => {
      if (op === 'environment.list') {
        return Promise.resolve({
          result: {
            environments: [{ environmentId: 'env_intent', state: 'reap-requested' }],
          },
          serverTime: '',
        });
      }
      return Promise.resolve({ result: { environment: {} }, serverTime: '' });
    });
    sdkSend.mockResolvedValue({});
    expect(await reapExpiredEnvironments(SCOPE)).toBe(1);
    expect(sdkCommands.some((c) => c.kind === 'terminate')).toBe(true);
  });
});
