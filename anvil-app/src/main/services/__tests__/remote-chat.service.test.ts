import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);

const calls: unknown[] = [];
const rpcCalls: Array<{ operation: string; params: unknown }> = [];
let submit: (params: unknown) => Promise<{ id: string }> = async () => ({ id: 'prep-job-1' });
let prepare: (input: unknown) => Promise<unknown> = async (input) => ({
  requestId: (input as { requestId: string }).requestId,
  inputManifest: {
    workspaceDefinitionRevision: 'prepared-revision',
    repositories: [{ repositoryId: 'prepared-repo', commit: 'prepared-target-commit' }],
    bootstrapDigest: 'prepared-bootstrap',
  },
  sealedInputs: 'sealed',
});
let resolveDevice: () => unknown = () => ({
  devices: [{ enrollmentId: 'enr-target', revoked: false, enrollmentClass: 'device' }],
});
let rpcHandler: (operation: string, params: unknown) => unknown | Promise<unknown> = () => ({});
let prepareStart: (input: unknown) => Promise<unknown> = async (input) => ({
  requestId: (input as { requestId: string }).requestId,
  inputManifest: {
    workspaceDefinitionRevision: 'workspace-rev-1',
    repositories: [{ repositoryId: 'repo-a', commit: 'commit-a' }],
    bootstrapDigest: 'bootstrap-a',
  },
  sealedInputs: 'start-sealed',
});
let openedTaskResult: unknown = {
  assistantOutput: 'The answer.',
  resumeHandle: 'provider-thread-1',
};
let cloudProviderEnabled = true;
vi.mock('../cloud-agent-settings.service.js', () => ({
  isCloudAgentProviderEnabled: () => cloudProviderEnabled,
}));
let credentialAvailabilityError: Error | null = null;
let targetTrustState: 'trusted' | 'pending' | 'revoked' | null = 'trusted';

vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../sync-backend-client.service.js', () => ({
  rpc: async (_connection: unknown, operation: string, params: unknown) => {
    if (operation === 'device.list') return { result: resolveDevice(), serverTime: '' };
    rpcCalls.push({ operation, params });
    return { result: await rpcHandler(operation, params), serverTime: '' };
  },
}));
vi.mock('../mesh-worker.service.js', () => ({
  preparePrepareWorkspaceJob: (input: unknown) => prepare(input),
  prepareStartSessionJob: (input: unknown) => prepareStart(input),
  submitPreparedJob: (params: unknown) => {
    calls.push(params);
    return submit(params);
  },
}));
vi.mock('../sync-keyring.service.js', () => ({
  deviceTrustState: () => targetTrustState,
  taskKeyFor: vi.fn(() => Buffer.from('task-key')),
  unsealTaskInputs: vi.fn(() => ({
    handoffCheckpoint: {
      sessionId: 'session-a',
      schemaVersion: 1,
      sourceGeneration: 1,
      repositories: [{ repositoryId: 'prepared-repo', commit: 'prepared-target-commit' }],
      provider: 'codex',
      model: 'test-model',
      artifactRefs: [],
      unresolvedApprovals: [],
    },
  })),
  unsealTaskResult: vi.fn(() => openedTaskResult),
}));
vi.mock('../remote-credentials.service.js', () => ({
  ensureRemoteCredentialGrant: vi.fn(async () => ({ delivered: false })),
  validateRemoteCredentialChoice: vi.fn(),
  validateRemoteCredentialAvailability: vi.fn(() => {
    if (credentialAvailabilityError) throw credentialAvailabilityError;
  }),
}));

import {
  adoptHandoffRemoteChat,
  cancelRemoteChat,
  configureRemoteChatContext,
  createRemoteChat,
  getRemoteChat,
  listRemoteChats,
  remoteChatTick,
  resetRemoteChatForTests,
} from '../remote-chat.service';

