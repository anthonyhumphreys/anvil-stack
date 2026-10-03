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
const environmentRequests: Array<{ environmentId: string; displayName: string }> = [];
let hostedEnvironments: Array<{
  environmentId: string;
  provider: 'anvil-managed';
  state: 'provisioning' | 'enrolled' | 'running' | 'suspended';
  enrollmentId?: string;
}> = [];
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
  endRemoteChat,
  sendRemoteChat,
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
  environmentRequests.length = 0;
  hostedEnvironments = [];
  credentialAvailabilityError = null;
  cloudProviderEnabled = true;
  rpcHandler = () => ({});
  resolveDevice = () => ({
    devices: [{ enrollmentId: 'enr-target', revoked: false, enrollmentClass: 'device' }],
  });
  resetRemoteChatForTests();
  configureRemoteChatContext(() => ({
    ...context,
    requestHostedEnvironment: async (request) => {
      environmentRequests.push(request);
      return { job: { id: 'managed-provision-job', state: 'queued' } as never };
    },
    listHostedEnvironments: async () => ({ environments: hostedEnvironments as never }),
    suspendHostedEnvironment: async (environmentId) => {
      const row = hostedEnvironments.find(
        (environment) => environment.environmentId === environmentId,
      );
      if (row === undefined) throw new Error('missing environment');
      row.state = 'suspended';
      return row as never;
    },
    resumeHostedEnvironment: async (environmentId) => {
      const row = hostedEnvironments.find(
        (environment) => environment.environmentId === environmentId,
      );
      if (row === undefined) throw new Error('missing environment');
      row.state = 'provisioning';
      return row as never;
    },
    reapHostedEnvironment: async (environmentId) => {
      hostedEnvironments = hostedEnvironments.filter((row) => row.environmentId !== environmentId);
    },
  }));
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
  it('ends a hosted chat, reaps its environment, and rejects future turns', async () => {
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES ('workspace-a', 'A', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO chat_threads (id, workspace_id, persona_id, title) VALUES ('thread-a', 'workspace-a', 'codex', 'Thread A')`,
    ).run();
    const created = await createRemoteChat({
      workspaceId: 'workspace-a',
      target: 'anvil-hosted-cloud',
      sourceThreadId: 'thread-a',
      provider: 'codex',
      model: 'gpt-test',
      permissionMode: 'on-request',
      prompt: 'Start',
      requestId: 'end-hosted-request',
    });
    hostedEnvironments = [
      {
        environmentId: created.environmentId!,
        provider: 'anvil-managed',
        state: 'provisioning',
      },
    ];
    const ended = await endRemoteChat(created.id);
    expect(ended.state).toBe('ended');
    expect(hostedEnvironments).toEqual([]);
    await expect(
      sendRemoteChat({ sessionId: created.id, requestId: 'after-end', prompt: 'Again' }),
    ).rejects.toThrow(/not ready for a follow-up/);
  });

  it('persists hosted provisioning before allocation and reuses its stable environment id on retry', async () => {
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES ('workspace-a', 'A', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO chat_threads (id, workspace_id, persona_id, title) VALUES ('thread-a', 'workspace-a', 'codex', 'Thread A')`,
    ).run();
    const hostedInput = {
      workspaceId: 'workspace-a',
      target: 'anvil-hosted-cloud' as const,
      sourceThreadId: 'thread-a',
      provider: 'codex' as const,
      model: 'gpt-test',
      permissionMode: 'on-request' as const,
      prompt: 'Continue this thread',
      requestId: 'hosted-request-1',
    };
    const first = await createRemoteChat(hostedInput);
    expect(first).toMatchObject({
      target: 'anvil-hosted-cloud',
      sourceThreadId: 'thread-a',
      environmentId: expect.stringMatching(/^remote-/),
      state: 'provisioning',
    });
    expect(environmentRequests).toHaveLength(1);
    const persisted = db
      .prepare('SELECT record_json FROM remote_chats WHERE id = ?')
      .get(first.id) as { record_json: string };
    expect(JSON.parse(persisted.record_json)).toMatchObject({
      state: 'provisioning',
      environmentId: first.environmentId,
      sourceThreadId: 'thread-a',
    });

    const replay = await createRemoteChat(hostedInput);
    expect(replay.id).toBe(first.id);
    expect(environmentRequests.map((request) => request.environmentId)).toEqual([
      first.environmentId,
      first.environmentId,
    ]);
  });

  it('rejects a hosted run whose source thread belongs to another workspace', async () => {
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES ('workspace-a', 'A', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES ('workspace-b', 'B', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO chat_threads (id, workspace_id, persona_id, title) VALUES ('thread-b', 'workspace-b', 'codex', 'Thread B')`,
    ).run();
    await expect(
      createRemoteChat({
        workspaceId: 'workspace-a',
        target: 'anvil-hosted-cloud',
        sourceThreadId: 'thread-b',
        provider: 'codex',
        model: 'gpt-test',
        permissionMode: 'on-request',
        prompt: 'Run this remotely',
      }),
    ).rejects.toThrow(/does not belong to this workspace/);
    expect(environmentRequests).toEqual([]);
  });

  it('adopts only the environment-bound ephemeral enrollment and resumes durable startup after provisioning', async () => {
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES ('workspace-a', 'A', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO chat_threads (id, workspace_id, persona_id, title) VALUES ('thread-a', 'workspace-a', 'codex', 'Thread A')`,
    ).run();
    const hostedInput = {
      workspaceId: 'workspace-a',
      target: 'anvil-hosted-cloud' as const,
      sourceThreadId: 'thread-a',
      provider: 'codex' as const,
      model: 'gpt-test',
      permissionMode: 'on-request' as const,
      prompt: 'Continue this thread',
      requestId: 'hosted-request-ready',
    };
    const created = await createRemoteChat(hostedInput);
    hostedEnvironments = [
      {
        environmentId: created.environmentId!,
        provider: 'anvil-managed',
        state: 'enrolled',
        enrollmentId: 'enr-hosted',
      },
    ];
    resolveDevice = () => ({
      devices: [{ enrollmentId: 'enr-hosted', revoked: false, enrollmentClass: 'ephemeral' }],
    });
    await remoteChatTick();
    expect(getRemoteChat(created.id)).toMatchObject({
      state: 'preparing',
      targetEnrollmentId: 'enr-hosted',
      environmentId: created.environmentId,
    });
    const stored = db
      .prepare('SELECT record_json FROM remote_chats WHERE id = ?')
      .get(created.id) as { record_json: string };
    expect(JSON.parse(stored.record_json).prepareRequestJson).toBeTypeOf('string');
    expect(calls).toEqual([]);
    await remoteChatTick();
    expect(calls).toHaveLength(1);
  });

  it('suspends after a completed turn and automatically resumes the same environment for a follow-up', async () => {
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES ('workspace-a', 'A', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO chat_threads (id, workspace_id, persona_id, title) VALUES ('thread-a', 'workspace-a', 'codex', 'Thread A')`,
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, thread_id, kind, role, content, timestamp) VALUES ('old-user', 'thread-a', 'user', 'user', 'Earlier request', datetime('now', '-2 minutes'))`,
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, thread_id, kind, role, content, timestamp) VALUES ('old-assistant', 'thread-a', 'assistant', 'assistant', 'Earlier answer', datetime('now', '-1 minute'))`,
    ).run();
    const startInputs: Array<Record<string, unknown>> = [];
    prepareStart = async (value) => {
      startInputs.push(value as Record<string, unknown>);
      return {
        requestId: (value as { requestId: string }).requestId,
        inputManifest: {
          workspaceDefinitionRevision: 'workspace-rev-1',
          repositories: [{ repositoryId: 'repo-a', commit: 'commit-a' }],
          bootstrapDigest: 'bootstrap-a',
        },
        sealedInputs: 'start-sealed',
      };
    };
    const hostedInput = {
      workspaceId: 'workspace-a',
      target: 'anvil-hosted-cloud' as const,
      sourceThreadId: 'thread-a',
      provider: 'codex' as const,
      model: 'gpt-test',
      permissionMode: 'on-request' as const,
      prompt: 'First turn',
      requestId: 'hosted-idle-request',
    };
    submit = async (params) => ({
      id: (params as { requestId: string }).requestId.includes('remote-chat-start:')
        ? 'run-job-1'
        : 'prep-job-1',
    });
    rpcHandler = async (operation, params) => {
      if (operation !== 'job.get') return {};
      const jobId = (params as { jobId: string }).jobId;
      return jobId === 'prep-job-1'
        ? { job: { id: jobId, requestId: 'prepare', state: 'completed' }, attempts: [] }
        : {
            job: { id: jobId, requestId: 'start', state: 'completed' },
            attempts: [{ id: 'attempt-1', state: 'completed', sealedResult: 'ciphertext' }],
          };
    };
    const created = await createRemoteChat(hostedInput);
    hostedEnvironments = [
      {
        environmentId: created.environmentId!,
        provider: 'anvil-managed',
        state: 'enrolled',
        enrollmentId: 'enr-hosted',
      },
    ];
    resolveDevice = () => ({
      devices: [{ enrollmentId: 'enr-hosted', revoked: false, enrollmentClass: 'ephemeral' }],
    });
    await remoteChatTick();
    await remoteChatTick();
    await remoteChatTick();
    expect(startInputs[0]?.['prompt']).toContain('Earlier request');
    expect(startInputs[0]?.['prompt']).toContain('Earlier answer');
    await remoteChatTick();
    expect(getRemoteChat(created.id)?.state).toBe('completed');
    expect(hostedEnvironments[0]?.state).toBe('enrolled');
    const completed = db
      .prepare('SELECT record_json FROM remote_chats WHERE id = ?')
      .get(created.id) as { record_json: string };
    const record = JSON.parse(completed.record_json) as Record<string, unknown>;
    record['hostedIdleSince'] = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    db.prepare('UPDATE remote_chats SET record_json = ? WHERE id = ?').run(
      JSON.stringify(record),
      created.id,
    );
    await remoteChatTick();
    expect(getRemoteChat(created.id)?.state).toBe('paused');
    expect(hostedEnvironments[0]?.state).toBe('suspended');

    const resumed = await sendRemoteChat({
      sessionId: created.id,
      requestId: 'follow-up-1',
      prompt: 'Next turn',
    });
    expect(resumed.state).toBe('provisioning');
    expect(hostedEnvironments[0]?.state).toBe('provisioning');
    hostedEnvironments[0]!.state = 'enrolled';
    hostedEnvironments[0]!.enrollmentId = 'enr-hosted-next';
    resolveDevice = () => ({
      devices: [
        { enrollmentId: 'enr-hosted', revoked: false, enrollmentClass: 'ephemeral' },
        { enrollmentId: 'enr-hosted-next', revoked: false, enrollmentClass: 'ephemeral' },
      ],
    });
    await remoteChatTick();
    expect(getRemoteChat(created.id)).toMatchObject({
      state: 'starting',
      targetEnrollmentId: 'enr-hosted-next',
      environmentId: created.environmentId,
    });
  });

  it('suspends failed hosted turns and resumes a fresh provider session with conversation context when no handle exists', async () => {
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES ('workspace-a', 'A', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO chat_threads (id, workspace_id, persona_id, title) VALUES ('thread-a', 'workspace-a', 'codex', 'Thread A')`,
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, thread_id, kind, role, content, timestamp) VALUES ('old-user-failed', 'thread-a', 'user', 'user', 'Prior local context', datetime('now', '-2 minutes'))`,
    ).run();
    const startInputs: Array<Record<string, unknown>> = [];
    prepareStart = async (value) => {
      startInputs.push(value as Record<string, unknown>);
      return {
        requestId: (value as { requestId: string }).requestId,
        inputManifest: {
          workspaceDefinitionRevision: 'workspace-rev-1',
          repositories: [{ repositoryId: 'repo-a', commit: 'commit-a' }],
          bootstrapDigest: 'bootstrap-a',
        },
        sealedInputs: 'start-sealed',
      };
    };
    submit = async (params) => ({
      id: (params as { requestId: string }).requestId.includes('remote-chat-start:')
        ? 'run-job-failed'
        : 'prep-job-failed',
    });
    rpcHandler = async (operation, params) => {
      if (operation !== 'job.get') return {};
      const jobId = (params as { jobId: string }).jobId;
      return jobId === 'prep-job-failed'
        ? { job: { id: jobId, requestId: 'prepare', state: 'completed' }, attempts: [] }
        : {
            job: { id: jobId, requestId: 'start', state: 'failed', stateReason: 'test failure' },
            attempts: [],
          };
    };
    const created = await createRemoteChat({
      workspaceId: 'workspace-a',
      target: 'anvil-hosted-cloud',
      sourceThreadId: 'thread-a',
      provider: 'codex',
      model: 'gpt-test',
      permissionMode: 'on-request',
      prompt: 'First hosted prompt',
      requestId: 'hosted-failed-idle',
    });
    hostedEnvironments = [
      {
        environmentId: created.environmentId!,
        provider: 'anvil-managed',
        state: 'enrolled',
        enrollmentId: 'enr-hosted',
      },
    ];
    resolveDevice = () => ({
      devices: [{ enrollmentId: 'enr-hosted', revoked: false, enrollmentClass: 'ephemeral' }],
    });
    await remoteChatTick();
    await remoteChatTick();
    await remoteChatTick();
    await remoteChatTick();
    expect(getRemoteChat(created.id)?.state).toBe('failed');
    const row = db.prepare('SELECT record_json FROM remote_chats WHERE id = ?').get(created.id) as {
      record_json: string;
    };
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    record['hostedIdleSince'] = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    db.prepare('UPDATE remote_chats SET record_json = ? WHERE id = ?').run(
      JSON.stringify(record),
      created.id,
    );
    await remoteChatTick();
    expect(getRemoteChat(created.id)?.state).toBe('paused');
    expect(hostedEnvironments[0]?.state).toBe('suspended');

    await sendRemoteChat({
      sessionId: created.id,
      requestId: 'fresh-session-followup',
      prompt: 'Try again',
    });
    expect(hostedEnvironments[0]?.state).toBe('provisioning');
    hostedEnvironments[0]!.state = 'enrolled';
    hostedEnvironments[0]!.enrollmentId = 'enr-hosted-fresh';
    resolveDevice = () => ({
      devices: [{ enrollmentId: 'enr-hosted-fresh', revoked: false, enrollmentClass: 'ephemeral' }],
    });
    await remoteChatTick();
    expect(startInputs.at(-1)).toMatchObject({
      targetEnrollmentId: 'enr-hosted-fresh',
      prompt: expect.stringContaining('Prior local context'),
    });
    expect(startInputs.at(-1)).not.toHaveProperty('resumeThreadId');
  });

  it('applies the idle suspension grace to cancelled hosted chats', async () => {
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES ('workspace-a', 'A', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO chat_threads (id, workspace_id, persona_id, title) VALUES ('thread-a', 'workspace-a', 'codex', 'Thread A')`,
    ).run();
    const created = await createRemoteChat({
      workspaceId: 'workspace-a',
      target: 'anvil-hosted-cloud',
      sourceThreadId: 'thread-a',
      provider: 'codex',
      model: 'gpt-test',
      permissionMode: 'on-request',
      prompt: 'Cancel this hosted chat',
      requestId: 'hosted-cancelled-idle',
    });
    hostedEnvironments = [
      {
        environmentId: created.environmentId!,
        provider: 'anvil-managed',
        state: 'enrolled',
        enrollmentId: 'enr-hosted',
      },
    ];
    expect((await cancelRemoteChat(created.id)).state).toBe('cancelled');
    const row = db.prepare('SELECT record_json FROM remote_chats WHERE id = ?').get(created.id) as {
      record_json: string;
    };
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    expect(record['hostedIdleSince']).toBeTypeOf('string');
    record['hostedIdleSince'] = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    db.prepare('UPDATE remote_chats SET record_json = ? WHERE id = ?').run(
      JSON.stringify(record),
      created.id,
    );
    await remoteChatTick();
    expect(getRemoteChat(created.id)?.state).toBe('paused');
    expect(hostedEnvironments[0]?.state).toBe('suspended');
  });

  it('retries a failed first workspace preparation after idle suspension', async () => {
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES ('workspace-a', 'A', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO chat_threads (id, workspace_id, persona_id, title) VALUES ('thread-a', 'workspace-a', 'codex', 'Thread A')`,
    ).run();
    let prepareAttempts = 0;
    prepare = async (value) => {
      prepareAttempts += 1;
      return {
        requestId: (value as { requestId: string }).requestId,
        inputManifest: {
          workspaceDefinitionRevision: 'workspace-rev-1',
          repositories: [{ repositoryId: 'repo-a', commit: 'commit-a' }],
          bootstrapDigest: 'bootstrap-a',
        },
        sealedInputs: 'sealed',
      };
    };
    const startInputs: Array<Record<string, unknown>> = [];
    prepareStart = async (value) => {
      startInputs.push(value as Record<string, unknown>);
      return {
        requestId: (value as { requestId: string }).requestId,
        inputManifest: {},
        sealedInputs: 'start-sealed',
      };
    };
    let prepareSubmissions = 0;
    submit = async (params) => {
      const requestId = (params as { requestId: string }).requestId;
      if (requestId.includes('remote-chat-start:')) return { id: 'retry-start-job' };
      prepareSubmissions += 1;
      return { id: prepareSubmissions === 1 ? 'failed-prepare-job' : 'retry-prepare-job' };
    };
    rpcHandler = async (operation, params) => {
      if (operation !== 'job.get') return {};
      const jobId = (params as { jobId: string }).jobId;
      return jobId === 'failed-prepare-job'
        ? { job: { id: jobId, requestId: 'prepare', state: 'failed' }, attempts: [] }
        : { job: { id: jobId, requestId: 'prepare-retry', state: 'completed' }, attempts: [] };
    };
    const created = await createRemoteChat({
      workspaceId: 'workspace-a',
      target: 'anvil-hosted-cloud',
      sourceThreadId: 'thread-a',
      provider: 'codex',
      model: 'gpt-test',
      permissionMode: 'on-request',
      prompt: 'Initial prompt before preparation failed',
      requestId: 'hosted-preparation-retry',
    });
    hostedEnvironments = [
      {
        environmentId: created.environmentId!,
        provider: 'anvil-managed',
        state: 'enrolled',
        enrollmentId: 'enr-hosted',
      },
    ];
    resolveDevice = () => ({
      devices: [{ enrollmentId: 'enr-hosted', revoked: false, enrollmentClass: 'ephemeral' }],
    });
    await remoteChatTick();
    await remoteChatTick();
    await remoteChatTick();
    expect(getRemoteChat(created.id)?.state).toBe('failed');
    const row = db.prepare('SELECT record_json FROM remote_chats WHERE id = ?').get(created.id) as {
      record_json: string;
    };
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    record['hostedIdleSince'] = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    db.prepare('UPDATE remote_chats SET record_json = ? WHERE id = ?').run(
      JSON.stringify(record),
      created.id,
    );
    await remoteChatTick();
    expect(getRemoteChat(created.id)?.state).toBe('paused');

    await sendRemoteChat({
      sessionId: created.id,
      requestId: 'retry-after-preparation-failure',
      prompt: 'Retry after bootstrap',
    });
    hostedEnvironments[0]!.state = 'enrolled';
    hostedEnvironments[0]!.enrollmentId = 'enr-hosted-fresh';
    resolveDevice = () => ({
      devices: [{ enrollmentId: 'enr-hosted-fresh', revoked: false, enrollmentClass: 'ephemeral' }],
    });
    await remoteChatTick();
    await remoteChatTick();
    await remoteChatTick();
    expect(prepareAttempts).toBe(2);
    expect(startInputs.at(-1)).toMatchObject({
      targetEnrollmentId: 'enr-hosted-fresh',
      prompt: expect.stringContaining('Initial prompt before preparation failed'),
      manifestPin: {
        repositories: [{ repositoryId: 'repo-a', commit: 'commit-a' }],
      },
    });
    expect(startInputs.at(-1)).not.toHaveProperty('resumeThreadId');
  });

  it('reconciles a hosted turn completed while the desktop was offline and its worker was suspended', async () => {
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, created_at, updated_at) VALUES ('workspace-a', 'A', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO chat_threads (id, workspace_id, persona_id, title) VALUES ('thread-a', 'workspace-a', 'codex', 'Thread A')`,
    ).run();
    const created = await createRemoteChat({
      workspaceId: 'workspace-a',
      target: 'anvil-hosted-cloud',
      sourceThreadId: 'thread-a',
      provider: 'codex',
      model: 'gpt-test',
      permissionMode: 'on-request',
      prompt: 'Finish while desktop is offline',
      requestId: 'hosted-offline-completion',
    });
    const record = db
      .prepare('SELECT record_json FROM remote_chats WHERE id = ?')
      .get(created.id) as { record_json: string };
    const stored = JSON.parse(record.record_json) as Record<string, unknown> & {
      turns: Array<Record<string, unknown>>;
    };
    stored.targetEnrollmentId = 'enr-hosted-old';
    stored.state = 'running';
    stored.activeTurnId = stored.turns[0]?.['id'];
    stored.jobId = 'completed-offline-job';
    stored.turns[0]!.jobId = 'completed-offline-job';
    stored.turns[0]!.requestJson = JSON.stringify({
      requestId: 'remote-chat-start:offline',
      inputManifest: {
        workspaceDefinitionRevision: 'workspace-rev-1',
        repositories: [{ repositoryId: 'repo-a', commit: 'commit-a' }],
        bootstrapDigest: 'bootstrap-a',
      },
      sealedInputs: 'sealed',
    });
    db.prepare('UPDATE remote_chats SET record_json = ?, state = ? WHERE id = ?').run(
      JSON.stringify(stored),
      'running',
      created.id,
    );
    hostedEnvironments = [
      {
        environmentId: created.environmentId!,
        provider: 'anvil-managed',
        state: 'suspended',
      },
    ];
    rpcHandler = async (operation, params) => {
      if (operation !== 'job.get') return {};
      return {
        job: {
          id: (params as { jobId: string }).jobId,
          requestId: 'remote-chat-start:offline',
          state: 'completed',
        },
        attempts: [{ id: 'attempt-offline', state: 'completed', sealedResult: 'ciphertext' }],
      };
    };
    openedTaskResult = {
      assistantOutput: 'Completed while the desktop was closed.',
      resumeHandle: 'provider-thread-offline',
    };

    await remoteChatTick();
    expect(getRemoteChat(created.id)).toMatchObject({
      state: 'paused',
      turns: [{ state: 'completed', response: 'Completed while the desktop was closed.' }],
    });
  });

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

    const created = await createRemoteChat({ ...input, reasoningEffort: 'high' });
    await remoteChatTick();
    expect(getRemoteChat(created.id)?.state).toBe('preparing');
    expect(startSubmissions).toBe(0);

    preparationState = 'completed';
    await remoteChatTick();
    expect(startSubmissions).toBe(1);
    expect(startInputs[0]).toMatchObject({
      reasoningEffort: 'high',
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
      sendRemoteChat({
        sessionId: created.id,
        requestId: 'follow-request',
        prompt: 'Continue',
        permissionMode: 'workspace-auto',
        reasoningEffort: 'ultra',
      }),
    );
    expect(followed.state).toBe('starting');
    expect(followupInput[0]).toMatchObject({
      targetEnrollmentId: 'enr-target',
      permissionMode: 'workspace-auto',
      reasoningEffort: 'ultra',
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
