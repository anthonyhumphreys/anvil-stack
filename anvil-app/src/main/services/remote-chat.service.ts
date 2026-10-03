import { createHash, randomUUID } from 'node:crypto';

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
}

interface StoredTurn extends RemoteChatTurn {
  requestId: string;
  /** Exact sealed job.create params are replayed after a crash/lost response. */
  requestJson?: string;
  /** Provider-native handle remains main-process data. */
  resumeHandle?: string;
  credentialMarker?: string;
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
    if (prior.cancelRequested && prior.activeTurnId === record.activeTurnId) {
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
       ON CONFLICT(id) DO UPDATE SET state=excluded.state, record_json=excluded.record_json,
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
    provider: record.provider,
    model: record.model,
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
  expected: Pick<StoredChat, 'backendId' | 'accountId' | 'scopeEpoch'>,
): Promise<JobSummary> {
  assertScope(expected);
  return submitPreparedJob(JSON.parse(json) as JobCreateParams);
}

export async function createRemoteChat(input: CreateRemoteChatInput): Promise<RemoteChatRecord> {
  const ctx = context();
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
    (device) => device.enrollmentId === input.targetEnrollmentId,
  );
  if (targetDevice === undefined || targetDevice.revoked)
    throw new Error('Choose an active destination device.');
  if (deviceTrustState(ctx.scope!, input.targetEnrollmentId) !== 'trusted')
    throw new Error('Remote chats can only run on a trusted destination device.');
  if (input.provider === 'codex') {
    input = {
      ...input,
      credentialChoice:
        input.credentialChoice ??
        (targetDevice.enrollmentClass === 'ephemeral' ? 'codex-host-auth' : 'target-local'),
    };
    validateRemoteCredentialChoice(
      input.provider,
      input.targetEnrollmentId,
      ctx.scope!,
      input.credentialChoice,
    );
    validateRemoteCredentialAvailability(input.credentialChoice!);
  } else if (input.credentialChoice !== undefined && input.credentialChoice !== 'target-local') {
    throw new Error('Remote credential choices are only available for Codex sessions.');
  }
  if (targetDevice.enrollmentClass === 'ephemeral') {
    if (input.provider !== 'codex')
      throw new Error('Cloud workers currently support Codex sessions only.');
    if (input.credentialChoice === 'target-local')
      throw new Error(
        'A cloud worker needs your host Codex login, destination sign-in or an OpenAI API key.',
      );
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
    targetEnrollmentId: input.targetEnrollmentId,
    provider: input.provider,
    model: input.model,
    permissionMode: input.permissionMode,
    ...(input.credentialChoice === undefined ? {} : { credentialChoice: input.credentialChoice }),
    state: 'preparing',
    turns: [
      {
        id: turnId,
        requestId: `remote-chat-start:${id}:${turnId}`,
        prompt: input.prompt,
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

export async function sendRemoteChat(input: SendRemoteChatInput): Promise<RemoteChatRecord> {
  context();
  const chat = readStored(input.sessionId);
  if (chat === null) throw new Error(`remote chat not found: ${input.sessionId}`);
  const duplicate = chat.turns.find((turn) => turn.requestId === input.requestId);
  if (duplicate !== undefined) {
    if (duplicate.prompt !== input.prompt)
      throw new Error('remote chat turn request id was reused with a different prompt');
    await remoteChatTick();
    return publicRecord(readStored(input.sessionId) ?? chat);
  }
  const retryHandoffFromCheckpoint = chat.state === 'failed' && chat.handoffId !== undefined;
  if (chat.state !== 'completed' && !retryHandoffFromCheckpoint)
    throw new Error(`remote chat is not ready for a follow-up (${chat.state})`);
  const previous = chat.turns.at(-1);
  if (previous === undefined) throw new Error('remote chat has no previous turn to continue');
  if (!retryHandoffFromCheckpoint && previous?.resumeHandle === undefined) {
    throw new Error('The remote provider session cannot be resumed on this target.');
  }
  if (previous.requestJson === undefined)
    throw new Error('The original remote checkout pins are unavailable.');
  const previousParams = JSON.parse(previous.requestJson) as JobCreateParams;
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
    state: 'queued',
    createdAt: new Date().toISOString(),
    ...(previous?.resumeHandle === undefined ? {} : { resumeHandle: previous.resumeHandle }),
  };
  const params = await prepareStartSessionJob({
    requestId: input.requestId,
    workspaceId: chat.workspaceId,
    targetEnrollmentId: chat.targetEnrollmentId,
    provider: chat.provider,
    model: chat.model,
    permissionMode: chat.permissionMode,
    ...(chat.credentialChoice === undefined ? {} : { authMode: chat.credentialChoice }),
    authSessionId: chat.sourceSessionId ?? chat.id,
    prompt: input.prompt,
    manifestPin,
    ...(retryHandoffFromCheckpoint && chat.handoffId !== undefined
      ? { handoffId: chat.handoffId }
      : {}),
    ...(handoffCheckpoint === undefined ? {} : { handoffCheckpoint }),
    ...(turn.resumeHandle === undefined ? {} : { resumeThreadId: turn.resumeHandle }),
  });
  const current = readStored(chat.id);
  if (current === null) throw new Error(`remote chat not found: ${chat.id}`);
  if (current.state !== 'completed' && !(retryHandoffFromCheckpoint && current.state === 'failed'))
    throw new Error(`remote chat is not ready for a follow-up (${current.state})`);
  turn.requestJson = JSON.stringify(params);
  current.turns.push(turn);
  current.activeTurnId = turn.id;
  current.cancelRequested = false;
  current.jobId = undefined;
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
        targetEnrollmentId: input.targetEnrollmentId,
        provider: input.provider,
        model: input.model,
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
  return publicRecord(chat);
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
  if (chat.provider === 'codex' && chat.credentialChoice !== undefined) {
    const credential = await ensureRemoteCredentialGrant({
      choice: chat.credentialChoice,
      provider: chat.provider,
      targetEnrollmentId: chat.targetEnrollmentId,
      scope: assertScope(chat).scope!,
      context: { apiUrl: context().apiUrl, accessToken: context().accessToken },
      result,
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

async function tickChat(id: string): Promise<void> {
  const chat = readStored(id);
  if (chat === null || ['completed', 'failed', 'cancelled'].includes(chat.state)) return;
  const active = chat.turns.find((turn) => turn.id === chat.activeTurnId);
  if (active === undefined) return;
  if (chat.cancelRequested) {
    if (active.jobId === undefined && active.requestJson !== undefined) {
      const started = await submitExactRequest(active.requestJson, chat);
      const latest = readStored(chat.id) ?? chat;
      const latestActive = latest.turns.find((turn) => turn.id === latest.activeTurnId);
      if (latestActive !== undefined) latestActive.jobId = started.id;
      latest.jobId = started.id;
      save(latest);
      await cancelRemoteChat(latest.id);
      return;
    }
    const activeJobId = active.jobId ?? chat.prepareJobId;
    if (activeJobId === undefined) {
      chat.state = 'cancelled';
      active.state = 'cancelled';
      save(chat);
    } else {
      const { job } = await jobRpc<JobGetResult>('job.get', { jobId: activeJobId }, chat);
      if (job.state === 'cancelled') {
        chat.state = 'cancelled';
        active.state = 'cancelled';
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
  if (chat.prepareJobId === undefined) {
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
          permissionMode: chat.permissionMode,
          ...(chat.credentialChoice === undefined ? {} : { authMode: chat.credentialChoice }),
          authSessionId: chat.sourceSessionId ?? chat.id,
          prompt: active.prompt,
          manifestPin: {
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
  save(chat);
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
