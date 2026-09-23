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
vi.mock('../sync-backend-client.service.js', () => ({
  rpc: backendRpc,
}));

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
  requestEnvironment,
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

  it('rejects unknown provider config fields and partial AWS credentials', () => {
    expect(() =>
      addProviderConnection(SCOPE, {
        provider: 'aws-lambda-microvm',
        config: { imageIdentifier: 'img', clientSecret: 'must-not-be-config' },
      }),
    ).toThrow(/secret field/);
    expect(() =>
      addProviderConnection(SCOPE, {
        provider: 'aws-lambda-microvm',
        config: { imageIdentifier: 'img', unsupported: 'nope' },
      }),
    ).toThrow(/unknown .* config field/i);
    expect(() =>
      addProviderConnection(SCOPE, {
        provider: 'aws-lambda-microvm',
        config: { imageIdentifier: 'img' },
        secret: JSON.stringify({ accessKeyId: 'AKIA-only' }),
      }),
    ).toThrow(/must be supplied together/);
  });

  it('redacts credential-shaped fields from legacy nested config before returning it', () => {
    const created = addAwsConnection();
    db.prepare('UPDATE cloud_provider_connections SET config_json = ? WHERE id = ?').run(
      JSON.stringify({
        region: 'eu-west-1',
        nested: { clientSecret: 'legacy-leak', safe: 'visible' },
      }),
      created.id,
    );
    const listed = listProviderConnections(SCOPE);
    expect(JSON.stringify(listed)).not.toContain('legacy-leak');
    expect(listed[0]?.config['nested']).toEqual({ safe: 'visible' });
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

  it('refuses to remove a connection while cleanup is unverified', () => {
    const created = addAwsConnection();
    db.prepare(
      `INSERT INTO cloud_environments (
         environment_id, backend_id, account_id, provider, state, handle_json,
         enrollment_id, job_id, connection_id, created_by, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'env_unverified',
      SCOPE.backendId,
      SCOPE.accountId,
      'aws-lambda-microvm',
      'failed',
      JSON.stringify({ environmentId: 'env_unverified', providerRef: 'mvm-1' }),
      null,
      null,
      created.id,
      SCOPE.accountId,
      null,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    expect(() => removeProviderConnection(SCOPE, created.id)).toThrow(/still needed/);
    expect(listProviderConnections(SCOPE)).toHaveLength(1);
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

  it('rejects a cross-scope environment id before calling the provider', async () => {
    const otherScope: ProvisionerScope = {
      ...SCOPE,
      backendId: 'backend-2',
      accountId: 'account-2',
      enrollmentId: 'enr-other',
    };
    addAwsConnection();
    addProviderConnection(otherScope, {
      provider: 'aws-lambda-microvm',
      config: { imageIdentifier: 'arn:aws:lambda:img/other:1' },
      secret: JSON.stringify({ accessKeyId: 'AKIA-other', secretAccessKey: 'secret-other' }),
    });
    backendRpc.mockResolvedValue({ result: { environment: {} }, serverTime: '' });
    sdkSend.mockResolvedValue({ microvmId: 'mvm-original', state: 'PENDING' });
    await provisionEnvironment(
      SCOPE,
      { environmentId: 'env_cross_scope', provider: 'aws-lambda-microvm', ttlSeconds: 1800 },
      'anvil-ec-ORIGINAL',
    );
    const original = listLocalEnvironments(SCOPE)[0];
    sdkCommands.length = 0;

    await expect(
      provisionEnvironment(
        otherScope,
        { environmentId: 'env_cross_scope', provider: 'aws-lambda-microvm', ttlSeconds: 1800 },
        'anvil-ec-OTHER',
      ),
    ).rejects.toThrow(/another sync scope/);
    expect(sdkCommands).toHaveLength(0);
    expect(listLocalEnvironments(SCOPE)[0]).toMatchObject({
      environmentId: 'env_cross_scope',
      handle: original?.handle,
      connectionId: original?.connectionId,
    });
  });

  it('uses the backend discovery URL in worker bootstrap, not the RPC API path', async () => {
    addAwsConnection();
    backendRpc.mockResolvedValue({ result: { environment: {} }, serverTime: '' });
    sdkSend.mockResolvedValue({ microvmId: 'mvm-base', state: 'PENDING' });
    await provisionEnvironment(
      { ...SCOPE, backendUrl: 'https://sync.example.test/' },
      inputs,
      'anvil-ec-BASEURL',
    );
    const run = sdkCommands.find((c) => c.kind === 'run');
    const hook = JSON.parse(
      (run?.input as Record<string, unknown>)['runHookPayload'] as string,
    ) as Record<string, unknown>;
    expect(hook['backendUrl']).toBe('https://sync.example.test/');
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

describe('requestEnvironment', () => {
  const managedInput = {
    environmentId: 'env_retry',
    provider: 'anvil-managed' as const,
    ttlSeconds: 1800,
  };

  it('recovers an existing managed job before minting another bootstrap code', async () => {
    const mint = vi.fn().mockResolvedValue('anvil-ec-AAAAA-BBBBB-CCCCC-DDDDD');
    let createdJob: {
      id: string;
      requestId: string;
      payloadHash: string;
      sourceEnrollmentId: string;
    } | null = null;
    backendRpc.mockImplementation(
      async (_connection: unknown, operation: string, params: unknown) => {
        if (operation === 'job.list') return { result: { jobs: [] }, serverTime: '' };
        if (operation === 'environment.bootstrap') return { result: { ok: true }, serverTime: '' };
        if (operation === 'job.create') {
          const request = params as { requestId: string; payloadHash: string };
          createdJob = {
            id: 'job-existing',
            requestId: request.requestId,
            payloadHash: request.payloadHash,
            sourceEnrollmentId: SCOPE.enrollmentId,
          };
          return { result: { job: createdJob }, serverTime: '' };
        }
        throw new Error(`unexpected operation ${operation}`);
      },
    );

    await requestEnvironment(SCOPE, managedInput, { mintEnvironmentCode: mint });
    expect(mint).toHaveBeenCalledTimes(1);
    expect(createdJob).not.toBeNull();

    backendRpc.mockReset();
    backendRpc.mockResolvedValue({ result: { jobs: [createdJob] }, serverTime: '' });
    mint.mockClear();
    const replay = await requestEnvironment(SCOPE, managedInput, { mintEnvironmentCode: mint });
    expect(replay.job.id).toBe('job-existing');
    expect(mint).not.toHaveBeenCalled();
    expect(backendRpc.mock.calls.map((call) => call[1])).toEqual(['job.list']);
  });

  it('coalesces concurrent managed retries into one code issuance', async () => {
    const operations: string[] = [];
    backendRpc.mockImplementation(async (_connection: unknown, operation: string) => {
      operations.push(operation);
      if (operation === 'job.list') {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { result: { jobs: [] }, serverTime: '' };
      }
      if (operation === 'environment.bootstrap') return { result: { ok: true }, serverTime: '' };
      return {
        result: {
          job: {
            id: 'job-new',
            requestId: 'env-env_flight',
            payloadHash: 'b'.repeat(64),
            kind: 'provision-environment',
            sourceEnrollmentId: SCOPE.enrollmentId,
            state: 'queued',
            inputManifest: {},
            requestedTarget: { kind: 'auto' },
          },
        },
        serverTime: '',
      };
    });
    const mint = vi.fn().mockResolvedValue('anvil-ec-FFFFF-GGGGG-HHHHH-IIIII');
    const input = { ...managedInput, environmentId: 'env_flight' };
    const [first, second] = await Promise.all([
      requestEnvironment(SCOPE, input, { mintEnvironmentCode: mint }),
      requestEnvironment(SCOPE, input, { mintEnvironmentCode: mint }),
    ]);
    expect(first.job.id).toBe('job-new');
    expect(second.job.id).toBe('job-new');
    expect(mint).toHaveBeenCalledTimes(1);
    expect(operations).toEqual(['job.list', 'environment.bootstrap', 'job.create']);
  });

  it('finds an existing job in a bounded list from an older backend', async () => {
    const operations: string[] = [];
    let createdJob: {
      id: string;
      requestId: string;
      payloadHash: string;
      sourceEnrollmentId: string;
      kind: 'provision-environment';
      state: 'queued';
      inputManifest: Record<string, never>;
      requestedTarget: { kind: 'auto' };
    } | null = null;
    backendRpc.mockImplementation(
      async (_connection: unknown, operation: string, params: unknown) => {
        operations.push(operation);
        if (operation === 'job.list') {
          return {
            result: {
              jobs:
                createdJob === null
                  ? []
                  : [
                      {
                        ...createdJob,
                        id: 'job-other',
                        requestId: 'env-env_legacy',
                        payloadHash: 'a'.repeat(64),
                        sourceEnrollmentId: 'enr-other',
                      },
                      createdJob,
                    ],
            },
            serverTime: '',
          };
        }
        if (operation === 'environment.bootstrap') return { result: { ok: true }, serverTime: '' };
        if (operation !== 'job.create') throw new Error(`unexpected operation ${operation}`);
        const request = params as { requestId: string; payloadHash: string };
        createdJob = {
          id: 'job-legacy',
          requestId: request.requestId,
          payloadHash: request.payloadHash,
          sourceEnrollmentId: SCOPE.enrollmentId,
          kind: 'provision-environment',
          state: 'queued',
          inputManifest: {},
          requestedTarget: { kind: 'auto' },
        };
        return {
          result: { job: createdJob },
          serverTime: '',
        };
      },
    );
    const mint = vi.fn().mockResolvedValue('anvil-ec-JJJJJ-KKKKK-LLLLL-MMMMM');
    const result = await requestEnvironment(
      SCOPE,
      { ...managedInput, environmentId: 'env_legacy' },
      { mintEnvironmentCode: mint },
    );
    expect(result.job.id).toBe('job-legacy');
    expect(mint).toHaveBeenCalledTimes(1);

    operations.length = 0;
    mint.mockClear();
    const replay = await requestEnvironment(
      SCOPE,
      { ...managedInput, environmentId: 'env_legacy' },
      { mintEnvironmentCode: mint },
    );
    expect(replay.job.id).toBe('job-legacy');
    expect(mint).not.toHaveBeenCalled();
    expect(operations).toEqual(['job.list']);
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
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer prov-token');
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
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'quota' }), { status: 429 }));
    await expect(provisionEnvironment(SCOPE, inputs, 'anvil-ec-GGGGG')).rejects.toThrow('429');
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
    const [url, init] = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit).method === 'DELETE',
    ) as [string, RequestInit];
    expect(url).toBe('https://provisioner.example.workers.dev/v1/environments/env_cf1');
    expect(init.method).toBe('DELETE');
    expect(listLocalEnvironments(SCOPE)[0]?.state).toBe('terminating');
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
    vercelGet
      .mockResolvedValueOnce({ status: 'running', stop })
      .mockResolvedValueOnce({ status: 'stopping' });
    expect(await terminateEnvironment(SCOPE, 'env_VC1')).toBe('requested');
    expect(vercelGet).toHaveBeenCalledWith(expect.objectContaining({ name: 'anvil-env-vc1' }));
    expect(stop).toHaveBeenCalled();
    expect(listLocalEnvironments(SCOPE)[0]?.state).toBe('terminating');

    vercelGet.mockResolvedValue({ status: 'stopped', stop });
    expect(await terminateEnvironment(SCOPE, 'env_VC1')).toBe('verified');
    expect(listLocalEnvironments(SCOPE)[0]?.state).toBe('terminated');

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

  it('keeps an accepted but unverified teardown in terminating until inspected gone', async () => {
    await provisioned();
    sdkSend.mockImplementation((command: { kind: string }) =>
      Promise.resolve(command.kind === 'get' ? { state: 'TERMINATING' } : {}),
    );
    const outcome = await terminateEnvironment(SCOPE, 'env_term');
    expect(outcome).toBe('requested');
    const terminate = sdkCommands.find((c) => c.kind === 'terminate');
    expect((terminate?.input as Record<string, unknown>)['microvmIdentifier']).toBe('mvm-t');
    expect(listLocalEnvironments(SCOPE)[0]?.state).toBe('terminating');
    const reports = backendRpc.mock.calls.map((call) => call[2] as Record<string, unknown>);
    expect(reports.map((r) => r['state'])).toContain('terminating');

    sdkSend.mockImplementation((command: { kind: string }) =>
      Promise.resolve(command.kind === 'get' ? { state: 'TERMINATED' } : {}),
    );
    expect(await terminateEnvironment(SCOPE, 'env_term')).toBe('verified');
    expect(listLocalEnvironments(SCOPE)[0]?.state).toBe('terminated');
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
    sdkSend.mockImplementation((command: { kind: string }) =>
      Promise.resolve(command.kind === 'get' ? { state: 'TERMINATED' } : {}),
    );
    expect(await reapExpiredEnvironments(SCOPE)).toBe(1);
    expect(listLocalEnvironments(SCOPE)[0]?.state).toBe('terminated');
  });

  it('still reaps a failed environment when the provider handle remains', async () => {
    await provisioned('env_failed_handle');
    db.prepare(
      "UPDATE cloud_environments SET state = 'failed', expires_at = '2999-01-01T00:00:00Z' WHERE environment_id = 'env_failed_handle'",
    ).run();
    backendRpc.mockImplementation((_conn: unknown, op: string) => {
      if (op === 'environment.list') {
        return Promise.resolve({ result: { environments: [] }, serverTime: '' });
      }
      return Promise.resolve({ result: { environment: {} }, serverTime: '' });
    });
    sdkSend.mockImplementation((command: { kind: string }) =>
      Promise.resolve(command.kind === 'get' ? { state: 'TERMINATED' } : {}),
    );
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
    sdkSend.mockImplementation((command: { kind: string }) =>
      Promise.resolve(command.kind === 'get' ? { state: 'TERMINATED' } : {}),
    );
    expect(await reapExpiredEnvironments(SCOPE)).toBe(1);
    expect(sdkCommands.some((c) => c.kind === 'terminate')).toBe(true);
  });
});
