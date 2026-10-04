import { createHash, randomUUID } from 'node:crypto';
import { isCloudAgentProviderEnabled } from './cloud-agent-settings.service.js';
import {
  assertAnvilCloudAgentsEnabled,
  isAnvilCloudAgentsEnabled,
} from './anvil-cloud-agents-availability.service.js';

import type { AgentProvider } from '../../shared/types.js';
import type {
  CreateRemoteChatInput,
  RemoteChatRecord,
  RemoteChatState,
  RemoteChatTurn,
  SendRemoteChatInput,
} from '../../shared/remote-chat.js';
import type { PermissionMode } from '../../../cloud/contract/permissions.js';
import type { JobCreateParams, JobGetResult, JobSummary } from '../../../cloud/contract/jobs.js';
import type { SessionCheckpoint } from '../../../cloud/contract/handoff.js';
import type { DeviceListResult } from '../../../cloud/contract/auth.js';
import type { CloudEnvironment } from '../../../cloud/contract/environment.js';
import type { SyncScope } from '../../shared/sync-mesh.js';
import type { RemoteCredentialChoice } from '../../shared/remote-chat.js';
import { getDb } from '../db/database.js';
import { rpc } from './sync-backend-client.service.js';
import {
  preparePrepareWorkspaceJob,
  prepareStartSessionJob,
  submitPreparedJob,
} from './mesh-worker.service.js';
import {
  deviceTrustState,
  taskKeyFor,
  unsealTaskInputs,
  unsealTaskResult,
} from './sync-keyring.service.js';
import {
  ensureRemoteCredentialGrant,
  validateRemoteCredentialChoice,
  validateRemoteCredentialAvailability,
} from './remote-credentials.service.js';

interface RemoteChatContext {
  apiUrl: string;
  accessToken: string;
  enrollmentId: string;
  scope?: SyncScope;
  requestHostedEnvironment?: (input: {
    environmentId: string;
    displayName: string;
    purpose: 'remote-chat';
  }) => Promise<{ job: JobSummary }>;
  listHostedEnvironments?: () => Promise<{ environments: CloudEnvironment[] }>;
  reapHostedEnvironment?: (environmentId: string) => Promise<unknown>;
  suspendHostedEnvironment?: (environmentId: string) => Promise<CloudEnvironment>;
  resumeHostedEnvironment?: (environmentId: string) => Promise<CloudEnvironment>;
}

interface StoredTurn extends RemoteChatTurn {
  requestId: string;
  permissionMode?: PermissionMode;
  reasoningEffort?: RemoteChatRecord['reasoningEffort'];
  /** Exact sealed job.create params are replayed after a crash/lost response. */
  requestJson?: string;
  /** Provider-native handle remains main-process data. */
  resumeHandle?: string;
  credentialMarker?: string;
  /** Existing local thread history supplied only on the first remote turn. */
  providerPrompt?: string;
}

interface StoredChat extends RemoteChatRecord {
  createRequestId: string;
  createPayloadHash: string;
  backendId: string;
  accountId: string;
  scopeEpoch: string;
  turns: StoredTurn[];
  prepareRequestJson?: string;
  prepareJobId?: string;
  activeTurnId?: string;
  cancelRequested?: boolean;
  /** Launch policy applies to managed cloud targets, separately from desktop auth choices. */
  cloudTarget?: boolean;
  cloudProvisionJobId?: string;
  hostedResumePending?: boolean;
  hostedPreviousEnrollmentId?: string;
  hostedResumeManifest?: {
    workspaceDefinitionRevision: string;
    repositories: Array<{ repositoryId: string; commit: string }>;
    bootstrapDigest: string;
  };
  hostedRetryManifestPin?: {
    workspaceDefinitionRevision: string;
    repositories: Array<{ repositoryId: string; commit: string }>;
    bootstrapDigest: string;
  };
  hostedPrepareRequestId?: string;
  hostedIdleSince?: string;
}

interface RemoteChatRow {
  id: string;
  create_request_id: string;
  backend_id: string;
  account_id: string;
  scope_epoch: string;
  workspace_id: string;
  target_enrollment_id: string;
  provider: AgentProvider;
  model: string;
  permission_mode: PermissionMode;
  source_session_id: string | null;
  handoff_id: string | null;
  state: RemoteChatState;
  record_json: string;
  created_at: string;
  updated_at: string;
}

const HOSTED_IDLE_GRACE_MS = 5 * 60 * 1000;
const SOURCE_THREAD_CONTEXT_CHARS = 30_000;
const SOURCE_THREAD_CONTEXT_TURNS = 40;

let contextProvider: (() => RemoteChatContext | null) | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight: Promise<void> | null = null;

export function configureRemoteChatContext(provider: () => RemoteChatContext | null): void {
  contextProvider = provider;
}

function context(): RemoteChatContext {
  const current = contextProvider?.() ?? null;
  if (current === null) throw new Error('remote chat requires an enrolled sync connection');
  if (current.scope === undefined) throw new Error('remote chat requires a sync scope');
  return current;
}

function assertScope(
  expected: Pick<StoredChat, 'backendId' | 'accountId' | 'scopeEpoch'>,
): RemoteChatContext {
  const current = context();
  if (
    current.scope!.backendId !== expected.backendId ||
    current.scope!.accountId !== expected.accountId ||
    current.scope!.datasetEpoch !== expected.scopeEpoch
  )
    throw new Error('The sync account changed during this remote chat operation.');
  return current;
}

function readStored(id: string): StoredChat | null {
  const row = getDb().prepare('SELECT record_json FROM remote_chats WHERE id = ?').get(id) as
    | { record_json: string }
    | undefined;
  if (row === undefined) return null;
  const current = contextProvider?.() ?? null;
  if (current?.scope === undefined) return null;
  const record = JSON.parse(row.record_json) as StoredChat;
  if (
    record.backendId !== current.scope.backendId ||
    record.accountId !== current.scope.accountId ||
    record.scopeEpoch !== current.scope.datasetEpoch
  )
    return null;
  return record;
}

function save(record: StoredChat): void {
  assertScope(record);
  const priorRow = getDb()
    .prepare('SELECT record_json FROM remote_chats WHERE id = ?')
    .get(record.id) as { record_json: string } | undefined;
  if (priorRow !== undefined) {
    const prior = JSON.parse(priorRow.record_json) as StoredChat;
    // A poll started for an older turn may finish after a follow-up has
    // advanced activeTurnId. Do not let that stale snapshot roll the
    // conversation back to a turn already present in the durable row.
    if (
      prior.activeTurnId !== record.activeTurnId &&
      prior.turns.some((turn) => turn.id === record.activeTurnId)
    )
      return;
    if (
      prior.cancelRequested &&
      prior.activeTurnId === record.activeTurnId &&
      !['completed', 'failed', 'cancelled', 'checkpointing', 'paused', 'ended'].includes(
        record.state,
      )
    ) {
      record.cancelRequested = true;
      record.prepareJobId ??= prior.prepareJobId;
      record.jobId ??= prior.jobId;
      const active = record.turns.find((turn) => turn.id === record.activeTurnId);
      const priorActive = prior.turns.find((turn) => turn.id === prior.activeTurnId);
      if (active !== undefined && priorActive !== undefined && active.id === priorActive.id) {
        active.jobId ??= priorActive.jobId;
        active.credentialMarker ??= priorActive.credentialMarker;
      }
      if (!['completed', 'failed', 'cancelled'].includes(record.state))
        record.state = 'cancel-requested';
    }
  }
  const now = new Date().toISOString();
  record.updatedAt = now;
  getDb()
    .prepare(
      `INSERT INTO remote_chats
       (id, create_request_id, backend_id, account_id, scope_epoch, workspace_id,
        target_enrollment_id, provider, model, permission_mode,
        source_session_id, handoff_id, state, record_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET target_enrollment_id=excluded.target_enrollment_id,
        state=excluded.state, record_json=excluded.record_json,
        updated_at=excluded.updated_at`,
    )
    .run(
      record.id,
      record.createRequestId,
      record.backendId,
      record.accountId,
      record.scopeEpoch,
      record.workspaceId,
      record.targetEnrollmentId,
      record.provider,
      record.model,
      record.permissionMode,
      record.sourceSessionId ?? null,
      record.handoffId ?? null,
      record.state,
      JSON.stringify(record),
      record.createdAt,
      now,
    );
}