const scope = { backendId: 'backend-a', accountId: 'account-a', datasetEpoch: '1' };
const context = {
  apiUrl: 'https://sync.test',
  accessToken: 'token',
  enrollmentId: 'enr-source',
  scope,
};

beforeEach(() => {
  db.exec('DELETE FROM remote_chats; DELETE FROM mesh_remote_provider_sessions;');
  calls.length = 0;
  rpcCalls.length = 0;
  submit = async () => ({ id: 'prep-job-1' });
  prepare = async (input) => ({
    requestId: (input as { requestId: string }).requestId,
    inputManifest: {
      workspaceDefinitionRevision: 'prepared-revision',
      repositories: [{ repositoryId: 'prepared-repo', commit: 'prepared-target-commit' }],
      bootstrapDigest: 'prepared-bootstrap',
    },
    sealedInputs: 'sealed',
  });
  prepareStart = async (input) => ({
    requestId: (input as { requestId: string }).requestId,
    inputManifest: {
      workspaceDefinitionRevision: 'workspace-rev-1',
      repositories: [{ repositoryId: 'repo-a', commit: 'commit-a' }],
      bootstrapDigest: 'bootstrap-a',
    },
    sealedInputs: 'start-sealed',
  });
  openedTaskResult = { assistantOutput: 'The answer.', resumeHandle: 'provider-thread-1' };
  targetTrustState = 'trusted';
  credentialAvailabilityError = null;
  cloudProviderEnabled = true;
  rpcHandler = () => ({});
  resolveDevice = () => ({
    devices: [{ enrollmentId: 'enr-target', revoked: false, enrollmentClass: 'device' }],
  });
  resetRemoteChatForTests();
  configureRemoteChatContext(() => context);
});

const input = {
  workspaceId: 'workspace-a',
  targetEnrollmentId: 'enr-target',
  provider: 'cursor' as const,
  model: 'cursor-small',
  permissionMode: 'on-request' as const,
  prompt: 'Inspect the project',
  requestId: 'create-request-1',
};

