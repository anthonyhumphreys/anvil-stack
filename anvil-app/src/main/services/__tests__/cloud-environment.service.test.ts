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

const vercelCreate = vi.hoisted(() => vi.fn());
const vercelGet = vi.hoisted(() => vi.fn());
vi.mock('@vercel/sandbox', () => ({
  Sandbox: { create: vercelCreate, get: vercelGet },
}));

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

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  db.exec('DELETE FROM cloud_provider_connections');
  db.exec('DELETE FROM cloud_environments');
  backendRpc.mockReset();
  sdkSend.mockReset();
  sdkCommands.length = 0;
  vercelCreate.mockReset();
  vercelGet.mockReset();
  fetchMock.mockReset();
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

    const out = await provisionEnvironment(SCOPE, inputs, 'anvil-ec-AAAAA');
    expect(out['providerRef']).toBe('mvm-123');

    const run = sdkCommands.find((c) => c.kind === 'run');
    expect(run).toBeDefined();
    const input = run?.input as Record<string, unknown>;
    expect(input['imageIdentifier']).toBe('arn:aws:lambda:img/anvil-worker:1');
    expect(input['maximumDurationInSeconds']).toBe(1800);
    expect(input['clientToken']).toBe('anvil-env-env_test1');
    const hook = JSON.parse(input['runHookPayload'] as string) as Record<string, unknown>;
    expect(hook['enrollmentCode']).toBe('anvil-ec-AAAAA');
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
    await provisionEnvironment(SCOPE, { ...inputs, imageRef: 'img-override' }, 'anvil-ec-BBBBB');
    const run = sdkCommands.find((c) => c.kind === 'run');
    expect((run?.input as Record<string, unknown>)['imageIdentifier']).toBe('img-override');
  });

  it('marks the environment failed when provider.create rejects', async () => {
    addAwsConnection();
    backendRpc.mockResolvedValue({ result: { environment: {} }, serverTime: '' });
    sdkSend.mockRejectedValue(new Error('access denied'));
    await expect(provisionEnvironment(SCOPE, inputs, 'anvil-ec-CCCCC')).rejects.toThrow(
      'access denied',
    );
    expect(listLocalEnvironments(SCOPE)[0]?.state).toBe('failed');
    const reports = backendRpc.mock.calls.map((call) => call[2] as Record<string, unknown>);
    expect(reports.map((r) => r['state'])).toContain('failed');
  });

  it('rejects anvil-managed: no device-side provider exists', async () => {
    await expect(
      provisionEnvironment(
        SCOPE,
        { environmentId: 'env_m', provider: 'anvil-managed', ttlSeconds: 60 },
        'anvil-ec-DDDDD',
      ),
    ).rejects.toThrow('anvil-managed');
    expect(backendRpc).not.toHaveBeenCalled();
  });
});

describe('cloudflare-sandbox provider (ENV-04)', () => {
  const inputs = {
    environmentId: 'env_cf1',
    provider: 'cloudflare-sandbox' as const,
    ttlSeconds: 1800,
  };

  function addCfConnection() {
    return addProviderConnection(SCOPE, {
      provider: 'cloudflare-sandbox',
      config: { url: 'https://provisioner.example.workers.dev/' },
      secret: JSON.stringify({ token: 'prov-token' }),
    });
  }

  it('posts the bootstrap doc to the provisioner and stores the providerRef', async () => {
    addCfConnection();
    backendRpc.mockResolvedValue({ result: { environment: {} }, serverTime: '' });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ providerRef: 'env_cf1' }), { status: 201 }),
    );

    const out = await provisionEnvironment(SCOPE, inputs, 'anvil-ec-FFFFF');
    expect(out['providerRef']).toBe('env_cf1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://provisioner.example.workers.dev/v1/environments');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer prov-token',
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['environmentId']).toBe('env_cf1');
    const bootstrap = body['bootstrap'] as Record<string, unknown>;
    expect(bootstrap['kind']).toBe('anvil.mesh-environment');
    expect(bootstrap['provider']).toBe('cloudflare-sandbox');
    expect(bootstrap['enrollmentCode']).toBe('anvil-ec-FFFFF');
    expect(bootstrap['backendUrl']).toBe('https://api.test');
  });

  it('fails the environment when the provisioner rejects', async () => {
    addCfConnection();
    backendRpc.mockResolvedValue({ result: { environment: {} }, serverTime: '' });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'quota' }), { status: 429 }),
    );
    await expect(provisionEnvironment(SCOPE, inputs, 'anvil-ec-GGGGG')).rejects.toThrow(
      '429',
    );
    expect(listLocalEnvironments(SCOPE)[0]?.state).toBe('failed');
  });

  it('terminates through the provisioner DELETE', async () => {
    addCfConnection();
    backendRpc.mockResolvedValue({ result: { environment: {} }, serverTime: '' });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ providerRef: 'env_cf1' }), { status: 201 }),
    );
    await provisionEnvironment(SCOPE, inputs, 'anvil-ec-HHHHH');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    const outcome = await terminateEnvironment(SCOPE, 'env_cf1');
    expect(outcome).toBe('requested');
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe('https://provisioner.example.workers.dev/v1/environments/env_cf1');
    expect(init.method).toBe('DELETE');
  });
});