function publicRecord(record: StoredChat): RemoteChatRecord {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    targetEnrollmentId: record.targetEnrollmentId,
    ...(record.target === undefined ? {} : { target: record.target }),
    ...(record.sourceThreadId === undefined ? {} : { sourceThreadId: record.sourceThreadId }),
    ...(record.environmentId === undefined ? {} : { environmentId: record.environmentId }),
    provider: record.provider,
    model: record.model,
    ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort }),
    permissionMode: record.permissionMode,
    ...(record.credentialChoice === undefined ? {} : { credentialChoice: record.credentialChoice }),
    ...(record.sourceSessionId === undefined ? {} : { sourceSessionId: record.sourceSessionId }),
    ...(record.handoffId === undefined ? {} : { handoffId: record.handoffId }),
    state: record.state,
    turns: record.turns.map(({ id, prompt, state, response, jobId, error, createdAt }) => ({
      id,
      prompt,
      state,
      ...(response === undefined ? {} : { response }),
      ...(jobId === undefined ? {} : { jobId }),
      ...(error === undefined ? {} : { error }),
      createdAt,
    })),
    ...(record.prepareJobId === undefined ? {} : { prepareJobId: record.prepareJobId }),
    ...(record.jobId === undefined ? {} : { jobId: record.jobId }),
    ...(record.error === undefined ? {} : { error: record.error }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function providerPromptForSourceThread(sourceThreadId: string | undefined, prompt: string): string {
  if (sourceThreadId === undefined) return prompt;
  const messages = getDb()
    .prepare(
      `SELECT role, content FROM chat_messages
       WHERE thread_id = ? AND kind IN ('user', 'assistant')
       ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
    )
    .all(sourceThreadId, SOURCE_THREAD_CONTEXT_TURNS) as Array<{ role: string; content: string }>;
  const transcript = messages
    .reverse()
    .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
    .join('\n\n')
    .slice(-SOURCE_THREAD_CONTEXT_CHARS);
  if (transcript.trim() === '') return prompt;
  return [
    'Continue the existing Anvil chat using this recent conversation for context. The transcript is background; follow the newest user message below.',
    '<recent_conversation>',
    transcript,
    '</recent_conversation>',
    'Newest user message:',
    prompt,
  ].join('\n\n');
}

function providerPromptForRemoteHistory(chat: StoredChat, prompt: string): string {
  const transcript = chat.turns
    .flatMap((turn) => [
      `User: ${turn.prompt}`,
      ...(turn.response === undefined ? [] : [`Assistant: ${turn.response}`]),
    ])
    .join('\n\n')
    .slice(-SOURCE_THREAD_CONTEXT_CHARS);
  const sourceContext = chat.turns[0]?.providerPrompt;
  const context = [
    sourceContext && sourceContext !== chat.turns[0]?.prompt ? sourceContext : undefined,
    transcript,
  ]
    .filter((value): value is string => value !== undefined && value.trim() !== '')
    .join('\n\n');
  return context === ''
    ? prompt
    : [
        'Continue the existing Anvil chat using this recent conversation for context. The transcript is background; follow the newest user message below.',
        '<recent_conversation>',
        context,
        '</recent_conversation>',
        'Newest user message:',
        prompt,
      ].join('\n\n');
}

function latestHostedTurnWithRequest(chat: StoredChat): StoredTurn | undefined {
  return [...chat.turns].reverse().find((turn) => turn.requestJson !== undefined);
}

function latestHostedResumeHandle(chat: StoredChat): string | undefined {
  return [...chat.turns].reverse().find((turn) => turn.resumeHandle !== undefined)?.resumeHandle;
}

async function hostedTargetMatches(chat: StoredChat): Promise<boolean> {
  if (chat.target !== 'anvil-hosted-cloud' || chat.environmentId === undefined) return false;
  const list = context().listHostedEnvironments;
  if (list === undefined) return false;
  const { environments } = await list();
  const environment = environments.find((entry) => entry.environmentId === chat.environmentId);
  return (
    environment?.provider === 'anvil-managed' &&
    (environment.state === 'enrolled' || environment.state === 'running') &&
    environment.enrollmentId === chat.targetEnrollmentId
  );
}

function rows(workspaceId?: string): RemoteChatRow[] {
  const scope = contextProvider?.()?.scope;
  if (scope === undefined) return [];
  return (
    workspaceId === undefined
      ? getDb()
          .prepare(
            'SELECT * FROM remote_chats WHERE backend_id = ? AND account_id = ? AND scope_epoch = ? ORDER BY updated_at DESC',
          )
          .all(scope.backendId, scope.accountId, scope.datasetEpoch)
      : getDb()
          .prepare(
            'SELECT * FROM remote_chats WHERE backend_id = ? AND account_id = ? AND scope_epoch = ? AND workspace_id = ? ORDER BY updated_at DESC',
          )
          .all(scope.backendId, scope.accountId, scope.datasetEpoch, workspaceId)
  ) as RemoteChatRow[];
}

export function listRemoteChats(workspaceId?: string): RemoteChatRecord[] {
  return rows(workspaceId).map((row) => publicRecord(JSON.parse(row.record_json) as StoredChat));
}

export function getRemoteChat(id: string): RemoteChatRecord | null {
  const record = readStored(id);
  return record === null ? null : publicRecord(record);
}

export function adoptHandoffRemoteChat(input: {
  handoffId: string;
  sourceSessionId: string;
  workspaceId: string;
  targetEnrollmentId: string;
  provider: AgentProvider;
  model: string;
  permissionMode: PermissionMode;
  prepareJobId: string;
  activationJobId: string;
  activationRequestJson: string;
  credentialChoice?: RemoteCredentialChoice;
}): RemoteChatRecord {
  const ctx = context();
  const duplicate = getDb()
    .prepare(
      'SELECT id FROM remote_chats WHERE handoff_id = ? AND backend_id = ? AND account_id = ? AND scope_epoch = ?',
    )
    .get(input.handoffId, ctx.scope!.backendId, ctx.scope!.accountId, ctx.scope!.datasetEpoch) as
    | { id: string }
    | undefined;
  if (duplicate !== undefined) {
    const existing = readStored(duplicate.id);
    if (existing === null)
      throw new Error('handoff remote chat is bound to a different sync scope');
    return publicRecord(existing);
  }
  const params = JSON.parse(input.activationRequestJson) as JobCreateParams;
  const requestId = params.requestId;
  const turnId = randomUUID();
  const now = new Date().toISOString();
  const record: StoredChat = {
    id: randomUUID(),
    createRequestId: `handoff:${input.handoffId}`,
    createPayloadHash: createHash('sha256').update(input.activationRequestJson).digest('hex'),
    backendId: ctx.scope!.backendId,
    accountId: ctx.scope!.accountId,
    scopeEpoch: ctx.scope!.datasetEpoch,
    workspaceId: input.workspaceId,
    targetEnrollmentId: input.targetEnrollmentId,
    provider: input.provider,
    model: input.model,
    permissionMode: input.permissionMode,
    ...(input.credentialChoice === undefined ? {} : { credentialChoice: input.credentialChoice }),
    cloudTarget: input.credentialChoice !== undefined && input.credentialChoice !== 'target-local',
    sourceSessionId: input.sourceSessionId,
    handoffId: input.handoffId,
    state: 'starting',
    turns: [
      {
        id: turnId,
        requestId,
        prompt: 'Continue the handed-off session using its checkpoint context.',
        state: 'running',
        jobId: input.activationJobId,
        createdAt: now,
        requestJson: input.activationRequestJson,
      },
    ],
    prepareJobId: input.prepareJobId,
    jobId: input.activationJobId,
    activeTurnId: turnId,
    createdAt: now,
    updatedAt: now,
  };
  save(record);
  return publicRecord(record);
}

async function jobRpc<T>(
  operation: string,
  params: unknown,
  expected?: Pick<StoredChat, 'backendId' | 'accountId' | 'scopeEpoch'>,
): Promise<T> {
  const ctx = expected === undefined ? context() : assertScope(expected);
  return (await rpc<T>({ apiUrl: ctx.apiUrl }, operation, params, ctx.accessToken)).result;
}

async function submitExactRequest(
  json: string,
  expected: Pick<StoredChat, 'backendId' | 'accountId' | 'scopeEpoch'> &
    Partial<Pick<StoredChat, 'target' | 'cancelRequested'>>,
): Promise<JobSummary> {
  assertScope(expected);
  if (expected.target === 'anvil-hosted-cloud' && expected.cancelRequested !== true) {
    assertAnvilCloudAgentsEnabled();
  }
  return submitPreparedJob(JSON.parse(json) as JobCreateParams);
}

export async function createRemoteChat(input: CreateRemoteChatInput): Promise<RemoteChatRecord> {
  const ctx = context();
  if (input.target === 'anvil-hosted-cloud') {
    assertAnvilCloudAgentsEnabled();
    return createHostedRemoteChat(input, ctx);
  }
  if (input.target !== undefined && input.target !== 'device')
    throw new Error('Unsupported remote chat target.');
  const targetEnrollmentId = input.targetEnrollmentId;
  if (!targetEnrollmentId) throw new Error('Choose an active destination device.');
  if (input.sourceThreadId !== undefined)
    assertSourceThreadWorkspace(input.sourceThreadId, input.workspaceId);
  if (
    (input.provider === 'cursor' || input.provider === 'devin') &&
    input.permissionMode === 'read-only'
  ) {
    throw new Error(`${input.provider} does not support read-only remote sessions yet.`);
  }
  const deviceList = await jobRpc<DeviceListResult>(
    'device.list',
    {},
    {
      backendId: ctx.scope!.backendId,
      accountId: ctx.scope!.accountId,
      scopeEpoch: ctx.scope!.datasetEpoch,
    },
  );
  const targetDevice = deviceList.devices.find(
    (device) => device.enrollmentId === targetEnrollmentId,
  );
  if (targetDevice === undefined || targetDevice.revoked)
    throw new Error('Choose an active destination device.');
  if (deviceTrustState(ctx.scope!, targetEnrollmentId) !== 'trusted')
    throw new Error('Remote chats can only run on a trusted destination device.');
  const cloudTarget = targetDevice.enrollmentClass === 'ephemeral';
  if (cloudTarget && !isCloudAgentProviderEnabled(input.provider)) {
    throw new Error('Enable this provider in Cloud agent settings before launching it.');
  }
  input = {
    ...input,
    credentialChoice:
      input.credentialChoice ??
      (cloudTarget
        ? input.provider === 'codex'
          ? 'codex-host-auth'
          : 'cloud-provider'
        : 'target-local'),
  };
  if (input.provider === 'codex' || input.credentialChoice !== 'target-local') {
    validateRemoteCredentialChoice(
      input.provider,
      targetEnrollmentId,
      ctx.scope!,
      input.credentialChoice,
    );
    validateRemoteCredentialAvailability(input.credentialChoice!, input.provider);
  }
  if (cloudTarget && input.credentialChoice === 'target-local') {
    throw new Error('Connect this provider in Cloud agent settings before launching it.');
  }
  const requestId = input.requestId ?? randomUUID();
  const duplicate = getDb()
    .prepare(
      'SELECT id FROM remote_chats WHERE create_request_id = ? AND backend_id = ? AND account_id = ? AND scope_epoch = ?',
    )
    .get(requestId, ctx.scope!.backendId, ctx.scope!.accountId, ctx.scope!.datasetEpoch) as
    | { id: string }
    | undefined;
  if (duplicate !== undefined) {
    const existing = readStored(duplicate.id);
    if (existing === null) throw new Error('remote chat request conflicts with another sync scope');
    if (existing.createPayloadHash !== createPayloadHash(input))
      throw new Error('remote chat request id was reused with different parameters');
    await remoteChatTick();
    return publicRecord(readStored(duplicate.id) ?? existing);
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const turnId = randomUUID();
  let chat: StoredChat = {
    id,
    createRequestId: requestId,
    createPayloadHash: createPayloadHash(input),
    backendId: ctx.scope!.backendId,
    accountId: ctx.scope!.accountId,
    scopeEpoch: ctx.scope!.datasetEpoch,
    workspaceId: input.workspaceId,
    targetEnrollmentId,
    ...(input.sourceThreadId === undefined ? {} : { sourceThreadId: input.sourceThreadId }),
    provider: input.provider,
    model: input.model,
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    permissionMode: input.permissionMode,
    ...(input.credentialChoice === undefined ? {} : { credentialChoice: input.credentialChoice }),
    cloudTarget,
    state: 'preparing',
    turns: [
      {
        id: turnId,
        requestId: `remote-chat-start:${id}:${turnId}`,
        prompt: input.prompt,
        permissionMode: input.permissionMode,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        providerPrompt: providerPromptForSourceThread(input.sourceThreadId, input.prompt),
        state: 'queued',
        createdAt: now,
      },
    ],
    activeTurnId: turnId,
    createdAt: now,
    updatedAt: now,
  };
  save(chat);

  const preparationRequestId = `remote-chat-prepare:${requestId}`;
  try {
    const params = await preparePrepareWorkspaceJob({
      requestId: preparationRequestId,
      workspaceId: input.workspaceId,
      targetEnrollmentId: input.targetEnrollmentId,
      permissionMode: input.permissionMode,
      provider: input.provider,
      model: input.model,
    });
    chat.prepareRequestJson = JSON.stringify(params);
    // The exact request and controller state are durable before job.create.
    chat = readStored(chat.id) ?? chat;
    if (chat.cancelRequested) return publicRecord(chat);
    chat.prepareRequestJson = JSON.stringify(params);
    chat.error = undefined;
    save(chat);
    try {
      const job = await submitExactRequest(chat.prepareRequestJson, chat);
      const latest = readStored(chat.id) ?? chat;
      latest.prepareJobId = job.id;
      save(latest);
      if (latest.cancelRequested) return await cancelRemoteChat(latest.id);
      chat = latest;
    } catch (error) {
      // Leave the same request replayable; a lost response must never mint
      // another remote preparation or turn.
      const latest = readStored(chat.id) ?? chat;
      if (!latest.cancelRequested)
        latest.error = error instanceof Error ? error.message : String(error);
      save(latest);
      chat = latest;
    }
  } catch (error) {
    const latest = readStored(chat.id) ?? chat;
    if (!latest.cancelRequested) {
      latest.state = 'failed';
      latest.error = error instanceof Error ? error.message : String(error);
    }
    save(latest);
    chat = latest;
  }
  return publicRecord(chat);
}

/**
 * Hosted allocation is a durable first phase of the remote chat. The record
 * is saved before requesting capacity, and the stable environment id makes
 * retries safe if the desktop exits after the backend accepts the request.
 */
async function createHostedRemoteChat(
  input: CreateRemoteChatInput,
  ctx: RemoteChatContext,
): Promise<RemoteChatRecord> {
  if (input.sourceThreadId === undefined || input.sourceThreadId.trim() === '')
    throw new Error('Hosted cloud chats must be linked to a source chat thread.');
  assertSourceThreadWorkspace(input.sourceThreadId, input.workspaceId);
  if (input.provider === 'cursor' || input.provider === 'devin') {
    if (input.permissionMode === 'read-only')
      throw new Error(`${input.provider} does not support read-only remote sessions yet.`);
  }
  if (!isCloudAgentProviderEnabled(input.provider))
    throw new Error('Enable this provider in Cloud agent settings before launching it.');
  const choice =
    input.credentialChoice ?? (input.provider === 'codex' ? 'codex-host-auth' : 'cloud-provider');
  if (choice === 'target-local')
    throw new Error('Hosted cloud chats need a source or cloud-managed credential choice.');
  validateRemoteCredentialAvailability(choice, input.provider);
  const requestId = input.requestId ?? randomUUID();
  const normalized = {
    ...input,
    target: 'anvil-hosted-cloud' as const,
    requestId,
    credentialChoice: choice,
  };
  const duplicate = getDb()
    .prepare(
      'SELECT id FROM remote_chats WHERE create_request_id = ? AND backend_id = ? AND account_id = ? AND scope_epoch = ?',
    )
    .get(requestId, ctx.scope!.backendId, ctx.scope!.accountId, ctx.scope!.datasetEpoch) as
    | { id: string }
    | undefined;
  if (duplicate !== undefined) {
    const existing = readStored(duplicate.id);
    if (existing === null) throw new Error('remote chat request conflicts with another sync scope');
    if (existing.createPayloadHash !== createPayloadHash(normalized))
      throw new Error('remote chat request id was reused with different parameters');
    await remoteChatTick();
    return publicRecord(readStored(duplicate.id) ?? existing);
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const environmentId = `remote-${id}`;
  const turnId = randomUUID();
  const chat: StoredChat = {
    id,
    createRequestId: requestId,
    createPayloadHash: createPayloadHash(normalized),
    backendId: ctx.scope!.backendId,
    accountId: ctx.scope!.accountId,
    scopeEpoch: ctx.scope!.datasetEpoch,
    workspaceId: input.workspaceId,
    targetEnrollmentId: `pending:${environmentId}`,
    target: 'anvil-hosted-cloud',
    sourceThreadId: input.sourceThreadId,
    environmentId,
    provider: input.provider,
    model: input.model,
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    permissionMode: input.permissionMode,
    credentialChoice: choice,
    cloudTarget: true,
    state: 'provisioning',
    turns: [
      {
        id: turnId,
        requestId: `remote-chat-start:${id}:${turnId}`,
        prompt: input.prompt,
        permissionMode: input.permissionMode,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        providerPrompt: providerPromptForSourceThread(input.sourceThreadId, input.prompt),
        state: 'queued',
        createdAt: now,
      },
    ],
    activeTurnId: turnId,
    createdAt: now,
    updatedAt: now,
  };
  save(chat);
  await requestProvisioning(chat);
  return publicRecord(readStored(id) ?? chat);
}

function assertSourceThreadWorkspace(sourceThreadId: string, workspaceId: string): void {
  const row = getDb()
    .prepare('SELECT workspace_id, title FROM chat_threads WHERE id = ?')
    .get(sourceThreadId) as { workspace_id: string } | undefined;
  if (row === undefined || row.workspace_id !== workspaceId)
    throw new Error('The source chat thread does not belong to this workspace.');
}

async function requestProvisioning(chat: StoredChat): Promise<void> {
  if (chat.target === 'anvil-hosted-cloud') assertAnvilCloudAgentsEnabled();
  if (chat.environmentId === undefined)
    throw new Error('Hosted remote chat lost its environment id.');
  const callback = context().requestHostedEnvironment;
  if (callback === undefined) throw new Error('Hosted cloud provisioning is unavailable.');
  const result = await callback({
    environmentId: chat.environmentId,
    displayName: `Chat ${chat.sourceThreadId ?? chat.id}`,
    purpose: 'remote-chat',
  });
  const latest = readStored(chat.id);
  if (latest === null) return;
  latest.cloudProvisionJobId = result.job.id;
  latest.error = undefined;
  latest.state = 'provisioning';
  save(latest);
}

export async function sendRemoteChat(input: SendRemoteChatInput): Promise<RemoteChatRecord> {
  context();
  const chat = readStored(input.sessionId);
  if (chat === null) throw new Error(`remote chat not found: ${input.sessionId}`);
  if (chat.target === 'anvil-hosted-cloud') assertAnvilCloudAgentsEnabled();
  const duplicate = chat.turns.find((turn) => turn.requestId === input.requestId);
  if (duplicate !== undefined) {
    if (
      duplicate.prompt !== input.prompt ||
      (input.permissionMode !== undefined && duplicate.permissionMode !== input.permissionMode) ||
      (input.reasoningEffort !== undefined && duplicate.reasoningEffort !== input.reasoningEffort)
    )
      throw new Error('remote chat turn request id was reused with a different prompt');
    await remoteChatTick();
    return publicRecord(readStored(input.sessionId) ?? chat);
  }
  if (chat.cloudTarget && !isCloudAgentProviderEnabled(chat.provider))
    throw new Error('Enable this provider in Cloud agent settings before continuing it.');
  if (chat.credentialChoice === 'cloud-provider')
    validateRemoteCredentialAvailability(chat.credentialChoice, chat.provider);
  const nextPermissionMode = input.permissionMode ?? chat.permissionMode;
  const nextReasoningEffort = input.reasoningEffort ?? chat.reasoningEffort;
  const retryHandoffFromCheckpoint = chat.state === 'failed' && chat.handoffId !== undefined;
  if (
    chat.target === 'anvil-hosted-cloud' &&
    (chat.state === 'paused' || chat.state === 'checkpointing')
  ) {
    const previous = latestHostedTurnWithRequest(chat);
    const previousParams =
      previous?.requestJson === undefined
        ? undefined
        : (JSON.parse(previous.requestJson) as JobCreateParams);
    const prepareParams =
      previousParams === undefined && chat.prepareRequestJson !== undefined
        ? (JSON.parse(chat.prepareRequestJson) as JobCreateParams)
        : undefined;
    const resumeManifest =
      previousParams?.inputManifest ?? prepareParams?.inputManifest ?? chat.hostedResumeManifest;
    const resumeHandle = latestHostedResumeHandle(chat);
    const current = readStored(chat.id);
    if (current === null) throw new Error(`remote chat not found: ${chat.id}`);
    const existingTurn = current.turns.find((turn) => turn.requestId === input.requestId);
    if (existingTurn !== undefined) {
      if (
        existingTurn.prompt !== input.prompt ||
        (input.permissionMode !== undefined &&
          existingTurn.permissionMode !== input.permissionMode) ||
        (input.reasoningEffort !== undefined &&
          existingTurn.reasoningEffort !== input.reasoningEffort)
      )
        throw new Error('remote chat turn request id was reused with a different prompt');
      return publicRecord(current);
    }
    if (current.state !== 'paused' && current.state !== 'checkpointing')
      throw new Error(`remote chat is not ready for a follow-up (${current.state})`);
    const turn: StoredTurn = {
      id: randomUUID(),
      requestId: input.requestId,
      prompt: input.prompt,
      ...(resumeHandle === undefined
        ? { providerPrompt: providerPromptForRemoteHistory(chat, input.prompt) }
        : {}),
      permissionMode: nextPermissionMode,
      ...(nextReasoningEffort === undefined ? {} : { reasoningEffort: nextReasoningEffort }),
      state: 'queued',
      createdAt: new Date().toISOString(),
      ...(resumeHandle === undefined ? {} : { resumeHandle }),
    };
    current.turns.push(turn);
    current.activeTurnId = turn.id;
    current.permissionMode = nextPermissionMode;
    current.reasoningEffort = nextReasoningEffort;
    current.cancelRequested = false;
    current.jobId = undefined;
    current.hostedResumePending = true;
    current.hostedPreviousEnrollmentId = current.targetEnrollmentId;
    if (previousParams !== undefined) {
      current.hostedResumeManifest = {
        workspaceDefinitionRevision: previousParams.inputManifest.workspaceDefinitionRevision,
        repositories: previousParams.inputManifest.repositories,
        bootstrapDigest: previousParams.inputManifest.bootstrapDigest,
      };
      current.hostedRetryManifestPin = undefined;
      current.hostedPrepareRequestId = undefined;
    } else {
      current.hostedResumeManifest = undefined;
      current.hostedRetryManifestPin =
        resumeManifest === undefined
          ? undefined
          : {
              workspaceDefinitionRevision: resumeManifest.workspaceDefinitionRevision,
              repositories: resumeManifest.repositories,
              bootstrapDigest: resumeManifest.bootstrapDigest,
            };
      current.hostedPrepareRequestId = `remote-chat-prepare:${current.id}:${turn.id}`;
      current.prepareJobId = undefined;
      current.prepareRequestJson = undefined;
    }
    current.state = 'provisioning';
    current.error = undefined;
    save(current);
    await remoteChatTick();
    return publicRecord(readStored(current.id) ?? current);
  }
  const hostedFinalTurn =
    chat.target === 'anvil-hosted-cloud' && ['failed', 'cancelled'].includes(chat.state);
  if (chat.state !== 'completed' && !retryHandoffFromCheckpoint && !hostedFinalTurn)
    throw new Error(`remote chat is not ready for a follow-up (${chat.state})`);
  const previous = chat.turns.at(-1);
  if (previous === undefined) throw new Error('remote chat has no previous turn to continue');
  const manifestTurn =
    chat.target === 'anvil-hosted-cloud' ? latestHostedTurnWithRequest(chat) : previous;
  const resumeHandle =
    chat.target === 'anvil-hosted-cloud' ? latestHostedResumeHandle(chat) : previous.resumeHandle;
  if (!retryHandoffFromCheckpoint && resumeHandle === undefined && !hostedFinalTurn) {
    throw new Error('The remote provider session cannot be resumed on this target.');
  }
  if (manifestTurn?.requestJson === undefined)
    throw new Error('The original remote checkout pins are unavailable.');
  const previousParams = JSON.parse(manifestTurn.requestJson) as JobCreateParams;
  let handoffCheckpoint: SessionCheckpoint | undefined;
  if (retryHandoffFromCheckpoint && chat.handoffId !== undefined) {
    const ctx = context();
    if (ctx.scope === undefined)
      throw new Error('The handoff checkpoint is unavailable for this sync scope.');
    const taskKey = taskKeyFor(ctx.scope, `req:${previousParams.requestId}`);
    if (taskKey === null)
      throw new Error('The handoff checkpoint key is unavailable on this device.');
    const privateInputs = unsealTaskInputs(
      ctx.scope,
      previousParams.requestId,
      taskKey,
      previousParams.sealedInputs,
    );
    const checkpoint = privateInputs['handoffCheckpoint'];
    if (checkpoint === undefined || checkpoint === null || typeof checkpoint !== 'object')
      throw new Error('The original handoff checkpoint is unavailable.');
    handoffCheckpoint = checkpoint as SessionCheckpoint;
  }
  const manifestPin = {
    workspaceDefinitionRevision: previousParams.inputManifest.workspaceDefinitionRevision,
    repositories: previousParams.inputManifest.repositories,
    bootstrapDigest: previousParams.inputManifest.bootstrapDigest,
  };
  const turn: StoredTurn = {
    id: randomUUID(),
    requestId: input.requestId,
    prompt: input.prompt,
    permissionMode: nextPermissionMode,
    ...(nextReasoningEffort === undefined ? {} : { reasoningEffort: nextReasoningEffort }),
    state: 'queued',
    createdAt: new Date().toISOString(),
    ...(resumeHandle === undefined ? {} : { resumeHandle }),
    ...(hostedFinalTurn && resumeHandle === undefined
      ? { providerPrompt: providerPromptForRemoteHistory(chat, input.prompt) }
      : {}),
  };
  const params = await prepareStartSessionJob({
    requestId: input.requestId,
    workspaceId: chat.workspaceId,
    targetEnrollmentId: chat.targetEnrollmentId,
    provider: chat.provider,
    model: chat.model,
    reasoningEffort: nextReasoningEffort,
    permissionMode: nextPermissionMode,
    ...(chat.credentialChoice === undefined ? {} : { authMode: chat.credentialChoice }),
    authSessionId: chat.sourceSessionId ?? chat.id,
    prompt: turn.providerPrompt ?? turn.prompt,
    manifestPin,
    ...(retryHandoffFromCheckpoint && chat.handoffId !== undefined
      ? { handoffId: chat.handoffId }
      : {}),
    ...(handoffCheckpoint === undefined ? {} : { handoffCheckpoint }),
    ...(turn.resumeHandle === undefined ? {} : { resumeThreadId: turn.resumeHandle }),
  });
  const current = readStored(chat.id);
  if (current === null) throw new Error(`remote chat not found: ${chat.id}`);
  if (
    current.state !== 'completed' &&
    !(retryHandoffFromCheckpoint && current.state === 'failed') &&
    !(hostedFinalTurn && ['failed', 'cancelled'].includes(current.state))
  )
    throw new Error(`remote chat is not ready for a follow-up (${current.state})`);
  turn.requestJson = JSON.stringify(params);
  current.turns.push(turn);
  current.activeTurnId = turn.id;
  current.permissionMode = nextPermissionMode;
  current.reasoningEffort = nextReasoningEffort;
  current.cancelRequested = false;
  current.jobId = undefined;
  current.hostedIdleSince = undefined;
  current.state = 'starting';
  current.error = undefined;
  // Persist sealed create params before issuing network effects.
  save(current);
  const beforeSubmit = readStored(current.id) ?? current;
  if (beforeSubmit.cancelRequested) return publicRecord(beforeSubmit);
  const job = await submitExactRequest(turn.requestJson, beforeSubmit);
  const latest = readStored(chat.id) ?? beforeSubmit;
  const activeTurn = latest.turns.find((candidate) => candidate.id === turn.id);
  if (activeTurn !== undefined) activeTurn.jobId = job.id;
  latest.jobId = job.id;
  save(latest);
  if (latest.cancelRequested) return await cancelRemoteChat(latest.id);
  return publicRecord(latest);
}

function createPayloadHash(input: CreateRemoteChatInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        workspaceId: input.workspaceId,
        target: input.target ?? 'device',
        targetEnrollmentId: input.targetEnrollmentId,
        sourceThreadId: input.sourceThreadId ?? null,
        provider: input.provider,
        model: input.model,
        reasoningEffort: input.reasoningEffort ?? null,
        permissionMode: input.permissionMode,
        credentialChoice: input.credentialChoice ?? null,
        prompt: input.prompt,
      }),
    )
    .digest('hex');
}

export async function cancelRemoteChat(id: string): Promise<RemoteChatRecord> {
  context();
  const chat = readStored(id);
  if (chat === null) throw new Error(`remote chat not found: ${id}`);
  chat.cancelRequested = true;
  save(chat);
  const active = chat.turns.find((turn) => turn.id === chat.activeTurnId);
  const activeSubmissionPending = active?.jobId === undefined && active?.requestJson !== undefined;
  const jobId = active?.jobId ?? (activeSubmissionPending ? undefined : chat.prepareJobId);
  if (jobId !== undefined) {
    const { job } = await jobRpc<{ job: JobSummary }>('job.cancel', { jobId }, chat);
    if (job.state === 'cancelled') {
      if (active !== undefined) active.state = 'cancelled';
      chat.state = 'cancelled';
      save(chat);
    } else if (['completed', 'failed', 'unknown-outcome'].includes(job.state)) {
      if (active?.jobId !== undefined) await observeJob(chat, active, active.jobId);
      else chat.state = stateForJob(job.state);
      save(chat);
    } else {
      chat.state = 'cancel-requested';
      save(chat);
    }
  } else {
    const exactRequest = active?.requestJson ?? chat.prepareRequestJson;
    if (exactRequest !== undefined) {
      // Submission may still be in flight, or the process may have stopped
      // after persisting the sealed request and before recording its reply.
      // Replay the same idempotent request, then cancel the resulting job.
      const pending = active?.requestJson !== undefined;
      if (pending) {
        const job = await submitExactRequest(exactRequest, chat);
        const latest = readStored(chat.id) ?? chat;
        const latestActive = latest.turns.find((turn) => turn.id === latest.activeTurnId);
        if (latestActive !== undefined) latestActive.jobId = job.id;
        latest.jobId = job.id;
        save(latest);
        return await cancelRemoteChat(latest.id);
      }
      const job = await submitExactRequest(exactRequest, chat);
      const latest = readStored(chat.id) ?? chat;
      latest.prepareJobId = job.id;
      save(latest);
      return await cancelRemoteChat(latest.id);
    }
    chat.state = 'cancelled';
    if (active !== undefined) active.state = 'cancelled';
    save(chat);
  }
  if (
    chat.target === 'anvil-hosted-cloud' &&
    ['completed', 'failed', 'cancelled'].includes(chat.state)
  ) {
    chat.hostedIdleSince ??= new Date().toISOString();
    save(chat);
  }
  return publicRecord(chat);
}

/** Stop a hosted environment permanently and release its provider allocation. */
export async function endRemoteChat(id: string): Promise<RemoteChatRecord> {
  context();
  let chat = readStored(id);
  if (chat === null) throw new Error(`remote chat not found: ${id}`);
  if (chat.target !== 'anvil-hosted-cloud' || chat.environmentId === undefined)
    throw new Error('Only Anvil hosted cloud chats can be ended from here.');
  const environmentId = chat.environmentId;
  if (!['completed', 'failed', 'cancelled', 'paused', 'ended'].includes(chat.state)) {
    await cancelRemoteChat(id);
    chat = readStored(id);
    if (chat === null) throw new Error(`remote chat not found: ${id}`);
    if (!['completed', 'failed', 'cancelled', 'paused', 'ended'].includes(chat.state))
      throw new Error('Wait for the active hosted turn to stop before ending this chat.');
  }
  if (chat.state === 'ended') return publicRecord(chat);
  const reap = context().reapHostedEnvironment;
  if (reap === undefined) throw new Error('Hosted environment termination is unavailable.');
  await reap(environmentId);
  const latest = readStored(id);
  if (latest === null) throw new Error(`remote chat not found: ${id}`);
  latest.state = 'ended';
  latest.cancelRequested = false;
  latest.hostedResumePending = false;
  latest.hostedIdleSince = undefined;
  latest.error = undefined;
  save(latest);
  return publicRecord(latest);
}

function stateForJob(state: JobSummary['state']): RemoteChatState {
  if (state === 'awaiting-approval') return 'awaiting-approval';
  if (state === 'completed') return 'completed';
  if (state === 'failed' || state === 'unknown-outcome') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'cancel-requested') return 'cancel-requested';
  if (state === 'running') return 'running';
  return 'starting';
}

async function observeJob(chat: StoredChat, turn: StoredTurn, jobId: string): Promise<void> {
  const result = await jobRpc<JobGetResult>('job.get', { jobId }, chat);
  const { job, attempts } = result;
  if (
    job.state === 'running' &&
    chat.credentialChoice !== undefined &&
    chat.credentialChoice !== 'target-local'
  ) {
    if (chat.target === 'anvil-hosted-cloud' && !(await hostedTargetMatches(chat)))
      throw new Error('The hosted environment no longer matches this remote chat.');
    const credential = await ensureRemoteCredentialGrant({
      choice: chat.credentialChoice,
      cloudTarget: chat.cloudTarget,
      provider: chat.provider,
      targetEnrollmentId: chat.targetEnrollmentId,
      scope: assertScope(chat).scope!,
      context: { apiUrl: context().apiUrl, accessToken: context().accessToken },
      result,
      ...(chat.target === 'anvil-hosted-cloud' && chat.environmentId !== undefined
        ? { hostedEnvironmentId: chat.environmentId }
        : {}),
      ...(turn.credentialMarker === undefined ? {} : { deliveredMarker: turn.credentialMarker }),
    });
    if (credential.delivered && credential.marker !== undefined)
      turn.credentialMarker = credential.marker;
  }
  turn.state =
    job.state === 'awaiting-approval'
      ? 'awaiting-approval'
      : job.state === 'completed'
        ? 'completed'
        : job.state === 'failed' || job.state === 'unknown-outcome'
          ? 'failed'
          : job.state === 'cancelled'
            ? 'cancelled'
            : 'running';
  chat.state = stateForJob(job.state);
  if (job.state === 'completed') {
    const attempt = attempts.find((item) => item.state === 'completed');
    if (attempt?.sealedResult !== undefined) {
      const ctx = context();
      if (ctx.scope === undefined) throw new Error('remote chat result needs a sync scope');
      const key = taskKeyFor(ctx.scope, job.id) ?? taskKeyFor(ctx.scope, `req:${job.requestId}`);
      if (key === null) throw new Error('remote chat task key is unavailable');
      const opened = unsealTaskResult(ctx.scope, job.id, attempt.id, key, attempt.sealedResult);
      if (typeof opened === 'object' && opened !== null) {
        const record = opened as Record<string, unknown>;
        if (typeof record['assistantOutput'] === 'string')
          turn.response = record['assistantOutput'];
        const resumeHandle = record['resumeHandle'];
        if (typeof resumeHandle === 'string' && resumeHandle.length > 0)
          turn.resumeHandle = resumeHandle;
      }
    }
  }
  if (job.state === 'failed' || job.state === 'unknown-outcome') {
    turn.error = job.stateReason ?? 'Remote job failed.';
    chat.error = turn.error;
  }
}

async function reconcileSuspendedHostedChat(chat: StoredChat): Promise<boolean> {
  if (
    chat.target !== 'anvil-hosted-cloud' ||
    chat.environmentId === undefined ||
    chat.targetEnrollmentId.startsWith('pending:') ||
    chat.hostedResumePending === true
  )
    return false;
  const listEnvironments = context().listHostedEnvironments;
  if (listEnvironments === undefined) return false;
  const { environments } = await listEnvironments();
  const environment = environments.find((entry) => entry.environmentId === chat.environmentId);
  if (environment?.state !== 'suspended') return false;

  if (['completed', 'failed', 'cancelled'].includes(chat.state)) {
    chat.state = 'paused';
    chat.hostedIdleSince = undefined;
    chat.cancelRequested = false;
    chat.error = undefined;
    save(chat);
    return true;
  }

  const active = chat.turns.find((turn) => turn.id === chat.activeTurnId);
  if (active?.jobId !== undefined) {
    await observeJob(chat, active, active.jobId);
    if (['completed', 'failed', 'cancelled'].includes(chat.state)) {
      chat.state = 'paused';
      chat.hostedIdleSince = undefined;
      chat.cancelRequested = false;
      chat.error = undefined;
      save(chat);
    }
    return true;
  }

  if (chat.prepareJobId !== undefined) {
    const { job } = await jobRpc<JobGetResult>('job.get', { jobId: chat.prepareJobId }, chat);
    if (['completed', 'failed', 'cancelled', 'unknown-outcome'].includes(job.state)) {
      if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'unknown-outcome') {
        chat.state = job.state === 'cancelled' ? 'cancelled' : 'failed';
        chat.error = job.stateReason ?? `Workspace preparation ${job.state}.`;
      }
      chat.state = 'paused';
      chat.hostedIdleSince = undefined;
      chat.cancelRequested = false;
      save(chat);
    }
    return true;
  }

  if (chat.state === 'starting' && active?.requestJson !== undefined) {
    // The exact request may have been persisted before submit but not recorded
    // as a job id. The next user turn can safely replay or replace it after
    // waking this same environment.
    chat.state = 'paused';
    chat.hostedIdleSince = undefined;
    chat.cancelRequested = false;
    save(chat);
    return true;
  }
  return true;
}

async function tickChat(id: string): Promise<void> {
  const chat = readStored(id);
  if (chat === null || ['paused', 'ended'].includes(chat.state)) return;
  if (chat.target === 'anvil-hosted-cloud' && chat.state === 'checkpointing') {
    await checkpointHostedChat(chat);
    return;
  }
  if (await reconcileSuspendedHostedChat(chat)) return;
  if (
    chat.target === 'anvil-hosted-cloud' &&
    ['completed', 'failed', 'cancelled'].includes(chat.state)
  ) {
    const idleSince =
      chat.hostedIdleSince === undefined ? Date.now() : Date.parse(chat.hostedIdleSince);
    if (chat.hostedIdleSince === undefined) {
      chat.hostedIdleSince = new Date(idleSince).toISOString();
      save(chat);
      return;
    }
    if (!Number.isFinite(idleSince) || Date.now() - idleSince < HOSTED_IDLE_GRACE_MS) return;
    await checkpointHostedChat(chat);
    return;
  }
  if (['failed', 'cancelled'].includes(chat.state)) return;
  if (
    chat.target === 'anvil-hosted-cloud' &&
    (chat.targetEnrollmentId.startsWith('pending:') || chat.hostedResumePending === true)
  ) {
    if (chat.environmentId === undefined)
      throw new Error('Hosted remote chat lost its environment id.');
    const listEnvironments = context().listHostedEnvironments;
    if (listEnvironments === undefined)
      throw new Error('Hosted cloud provisioning is unavailable.');
    const { environments } = await listEnvironments();
    const environment = environments.find((entry) => entry.environmentId === chat.environmentId);
    if (environment === undefined) {
      if (!isAnvilCloudAgentsEnabled()) return;
      await requestProvisioning(chat);
      return;
    }
    if (
      environment.state === 'failed' ||
      environment.state === 'terminated' ||
      environment.state === 'expired'
    ) {
      chat.state = 'failed';
      chat.error = `Hosted environment ${environment.state}.`;
      save(chat);
      return;
    }
    if (environment.state === 'suspended' && chat.hostedResumePending === true) {
      if (!isAnvilCloudAgentsEnabled()) return;
      const resume = context().resumeHostedEnvironment;
      if (resume === undefined) throw new Error('Hosted environment resume is unavailable.');
      await resume(chat.environmentId);
      return;
    }
    if (
      (environment.state !== 'enrolled' && environment.state !== 'running') ||
      environment.enrollmentId === undefined ||
      (chat.hostedResumePending === true &&
        environment.enrollmentId === chat.hostedPreviousEnrollmentId)
    ) {
      chat.state = 'provisioning';
      save(chat);
      return;
    }
    const devices = await jobRpc<DeviceListResult>('device.list', {}, chat);
    const target = devices.devices.find(
      (device) => device.enrollmentId === environment.enrollmentId,
    );
    if (target === undefined || target.revoked || target.enrollmentClass !== 'ephemeral') {
      chat.state = 'provisioning';
      save(chat);
      return;
    }
    // Binding this target to the environment record is the execution-only
    // authorization. It intentionally does not promote the enrollment in the
    // account keyring, where trusted means eligible for account-key delivery.
    chat.targetEnrollmentId = environment.enrollmentId;
    chat.hostedResumePending = false;
    chat.hostedPreviousEnrollmentId = undefined;
    chat.state = 'preparing';
    save(chat);
  }
  if (
    chat.target === 'anvil-hosted-cloud' &&
    !chat.targetEnrollmentId.startsWith('pending:') &&
    !(await hostedTargetMatches(chat))
  ) {
    chat.state = 'failed';
    chat.error = 'The hosted environment no longer matches this remote chat.';
    save(chat);
    return;
  }
  const active = chat.turns.find((turn) => turn.id === chat.activeTurnId);
  if (active === undefined) return;
  if (chat.cancelRequested) {
    if (active.jobId === undefined && active.requestJson !== undefined) {
      const started = await submitExactRequest(active.requestJson, chat);
      const latest = readStored(chat.id) ?? chat;
      const latestActive = latest.turns.find((turn) => turn.id === latest.activeTurnId);
      if (latestActive !== undefined) latestActive.jobId = started.id;
      latest.jobId = started.id;
      latest.hostedIdleSince = undefined;
      save(latest);
      await cancelRemoteChat(latest.id);
      return;
    }
    const activeJobId = active.jobId ?? chat.prepareJobId;
    if (activeJobId === undefined) {
      chat.state = 'cancelled';
      active.state = 'cancelled';
      if (chat.target === 'anvil-hosted-cloud') chat.hostedIdleSince ??= new Date().toISOString();
      save(chat);
    } else {
      const { job } = await jobRpc<JobGetResult>('job.get', { jobId: activeJobId }, chat);
      if (job.state === 'cancelled') {
        chat.state = 'cancelled';
        active.state = 'cancelled';
        if (chat.target === 'anvil-hosted-cloud') chat.hostedIdleSince ??= new Date().toISOString();
      } else if (['completed', 'failed', 'unknown-outcome'].includes(job.state)) {
        await observeJob(chat, active, activeJobId);
      } else {
        chat.state = 'cancel-requested';
        if (active.state !== 'completed') active.state = 'running';
      }
      save(chat);
    }
    return;
  }
  if (chat.hostedResumeManifest !== undefined && active.requestJson === undefined) {
    const params = await prepareStartSessionJob({
      requestId: active.requestId,
      workspaceId: chat.workspaceId,
      targetEnrollmentId: chat.targetEnrollmentId,
      provider: chat.provider,
      model: chat.model,
      reasoningEffort: active.reasoningEffort ?? chat.reasoningEffort,
      permissionMode: chat.permissionMode,
      ...(chat.credentialChoice === undefined ? {} : { authMode: chat.credentialChoice }),
      authSessionId: chat.sourceSessionId ?? chat.id,
      prompt: active.providerPrompt ?? active.prompt,
      manifestPin: chat.hostedResumeManifest,
      ...(active.resumeHandle === undefined ? {} : { resumeThreadId: active.resumeHandle }),
    });
    const latest = readStored(chat.id);
    if (latest === null || latest.cancelRequested) return;
    const latestActive = latest.turns.find((turn) => turn.id === latest.activeTurnId);
    if (latestActive === undefined) throw new Error('remote chat lost its queued continuation');
    latestActive.requestJson = JSON.stringify(params);
    latest.hostedResumeManifest = undefined;
    latest.state = 'starting';
    save(latest);
    const started = await submitExactRequest(latestActive.requestJson, latest);
    const submitted = readStored(latest.id) ?? latest;
    const submittedTurn = submitted.turns.find((turn) => turn.id === submitted.activeTurnId);
    if (submittedTurn !== undefined) submittedTurn.jobId = started.id;
    submitted.jobId = started.id;
    save(submitted);
    return;
  }
  if (chat.prepareJobId === undefined) {
    if (
      chat.target === 'anvil-hosted-cloud' &&
      chat.prepareRequestJson === undefined &&
      chat.targetEnrollmentId !== ''
    ) {
      const params = await preparePrepareWorkspaceJob({
        requestId: chat.hostedPrepareRequestId ?? `remote-chat-prepare:${chat.createRequestId}`,
        workspaceId: chat.workspaceId,
        targetEnrollmentId: chat.targetEnrollmentId,
        permissionMode: chat.permissionMode,
        provider: chat.provider,
        model: chat.model,
      });
      const latest = readStored(chat.id);
      if (latest === null || latest.cancelRequested) return;
      latest.prepareRequestJson = JSON.stringify(params);
      save(latest);
      return;
    }
    if (chat.prepareRequestJson === undefined) return;
    const job = await submitExactRequest(chat.prepareRequestJson, chat);
    const latest = readStored(chat.id) ?? chat;
    latest.prepareJobId = job.id;
    latest.error = undefined;
    save(latest);
    if (latest.cancelRequested) await cancelRemoteChat(latest.id);
    return;
  }
  if (active.jobId === undefined) {
    const { job } = await jobRpc<JobGetResult>('job.get', { jobId: chat.prepareJobId }, chat);
    if (job.state === 'completed') {
      if (active.requestJson === undefined) {
        const prepared = JSON.parse(chat.prepareRequestJson ?? '') as JobCreateParams;
        if (prepared.inputManifest === undefined)
          throw new Error('remote workspace preparation lost its target manifest pins');
        const params = await prepareStartSessionJob({
          requestId: `remote-chat-start:${chat.id}:${active.id}`,
          workspaceId: chat.workspaceId,
          targetEnrollmentId: chat.targetEnrollmentId,
          provider: chat.provider,
          model: chat.model,
          reasoningEffort: active.reasoningEffort ?? chat.reasoningEffort,
          permissionMode: chat.permissionMode,
          ...(chat.credentialChoice === undefined ? {} : { authMode: chat.credentialChoice }),
          authSessionId: chat.sourceSessionId ?? chat.id,
          prompt: active.providerPrompt ?? active.prompt,
          manifestPin: chat.hostedRetryManifestPin ?? {
            workspaceDefinitionRevision: prepared.inputManifest.workspaceDefinitionRevision,
            repositories: prepared.inputManifest.repositories,
            bootstrapDigest: prepared.inputManifest.bootstrapDigest,
          },
        });
        const latest = readStored(chat.id);
        if (latest === null) throw new Error(`remote chat not found: ${chat.id}`);
        if (latest.cancelRequested) return;
        const latestActive = latest.turns.find((turn) => turn.id === active.id);
        if (latestActive === undefined) throw new Error('remote chat lost its active turn');
        latestActive.requestJson = JSON.stringify(params);
        latest.hostedRetryManifestPin = undefined;
        latest.hostedPrepareRequestId = undefined;
        save(latest);
      }
      const beforeStart = readStored(chat.id);
      if (beforeStart === null || beforeStart.cancelRequested) return;
      const beforeStartTurn = beforeStart.turns.find((turn) => turn.id === active.id);
      if (beforeStartTurn?.requestJson === undefined)
        throw new Error('remote chat lost exact job.create request');
      const started = await submitExactRequest(beforeStartTurn.requestJson, beforeStart);
      const submitted = readStored(chat.id) ?? beforeStart;
      const submittedTurn = submitted.turns.find((turn) => turn.id === active.id);
      if (submittedTurn !== undefined) submittedTurn.jobId = started.id;
      submitted.jobId = started.id;
      submitted.state = 'starting';
      save(submitted);
      if (submitted.cancelRequested) await cancelRemoteChat(submitted.id);
      return;
    } else if (
      job.state === 'failed' ||
      job.state === 'cancelled' ||
      job.state === 'unknown-outcome'
    ) {
      chat.state = job.state === 'cancelled' ? 'cancelled' : 'failed';
      chat.error = job.stateReason ?? `Workspace preparation ${job.state}.`;
      if (chat.target === 'anvil-hosted-cloud') chat.hostedIdleSince ??= new Date().toISOString();
      save(chat);
    } else {
      chat.state =
        stateForJob(job.state) === 'awaiting-approval' ? 'awaiting-approval' : 'preparing';
      save(chat);
    }
    return;
  }
  if (active.jobId === undefined) throw new Error('remote chat lost exact job.create request');
  await observeJob(chat, active, active.jobId);
  if (
    chat.target === 'anvil-hosted-cloud' &&
    ['completed', 'failed', 'cancelled'].includes(chat.state)
  )
    chat.hostedIdleSince ??= new Date().toISOString();
  save(chat);
}

async function checkpointHostedChat(chat: StoredChat): Promise<void> {
  if (chat.environmentId === undefined)
    throw new Error('Hosted remote chat lost its environment id.');
  const suspend = context().suspendHostedEnvironment;
  if (suspend === undefined) throw new Error('Hosted environment suspension is unavailable.');
  const current = readStored(chat.id);
  if (current === null) return;
  if (current.state !== 'checkpointing') {
    if (
      !['completed', 'failed', 'cancelled'].includes(current.state) ||
      current.activeTurnId !== chat.activeTurnId
    )
      return;
    const idleSince =
      current.hostedIdleSince === undefined ? Number.NaN : Date.parse(current.hostedIdleSince);
    if (!Number.isFinite(idleSince) || Date.now() - idleSince < HOSTED_IDLE_GRACE_MS) return;
    current.state = 'checkpointing';
    current.cancelRequested = false;
    save(current);
  }
  const environment = await suspend(chat.environmentId);
  if (environment.state !== 'suspended')
    throw new Error(`Hosted environment suspension returned ${environment.state}.`);
  const latest = readStored(chat.id);
  if (latest === null) return;
  if (latest.state !== 'checkpointing' || latest.activeTurnId !== current.activeTurnId) return;
  latest.state = 'paused';
  latest.error = undefined;
  save(latest);
}

export function remoteChatOnReady(): void {
  if (tickTimer !== null) return;
  void remoteChatTick();
  tickTimer = setInterval(() => void remoteChatTick(), 2_000);
}

export function remoteChatOnGone(): void {
  if (tickTimer !== null) clearInterval(tickTimer);
  tickTimer = null;
}

export function remoteChatTick(): Promise<void> {
  if (tickInFlight !== null) return tickInFlight;
  tickInFlight = (async () => {
    if ((contextProvider?.() ?? null) === null) return;
    for (const row of rows()) {
      try {
        await tickChat(row.id);
      } catch (error) {
        const chat = readStored(row.id);
        if (chat !== null) {
          chat.error = error instanceof Error ? error.message : String(error);
          save(chat);
        }
      }
    }
  })().finally(() => {
    tickInFlight = null;
  });
  return tickInFlight;
}

export function resetRemoteChatForTests(): void {
  remoteChatOnGone();
  contextProvider = null;
  tickInFlight = null;
}