describe('remote chat controller', () => {
  it.each(['cursor', 'devin', 'openai', 'azure', 'llmgateway'] as const)(
    'uses configured cloud credentials for %s',
    async (provider) => {
      resolveDevice = () => ({
        devices: [{ enrollmentId: 'enr-target', revoked: false, enrollmentClass: 'ephemeral' }],
      });
      const chat = await createRemoteChat({ ...input, provider });
      expect(chat.credentialChoice).toBe('cloud-provider');
    },
  );

  it('rejects disabled cloud providers before preparing any jobs', async () => {
    resolveDevice = () => ({
      devices: [{ enrollmentId: 'enr-target', revoked: false, enrollmentClass: 'ephemeral' }],
    });
    cloudProviderEnabled = false;
    await expect(createRemoteChat(input)).rejects.toThrow(/Enable this provider/);
    expect(calls).toEqual([]);
  });

  it('rejects missing configured cloud credentials before preparing any jobs', async () => {
    resolveDevice = () => ({
      devices: [{ enrollmentId: 'enr-target', revoked: false, enrollmentClass: 'ephemeral' }],
    });
    credentialAvailabilityError = new Error('Connect Cursor in Cloud agent settings.');
    await expect(createRemoteChat(input)).rejects.toThrow(/Connect Cursor/);
    expect(calls).toEqual([]);
  });
  it('defaults cloud Codex chats to the launch host login and seals a stable auth session identity', async () => {
    resolveDevice = () => ({
      devices: [{ enrollmentId: 'enr-target', revoked: false, enrollmentClass: 'ephemeral' }],
    });
    const startInputs: Array<Record<string, unknown>> = [];
    prepareStart = async (value) => {
      startInputs.push(value as Record<string, unknown>);
      return {
        requestId: (value as { requestId: string }).requestId,
        inputManifest: {
          workspaceDefinitionRevision: 'prepared-revision',
          repositories: [],
          bootstrapDigest: 'none',
        },
        sealedInputs: 'start-sealed',
      };
    };
    rpcHandler = () => ({ job: { id: 'prep-job-1', state: 'completed' }, attempts: [] });
    const chat = await createRemoteChat({ ...input, provider: 'codex' });
    expect(chat.credentialChoice).toBe('codex-host-auth');
    await remoteChatTick();
    expect(startInputs[0]).toMatchObject({ authMode: 'codex-host-auth', authSessionId: chat.id });
    expect(JSON.stringify(calls)).not.toContain('access_token');
  });

  it('rejects unavailable launch-host auth before creating a cloud job', async () => {
    resolveDevice = () => ({
      devices: [{ enrollmentId: 'enr-target', revoked: false, enrollmentClass: 'ephemeral' }],
    });
    credentialAvailabilityError = new Error('Host Codex auth is unavailable');
    await expect(createRemoteChat({ ...input, provider: 'codex' })).rejects.toThrow(
      'Host Codex auth is unavailable',
    );
    expect(calls).toEqual([]);
    expect(listRemoteChats()).toEqual([]);
  });

  it('deduplicates creation and rejects request-id reuse with different parameters', async () => {
    const first = await createRemoteChat(input);
    const duplicate = await createRemoteChat(input);
    expect(duplicate.id).toBe(first.id);
    expect(listRemoteChats('workspace-a')).toHaveLength(1);
    await expect(createRemoteChat({ ...input, prompt: 'Different prompt' })).rejects.toThrow(
      /reused/,
    );
  });

  it('persists and replays the exact sealed preparation request after a lost response', async () => {
    let attempt = 0;
    submit = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('connection dropped after submit');
      return { id: 'prep-job-1' };
    };
    const created = await createRemoteChat(input);
    const durable = getRemoteChat(created.id)!;
    expect(durable.prepareJobId).toBeUndefined();
    const storedBefore = db
      .prepare('SELECT record_json FROM remote_chats WHERE id = ?')
      .get(created.id) as { record_json: string };
    const exactBefore = JSON.parse(storedBefore.record_json).prepareRequestJson;
    await import('../remote-chat.service').then(({ remoteChatTick }) => remoteChatTick());
    const storedAfter = db
      .prepare('SELECT record_json FROM remote_chats WHERE id = ?')
      .get(created.id) as { record_json: string };
    expect(JSON.parse(storedAfter.record_json).prepareJobId).toBe('prep-job-1');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(JSON.stringify(calls[0])).toBe(exactBefore);
  });

  it('hides records after the active sync account changes', async () => {
    const created = await createRemoteChat(input);
    configureRemoteChatContext(() => ({ ...context, scope: { ...scope, accountId: 'account-b' } }));
    expect(getRemoteChat(created.id)).toBeNull();
    expect(listRemoteChats()).toEqual([]);
    await expect(cancelRemoteChat(created.id)).rejects.toThrow(/not found/);
  });

  it('rejects pending destinations before preparing a remote job', async () => {
    targetTrustState = 'pending';
    await expect(createRemoteChat(input)).rejects.toThrow(/trusted destination/);
    expect(calls).toEqual([]);
    expect(listRemoteChats()).toEqual([]);
  });

  it('honors cancellation while workspace preparation is being sealed', async () => {
    let finish!: (params: unknown) => void;
    prepare = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const creating = createRemoteChat(input);
    await vi.waitFor(() => expect(db.prepare('SELECT id FROM remote_chats').get()).toBeTruthy());
    const id = (db.prepare('SELECT id FROM remote_chats').get() as { id: string }).id;
    expect((await cancelRemoteChat(id)).state).toBe('cancelled');
    finish({ requestId: 'prep-request', inputManifest: {}, sealedInputs: 'sealed' });
    expect((await creating).state).toBe('cancelled');
    expect(calls).toEqual([]);
  });

  it('waits for preparation, returns the encrypted result, and resumes the same target with pinned repos', async () => {
    const startInputs: Record<string, unknown>[] = [];
    prepareStart = async (value) => {
      startInputs.push(value as Record<string, unknown>);
      return {
        requestId: (value as { requestId: string }).requestId,
        inputManifest: {
          workspaceDefinitionRevision: 'prepared-revision',
          repositories: [{ repositoryId: 'prepared-repo', commit: 'prepared-target-commit' }],
          bootstrapDigest: 'prepared-bootstrap',
        },
        sealedInputs: 'start-sealed',
      };
    };
    let preparationState = 'running';
    let startSubmissions = 0;
    rpcHandler = (operation, rawParams) => {
      if (operation !== 'job.get') return {};
      const jobId = (rawParams as { jobId: string }).jobId;
      if (jobId === 'prep-job-1')
        return { job: { id: jobId, requestId: 'prep', state: preparationState }, attempts: [] };
      if (jobId === 'run-job-1') {
        return {
          job: { id: jobId, requestId: 'run-request', state: 'completed' },
          attempts: [{ id: 'attempt-1', state: 'completed', sealedResult: 'ciphertext' }],
        };
      }
      return { job: { id: jobId, requestId: 'follow', state: 'running' }, attempts: [] };
    };
    submit = async (rawParams) => {
      const requestId = (rawParams as { requestId: string }).requestId;
      if (requestId.includes('remote-chat-start:')) {
        startSubmissions += 1;
        return { id: 'run-job-1' };
      }
      return { id: 'prep-job-1' };
    };

    const created = await createRemoteChat(input);
    await remoteChatTick();
    expect(getRemoteChat(created.id)?.state).toBe('preparing');
    expect(startSubmissions).toBe(0);

    preparationState = 'completed';
    await remoteChatTick();
    expect(startSubmissions).toBe(1);
    expect(startInputs[0]).toMatchObject({
      manifestPin: {
        workspaceDefinitionRevision: 'prepared-revision',
        repositories: [{ repositoryId: 'prepared-repo', commit: 'prepared-target-commit' }],
        bootstrapDigest: 'prepared-bootstrap',
      },
    });
    await remoteChatTick();
    const completed = getRemoteChat(created.id)!;
    expect(completed.state).toBe('completed');
    expect(completed.turns[0]).toMatchObject({ response: 'The answer.' });
    expect(completed.turns[0]).not.toHaveProperty('resumeHandle');

    const followupInput: Record<string, unknown>[] = [];
    prepareStart = async (value) => {
      followupInput.push(value as Record<string, unknown>);
      return {
        requestId: (value as { requestId: string }).requestId,
        inputManifest: (value as { manifestPin: unknown }).manifestPin,
        sealedInputs: 'followup-sealed',
      };
    };
    const followed = await import('../remote-chat.service').then(({ sendRemoteChat }) =>
      sendRemoteChat({ sessionId: created.id, requestId: 'follow-request', prompt: 'Continue' }),
    );
    expect(followed.state).toBe('starting');
    expect(followupInput[0]).toMatchObject({
      targetEnrollmentId: 'enr-target',
      resumeThreadId: 'provider-thread-1',
      manifestPin: {
        repositories: [{ repositoryId: 'prepared-repo', commit: 'prepared-target-commit' }],
      },
    });
  });

  it('keeps a stop pending during job polling and reconciles a late completion before allowing follow-up', async () => {
    let jobState = 'running';
    let releaseJobGet!: (value: unknown) => void;
    let deferNextGet = true;
    rpcHandler = async (operation, rawParams) => {
      if (operation === 'job.cancel')
        return { job: { id: 'run-job-1', state: 'cancel-requested' } };
      if (operation !== 'job.get') return {};
      const jobId = (rawParams as { jobId: string }).jobId;
      if (jobId === 'prep-job-1')
        return { job: { id: jobId, requestId: 'prep', state: 'completed' }, attempts: [] };
      if (deferNextGet) {
        deferNextGet = false;
        return await new Promise((resolve) => {
          releaseJobGet = resolve;
        });
      }
      return {
        job: { id: jobId, requestId: 'run-request', state: jobState },
        attempts:
          jobState === 'completed'
            ? [{ id: 'attempt-1', state: 'completed', sealedResult: 'ciphertext' }]
            : [],
      };
    };
    submit = async (rawParams) => {
      const requestId = (rawParams as { requestId: string }).requestId;
      return { id: requestId.includes('remote-chat-start:') ? 'run-job-1' : 'prep-job-1' };
    };
    const created = await createRemoteChat(input);
    await remoteChatTick();

    const polling = remoteChatTick();
    await vi.waitFor(() => expect(releaseJobGet).toBeTypeOf('function'));
    expect((await cancelRemoteChat(created.id)).state).toBe('cancel-requested');
    releaseJobGet({
      job: { id: 'run-job-1', requestId: 'run-request', state: 'running' },
      attempts: [],
    });
    await polling;
    expect(getRemoteChat(created.id)?.state).toBe('cancel-requested');

    jobState = 'completed';
    await remoteChatTick();
    expect(getRemoteChat(created.id)).toMatchObject({
      state: 'completed',
      turns: [{ response: 'The answer.' }],
    });

    prepareStart = async (value) => ({
      requestId: (value as { requestId: string }).requestId,
      inputManifest: {
        workspaceDefinitionRevision: 'workspace-rev-1',
        repositories: [{ repositoryId: 'repo-a', commit: 'commit-a' }],
        bootstrapDigest: 'bootstrap-a',
      },
      sealedInputs: 'followup-sealed',
    });
    const { sendRemoteChat } = await import('../remote-chat.service');
    const next = await sendRemoteChat({
      sessionId: created.id,
      requestId: 'after-stop',
      prompt: 'Continue',
    });
    expect(next.state).toBe('starting');
  });

  it('retries a failed handoff as a fresh provider turn pinned to the destination checkpoint', async () => {
    const activationRequest = {
      requestId: 'handoff-start:handoff-a',
      kind: 'start-session',
      inputManifest: {
        workspaceDefinitionRevision: 'prepared-revision',
        repositories: [{ repositoryId: 'prepared-repo', commit: 'prepared-target-commit' }],
        bootstrapDigest: 'prepared-bootstrap',
        inputs: { handoffId: 'handoff-a' },
      },
    } as never;
    const adopted = adoptHandoffRemoteChat({
      handoffId: 'handoff-a',
      sourceSessionId: 'source-session-a',
      workspaceId: 'workspace-a',
      targetEnrollmentId: 'enr-target',
      provider: 'codex',
      model: 'gpt-5',
      permissionMode: 'on-request',
      prepareJobId: 'prepare-job-a',
      activationJobId: 'activation-job-a',
      activationRequestJson: JSON.stringify(activationRequest),
      credentialChoice: 'codex-account',
    });
    const row = db.prepare('SELECT record_json FROM remote_chats WHERE id = ?').get(adopted.id) as {
      record_json: string;
    };
    const failed = JSON.parse(row.record_json) as Record<string, unknown> & {
      turns: Array<Record<string, unknown>>;
    };
    failed.state = 'failed';
    failed.error = 'provider launch failed';
    failed.turns[0]!.state = 'failed';
    failed.turns[0]!.error = 'provider launch failed';
    db.prepare('UPDATE remote_chats SET state = ?, record_json = ? WHERE id = ?').run(
      'failed',
      JSON.stringify(failed),
      adopted.id,
    );

    let retryInput: Record<string, unknown> | undefined;
    prepareStart = async (value) => {
      retryInput = value as Record<string, unknown>;
      return {
        requestId: (value as { requestId: string }).requestId,
        inputManifest: {
          workspaceDefinitionRevision: 'prepared-revision',
          repositories: [{ repositoryId: 'prepared-repo', commit: 'prepared-target-commit' }],
          bootstrapDigest: 'prepared-bootstrap',
        },
        sealedInputs: 'retry-sealed',
      };
    };
    submit = async () => ({ id: 'retry-activation-job' });

    const retried = await import('../remote-chat.service').then(({ sendRemoteChat }) =>
      sendRemoteChat({
        sessionId: adopted.id,
        requestId: 'handoff-retry-1',
        prompt: 'Start a fresh provider turn from the transferred checkpoint.',
      }),
    );
    expect(retried.state).toBe('starting');
    expect(retried.turns).toHaveLength(2);
    expect(retryInput).toMatchObject({
      handoffId: 'handoff-a',
      targetEnrollmentId: 'enr-target',
      manifestPin: {
        repositories: [{ repositoryId: 'prepared-repo', commit: 'prepared-target-commit' }],
      },
    });
    expect(retryInput).not.toHaveProperty('resumeThreadId');
    expect(retried.turns[1]?.prompt).toContain('fresh provider turn');
  });

  it('replays a cancelled follow-up request after restart instead of cancelling old preparation', async () => {
    let runState = 'completed';
    rpcHandler = (operation, rawParams) => {
      if (operation === 'job.cancel') {
        const jobId = (rawParams as { jobId: string }).jobId;
        return { job: { id: jobId, state: 'cancel-requested' } };
      }
      if (operation !== 'job.get') return {};
      const jobId = (rawParams as { jobId: string }).jobId;
      if (jobId === 'prep-job-1')
        return { job: { id: jobId, requestId: 'prep', state: 'completed' }, attempts: [] };
      return {
        job: { id: jobId, requestId: 'run-request', state: runState },
        attempts:
          runState === 'completed'
            ? [{ id: 'attempt-1', state: 'completed', sealedResult: 'ciphertext' }]
            : [],
      };
    };
    submit = async (rawParams) => {
      const requestId = (rawParams as { requestId: string }).requestId;
      return { id: requestId.includes('remote-chat-start:') ? 'run-job-1' : 'prep-job-1' };
    };
    const created = await createRemoteChat(input);
    await remoteChatTick();
    await remoteChatTick();

    const pendingSubmissions: Array<(value: { id: string }) => void> = [];
    const followupRequests: unknown[] = [];
    submit = async (params) => {
      followupRequests.push(params);
      return await new Promise((resolve) => pendingSubmissions.push(resolve));
    };
    const { sendRemoteChat } = await import('../remote-chat.service');
    const sending = sendRemoteChat({
      sessionId: created.id,
      requestId: 'follow-request-pending',
      prompt: 'Continue with the next turn',
    });
    await vi.waitFor(() => expect(pendingSubmissions).toHaveLength(1));
    const durableBeforeCancel = db
      .prepare('SELECT record_json FROM remote_chats WHERE id = ?')
      .get(created.id) as { record_json: string };
    const sealedFollowupRequest = JSON.parse(durableBeforeCancel.record_json).turns.at(
      -1,
    ).requestJson;

    const cancelling = cancelRemoteChat(created.id);
    await vi.waitFor(() => expect(pendingSubmissions).toHaveLength(2));
    expect(JSON.stringify(followupRequests[0])).toBe(sealedFollowupRequest);
    expect(followupRequests[1]).toEqual(followupRequests[0]);

    resetRemoteChatForTests();
    configureRemoteChatContext(() => context);
    submit = async () => ({ id: 'followup-job-1' });
    runState = 'running';
    await remoteChatTick();
    expect(getRemoteChat(created.id)).toMatchObject({
      state: 'cancel-requested',
      jobId: 'followup-job-1',
    });
    expect(rpcCalls.filter((call) => call.operation === 'job.cancel')).toEqual([
      expect.objectContaining({ params: { jobId: 'followup-job-1' } }),
    ]);

    pendingSubmissions.forEach((resolve) => resolve({ id: 'followup-job-1' }));
    await Promise.all([sending, cancelling]);
    expect(getRemoteChat(created.id)?.state).toBe('cancel-requested');
  });
});