describe('vercel-sandbox provider (ENV-05)', () => {
  const inputs = {
    environmentId: 'env_VC1',
    provider: 'vercel-sandbox' as const,
    ttlSeconds: 3600,
  };

  function addVercelConnection() {
    return addProviderConnection(SCOPE, {
      provider: 'vercel-sandbox',
      config: {
        image: 'vcr.vercel.com/team/proj/anvil-worker:latest',
        teamId: 'team_1',
        projectId: 'proj_1',
      },
      secret: JSON.stringify({ token: 'vercel-token' }),
    });
  }

  it('creates the sandbox with the bootstrap env and runs the boot script', async () => {
    addVercelConnection();
    backendRpc.mockResolvedValue({ result: { environment: {} }, serverTime: '' });
    const runCommand = vi.fn().mockResolvedValue({});
    vercelCreate.mockResolvedValue({ name: 'anvil-env-vc1', runCommand });

    const out = await provisionEnvironment(SCOPE, inputs, 'anvil-ec-IIIII');
    expect(out['providerRef']).toBe('anvil-env-vc1');

    const params = vercelCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params['name']).toBe('anvil-env-vc1');
    expect(params['image']).toBe('vcr.vercel.com/team/proj/anvil-worker:latest');
    expect(params['timeout']).toBe(3_600_000);
    expect(params['persistent']).toBe(false);
    expect(params['token']).toBe('vercel-token');
    const env = (params['env'] as Record<string, string>)['ANVIL_BOOTSTRAP_JSON'];
    const bootstrap = JSON.parse(env) as Record<string, unknown>;
    expect(bootstrap['provider']).toBe('vercel-sandbox');
    expect(bootstrap['enrollmentCode']).toBe('anvil-ec-IIIII');
    expect(runCommand).toHaveBeenCalledWith({
      cmd: '/opt/anvil/bin/anvil-worker-boot',
      detached: true,
    });
  });

  it('fails the environment when create rejects', async () => {
    addVercelConnection();
    backendRpc.mockResolvedValue({ result: { environment: {} }, serverTime: '' });
    vercelCreate.mockRejectedValue(new Error('image not found'));
    await expect(provisionEnvironment(SCOPE, inputs, 'anvil-ec-JJJJJ')).rejects.toThrow(
      'image not found',
    );
    expect(listLocalEnvironments(SCOPE)[0]?.state).toBe('failed');
  });

  it('stops the sandbox on terminate; a vanished sandbox is idempotent', async () => {
    addVercelConnection();
    backendRpc.mockResolvedValue({ result: { environment: {} }, serverTime: '' });
    vercelCreate.mockResolvedValue({ name: 'anvil-env-vc1', runCommand: vi.fn() });
    await provisionEnvironment(SCOPE, inputs, 'anvil-ec-KKKKK');

    const stop = vi.fn().mockResolvedValue({});
    vercelGet.mockResolvedValue({ status: 'running', stop });
    expect(await terminateEnvironment(SCOPE, 'env_VC1')).toBe('verified');
    expect(vercelGet).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'anvil-env-vc1' }),
    );
    expect(stop).toHaveBeenCalled();

    vercelGet.mockRejectedValue(new Error('sandbox not found'));
    db.prepare(
      "UPDATE cloud_environments SET state = 'provisioning' WHERE environment_id = 'env_VC1'",
    ).run();
    expect(await terminateEnvironment(SCOPE, 'env_VC1')).toBe('verified');
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
      'anvil-ec-EEEEE',
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
