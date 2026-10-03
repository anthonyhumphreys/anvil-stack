// Session handoff orchestration (SESSION-03, spec §11).
//
// Ownership rule: the backend's `mesh_sessions` row is the generation
// authority; this device's `mesh_session_ownership` row is its durable
// local mirror. The source writes `relinquished` BEFORE the backend
// advances the handoff past the transfer point, so a restart in between
// can never reactivate a session whose ownership already moved. Sessions
// with no ownership row are ordinary local sessions — no cloud lease.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { getDb } from '../db/database.js';
import { rpc } from './sync-backend-client.service.js';
import { getFullStatus } from './git.service.js';
import { detectUnsupportedCheckout } from './workspace-materialization.service.js';
import { readSessionOwnership, writeSessionOwnership } from './mesh-ownership.service.js';
import {
  getCodexSession,
  getCodexSessionModel,
  interruptTurn,
  stopSessionAndWait,
} from './codex-session.service.js';
import type {
  HandoffAdvanceResult,
  HandoffCancelResult,
  HandoffCheckpoint,
  HandoffCreateResult,
  HandoffGetResult,
  HandoffRecord,
  SessionCheckpoint,
} from '../../../cloud/contract/handoff.js';
import type { SyncScope } from '../../shared/sync-mesh.js';
import { deviceTrustState, sealScopedJson } from './sync-keyring.service.js';
import {
  preparePrepareWorkspaceJob,
  prepareStartSessionJob,
  submitPreparedJob,
} from './mesh-worker.service.js';
import type { JobCreateParams, JobGetResult } from '../../../cloud/contract/jobs.js';
import type { AgentProvider } from '../../shared/types.js';
import { isAgentProvider } from '../../shared/agent-providers.js';
import type { PermissionMode } from '../../../cloud/contract/permissions.js';
import type { DeviceListResult } from '../../../cloud/contract/auth.js';
import { adoptHandoffRemoteChat } from './remote-chat.service.js';

const execFileAsync = promisify(execFile);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- context ---------------------------------------------------------------

export interface MeshHandoffContext {
  apiUrl: string;
  accessToken: string;
  enrollmentId: string;
  /** Sync scope for E2E checkpoint sealing; absent contexts send plaintext. */
  scope?: SyncScope;
}

let contextProvider: (() => MeshHandoffContext | null) | null = null;
const activeHandoffIds = new Set<string>();

export function configureMeshHandoffContext(provider: () => MeshHandoffContext | null): void {
  contextProvider = provider;
}

function handoffContext(): MeshHandoffContext {
  const ctx = contextProvider?.() ?? null;
  if (ctx === null) {
    throw new Error('handoff requires an enrolled sync connection');
  }
  return ctx;
}

export function resetMeshHandoffForTests(): void {
  contextProvider = null;
  activeHandoffIds.clear();
}

// ---- ownership gate --------------------------------------------------------
//
// read/write live in mesh-ownership.service.js (leaf module shared with the
// chat turn-start gate — importing it here would make a codex-session ↔
// mesh-handoff cycle).

// ---- journal ---------------------------------------------------------------

interface HandoffJournalRow {
  handoff_id: string;
  session_id: string;
  role: 'source' | 'target';
  state: string;
  backend_id?: string | null;
  account_id?: string | null;
  scope_epoch?: string | null;
}

function journalHandoff(
  handoffId: string,
  sessionId: string,
  role: 'source' | 'target',
  ctx: MeshHandoffContext,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO mesh_handoff_journal
       (handoff_id, session_id, role, state, created_at, updated_at, backend_id, account_id, scope_epoch)
       VALUES (?, ?, ?, 'requested', ?, ?, ?, ?, ?)
       ON CONFLICT(handoff_id) DO NOTHING`,
    )
    .run(
      handoffId,
      sessionId,
      role,
      now,
      now,
      ctx.scope?.backendId ?? null,
      ctx.scope?.accountId ?? null,
      ctx.scope?.datasetEpoch ?? null,
    );
  const existing = getDb()
    .prepare(
      'SELECT backend_id, account_id, scope_epoch FROM mesh_handoff_journal WHERE handoff_id = ?',
    )
    .get(handoffId) as
    | { backend_id: string | null; account_id: string | null; scope_epoch: string | null }
    | undefined;
  if (
    existing === undefined ||
    existing.backend_id !== (ctx.scope?.backendId ?? null) ||
    existing.account_id !== (ctx.scope?.accountId ?? null) ||
    existing.scope_epoch !== (ctx.scope?.datasetEpoch ?? null)
  ) {
    throw new Error('handoff journal belongs to a different sync scope');
  }
}

function journalHandoffState(handoffId: string, state: string): void {
  getDb()
    .prepare('UPDATE mesh_handoff_journal SET state = ?, updated_at = ? WHERE handoff_id = ?')
    .run(state, new Date().toISOString(), handoffId);
}

function journalJobRequest(
  handoffId: string,
  phase: 'preparation' | 'activation',
  requestId: string,
  params: JobCreateParams,
): void {
  const column = phase === 'preparation' ? 'preparation' : 'activation';
  getDb()
    .prepare(
      `UPDATE mesh_handoff_journal SET ${column}_request_json = ?, ${column}_request_id = ?, updated_at = ?
       WHERE handoff_id = ?`,
    )
    .run(JSON.stringify(params), requestId, new Date().toISOString(), handoffId);
}

function journalJobId(handoffId: string, phase: 'preparation' | 'activation', jobId: string): void {
  const column = phase === 'preparation' ? 'preparation' : 'activation';
  getDb()
    .prepare(
      `UPDATE mesh_handoff_journal SET ${column}_job_id = ?, updated_at = ? WHERE handoff_id = ?`,
    )
    .run(jobId, new Date().toISOString(), handoffId);
}

function journalSourceCheckpoint(handoffId: string, checkpoint: SessionCheckpoint): void {
  getDb()
    .prepare(
      'UPDATE mesh_handoff_journal SET source_checkpoint_json = ?, updated_at = ? WHERE handoff_id = ?',
    )
    .run(JSON.stringify(checkpoint), new Date().toISOString(), handoffId);
}

interface SourceRepositoryPin {
  repositoryId: string;
  sourceRepositoryId: string;
  path: string;
  commit: string;
}

async function captureSourceRepositoryPins(
  sessionId: string,
  workspaceId: string,
): Promise<SourceRepositoryPin[]> {
  const pins: SourceRepositoryPin[] = [];
  for (const repo of sessionRepositories(sessionId)) {
    const commit = await gitHead(repo.path);
    if (commit === null) throw new Error(`cannot resolve HEAD for ${repo.repositoryId}`);
    const definition = getDb()
      .prepare(
        `SELECT portable_id FROM workspace_repo_definitions
         WHERE workspace_id = ? AND mapped_repo_id = ? LIMIT 1`,
      )
      .get(workspaceId, repo.repositoryId) as { portable_id: string } | undefined;
    pins.push({
      repositoryId: definition?.portable_id ?? repo.repositoryId,
      sourceRepositoryId: repo.repositoryId,
      path: repo.path,
      commit,
    });
  }
  return pins;
}

async function assertSourceRepositoryPins(
  sessionId: string,
  pins: SourceRepositoryPin[],
): Promise<void> {
  const readiness = await evaluateHandoffReadiness(sessionId);
  if (!readiness.ok) throw new Error('source checkout changed during target preparation');
  for (const pin of pins) {
    if ((await gitHead(pin.path)) !== pin.commit)
      throw new Error(`source HEAD changed during target preparation: ${pin.sourceRepositoryId}`);
  }
}

function assertCheckpointPins(checkpoint: SessionCheckpoint, pins: SourceRepositoryPin[]): void {
  for (const pin of pins) {
    const checkpointRepo = checkpoint.repositories.find(
      (repo) => repo.repositoryId === pin.sourceRepositoryId,
    );
    if (checkpointRepo?.commit !== pin.commit)
      throw new Error(`checkpoint HEAD differs from prepared target: ${pin.sourceRepositoryId}`);
  }
}

function journalActivationMetadata(input: {
  handoffId: string;
  workspaceId: string;
  targetEnrollmentId: string;
  provider: AgentProvider;
  model: string;
  permissionMode: PermissionMode;
  authMode: 'target-local' | 'codex-account';
}): void {
  getDb()
    .prepare(
      `UPDATE mesh_handoff_journal SET activation_workspace_id = ?, activation_target_enrollment_id = ?,
       activation_provider = ?, activation_model = ?, activation_permission_mode = ?, activation_auth_mode = ?, updated_at = ?
       WHERE handoff_id = ?`,
    )
    .run(
      input.workspaceId,
      input.targetEnrollmentId,
      input.provider,
      input.model,
      input.permissionMode,
      input.authMode,
      new Date().toISOString(),
      input.handoffId,
    );
}

async function waitForPreparation(jobId: string, expected: MeshHandoffContext): Promise<void> {
  for (;;) {
    const result = await handoffRpc<JobGetResult>('job.get', { jobId }, expected);
    if (result.job.state === 'completed') return;
    if (
      result.job.state === 'failed' ||
      result.job.state === 'cancelled' ||
      result.job.state === 'unknown-outcome'
    ) {
      throw new Error(
        `target workspace preparation ${result.job.state}: ${result.job.stateReason ?? 'no details'}`,
      );
    }
    await delay(2_000);
  }
}

// ---- readiness gate (G4) ---------------------------------------------------

export interface HandoffBlocker {
  repositoryId?: string;
  code:
    | 'dirty-tree'
    | 'untracked-inputs'
    | 'unpushed-commits'
    | 'no-upstream'
    | 'submodules'
    | 'lfs'
    | 'shallow'
    | 'no-checkout';
  remediation: string;
}

interface SessionRepoRef {
  repositoryId: string;
  path: string;
}

/** The repos a session's thread actually spans (thread repo_ids first). */
function sessionRepositories(sessionId: string): SessionRepoRef[] {
  const row = getDb()
    .prepare(
      `SELECT t.repo_ids_json
       FROM chat_sessions s JOIN chat_threads t ON t.id = s.thread_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as { repo_ids_json: string | null } | undefined;
  if (row === undefined) return [];
  let repoIds: string[] = [];
  try {
    const parsed = JSON.parse(row.repo_ids_json ?? '[]') as unknown;
    if (Array.isArray(parsed)) repoIds = parsed.filter((r): r is string => typeof r === 'string');
  } catch {
    return [];
  }
  const out: SessionRepoRef[] = [];
  for (const repoId of repoIds) {
    const repo = getDb().prepare('SELECT id, path FROM repos WHERE id = ?').get(repoId) as
      | { id: string; path: string }
      | undefined;
    if (repo !== undefined) out.push({ repositoryId: repoId, path: repo.path });
  }
  return out;
}

async function gitHead(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', 'HEAD'], {
      timeout: 10_000,
    });
    return String(stdout).trim() || null;
  } catch {
    return null;
  }
}

/**
 * G4 readiness: clean tracked state, explicit untracked-input treatment,
 * commits reachable through an upstream remote, no LFS/submodule/shallow
 * checkouts. Every blocker carries a concrete remediation.
 */
export async function evaluateHandoffReadiness(
  sessionId: string,
): Promise<{ ok: boolean; blockers: HandoffBlocker[] }> {
  const blockers: HandoffBlocker[] = [];
  const repos = sessionRepositories(sessionId);
  if (repos.length === 0) {
    blockers.push({
      code: 'no-checkout',
      remediation: 'The session has no resolved repository checkouts to checkpoint.',
    });
    return { ok: false, blockers };
  }
  for (const repo of repos) {
    const unsupported = await detectUnsupportedCheckout(repo.path);
    if (unsupported !== null) {
      blockers.push({
        repositoryId: repo.repositoryId,
        code: unsupported,
        remediation:
          unsupported === 'submodules'
            ? 'Repositories with submodules cannot be handed off; detach or vendor them first.'
            : unsupported === 'lfs'
              ? 'LFS-backed checkouts cannot be handed off; the target would not have the objects.'
              : 'Shallow checkouts cannot be handed off; fetch full history first.',
      });
      continue;
    }
    const status = await getFullStatus(repo.path);
    const modified = status.files.filter((f) => f.status !== 'untracked');
    if (modified.length > 0) {
      blockers.push({
        repositoryId: repo.repositoryId,
        code: 'dirty-tree',
        remediation: `Commit or discard ${modified.length} tracked change(s) before handoff.`,
      });
    }
    const untracked = status.files.filter((f) => f.status === 'untracked');
    if (untracked.length > 0) {
      blockers.push({
        repositoryId: repo.repositoryId,
        code: 'untracked-inputs',
        remediation: `${untracked.length} untracked file(s) do not transfer — add, ignore, or remove them.`,
      });
    }
    if (status.tracking === undefined) {
      blockers.push({
        repositoryId: repo.repositoryId,
        code: 'no-upstream',
        remediation: 'Set an upstream remote so checkpoint commits are reachable on the target.',
      });
    } else if (status.ahead > 0) {
      blockers.push({
        repositoryId: repo.repositoryId,
        code: 'unpushed-commits',
        remediation: `Push ${status.ahead} local commit(s) — handoff transfers refs, not objects.`,
      });
    }
  }
  return { ok: blockers.length === 0, blockers };
}

// ---- checkpoint capture ----------------------------------------------------

const CHECKPOINT_MAX_MESSAGES = 20;
const CHECKPOINT_MESSAGE_CHARS = 4_000;

function sessionCheckpointContext(sessionId: string): {
  threadId: string;
  workspaceId: string | null;
  provider: string;
  model: string | null;
  planGoal: string | null;
} | null {
  const row = getDb()
    .prepare(
      `SELECT s.thread_id, s.provider, t.workspace_id, t.provider_thread_id, t.provider_thread_provider,
              t.active_plan_json, t.active_goal_json
       FROM chat_sessions s JOIN chat_threads t ON t.id = s.thread_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as
    | {
        thread_id: string;
        workspace_id: string | null;
        provider: string | null;
        provider_thread_provider: string | null;
        active_plan_json: string | null;
        active_goal_json: string | null;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    threadId: row.thread_id,
    workspaceId: row.workspace_id,
    provider: row.provider_thread_provider ?? row.provider ?? 'codex',
    model: null,
    planGoal: row.active_goal_json ?? row.active_plan_json,
  };
}

/**
 * Exact-commit manifest + bounded transferable context. Provider thread ids
 * are NOT portability proof (SESSION-01 audit): cross-device continuation is
 * summary/messages, never a remote resume claim.
 */
export async function captureSessionCheckpoint(
  sessionId: string,
  sourceGeneration: number,
  permissionMode?: PermissionMode,
): Promise<SessionCheckpoint> {
  const context = sessionCheckpointContext(sessionId);
  if (context === null) {
    throw new Error(`session not found: ${sessionId}`);
  }
  const repositories: SessionCheckpoint['repositories'] = [];
  for (const repo of sessionRepositories(sessionId)) {
    const head = await gitHead(repo.path);
    if (head === null) {
      throw new Error(`cannot resolve HEAD for ${repo.repositoryId} at ${repo.path}`);
    }
    repositories.push({ repositoryId: repo.repositoryId, commit: head });
  }
  const messages = (
    getDb()
      .prepare(
        `SELECT role, content FROM chat_messages
         WHERE thread_id = ? ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(context.threadId, CHECKPOINT_MAX_MESSAGES) as Array<{ role: string; content: string }>
  )
    .reverse()
    .map((m) => ({ role: m.role, content: m.content.slice(0, CHECKPOINT_MESSAGE_CHARS) }));
  return {
    sessionId,
    schemaVersion: 1,
    sourceGeneration,
    repositories,
    provider: context.provider,
    model: context.model ?? 'default',
    permissionMode: permissionMode ?? getCodexSession(sessionId)?.mode ?? 'on-request',
    messages,
    summary: messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .pop(),
    ...(context.planGoal === null ? {} : { planGoalState: context.planGoal }),
    artifactRefs: [],
    unresolvedApprovals: [],
  };
}

// ---- orchestration ---------------------------------------------------------

function handoffRpc<R>(
  operation: string,
  params: unknown,
  expected?: MeshHandoffContext,
): Promise<R> {
  const current = handoffContext();
  const ctx = expected ?? current;
  assertHandoffContext(ctx);
  return rpc<R>({ apiUrl: ctx.apiUrl }, operation, params, ctx.accessToken).then((r) => r.result);
}

function assertHandoffContext(expected: MeshHandoffContext): void {
  const current = handoffContext();
  if (
    current.enrollmentId !== expected.enrollmentId ||
    current.scope?.backendId !== expected.scope?.backendId ||
    current.scope?.accountId !== expected.scope?.accountId ||
    current.scope?.datasetEpoch !== expected.scope?.datasetEpoch
  )
    throw new Error('sync account changed during handoff');
}

async function prepareHandoffTarget(input: {
  handoffId: string;
  workspaceId: string;
  targetEnrollmentId: string;
  provider: AgentProvider;
  model?: string;
  permissionMode: PermissionMode;
  context: MeshHandoffContext;
}): Promise<JobCreateParams> {
  const requestId = `handoff-prepare:${input.handoffId}`;
  const params = await preparePrepareWorkspaceJob({
    requestId,
    workspaceId: input.workspaceId,
    targetEnrollmentId: input.targetEnrollmentId,
    provider: input.provider,
    model: input.model,
    permissionMode: input.permissionMode,
  });
  assertHandoffContext(input.context);
  journalJobRequest(input.handoffId, 'preparation', requestId, params);
  const job = await submitPreparedJob(params);
  assertHandoffContext(input.context);
  journalJobId(input.handoffId, 'preparation', job.id);
  await waitForPreparation(job.id, input.context);
  return params;
}

export type InitiateHandoffResult =
  | { ok: true; handoff: HandoffRecord }
  | { ok: false; blockers: HandoffBlocker[] };

/**
 * Source-side orchestration. Durable writes precede backend advances at
 * every step so a crash is reconstructable from the journal + ownership
 * rows, never from memory. Pre-transfer failure cancels and restores local
 * ownership; post-transfer failure marks the handoff failed and leaves the
 * target owning recovery.
 */
export function initiateHandoff(input: {
  sessionId: string;
  targetEnrollmentId: string;
  handoffId?: string;
}): Promise<InitiateHandoffResult> {
  const handoffId = input.handoffId ?? randomUUID();
  if (activeHandoffIds.has(handoffId)) throw new Error(`handoff already active: ${handoffId}`);
  activeHandoffIds.add(handoffId);
  return initiateHandoffWithId({ ...input, handoffId }).finally(() => {
    activeHandoffIds.delete(handoffId);
  });
}

async function initiateHandoffWithId(input: {
  sessionId: string;
  targetEnrollmentId: string;
  handoffId: string;
}): Promise<InitiateHandoffResult> {
  const readiness = await evaluateHandoffReadiness(input.sessionId);
  if (!readiness.ok) {
    return { ok: false, blockers: readiness.blockers };
  }
  const ctx = handoffContext();
  const ownership = readSessionOwnership(input.sessionId);
  if (ownership !== null && ownership.state !== 'owned') {
    throw new Error(`session-relinquished: ${input.sessionId} is not owned by this device`);
  }
  if (ownership !== null && ownership.owner_enrollment_id !== ctx.enrollmentId) {
    throw new Error(`session-not-owned: ${input.sessionId} is owned by another enrollment`);
  }
  const generation = ownership?.generation ?? 1;
  const handoffId = input.handoffId;
  const sourceContext = sessionCheckpointContext(input.sessionId);
  if (sourceContext?.workspaceId === null || sourceContext === null) {
    throw new Error('handoff session has no workspace mapping');
  }
  const activeSession = getCodexSession(input.sessionId);
  const provider = activeSession?.provider ?? sourceContext.provider;
  if (!isAgentProvider(provider)) {
    throw new Error(`handoff provider cannot start remotely: ${provider}`);
  }
  const model = getCodexSessionModel(input.sessionId) ?? sourceContext.model ?? 'default';
  const permissionMode = activeSession?.mode ?? 'on-request';
  const sourcePins = await captureSourceRepositoryPins(input.sessionId, sourceContext.workspaceId);
  const devices = await handoffRpc<DeviceListResult>('device.list', {}, ctx);
  const target = devices.devices.find((device) => device.enrollmentId === input.targetEnrollmentId);
  if (target === undefined || target.revoked)
    throw new Error('handoff target is not an active enrolled device');
  if (
    ctx.scope !== undefined &&
    deviceTrustState(ctx.scope, input.targetEnrollmentId) !== 'trusted'
  )
    throw new Error('handoff target device must be trusted before activation');
  if (target.enrollmentClass === 'ephemeral' && provider !== 'codex') {
    throw new Error('Cloud workers currently support Codex handoff sessions only.');
  }
  const authMode = target.enrollmentClass === 'ephemeral' ? 'codex-account' : 'target-local';

  journalHandoff(handoffId, input.sessionId, 'source', ctx);
  const created = await handoffRpc<HandoffCreateResult>(
    'handoff.create',
    {
      handoffId,
      sessionId: input.sessionId,
      sourceEnrollmentId: ctx.enrollmentId,
      targetEnrollmentId: input.targetEnrollmentId,
      sourceGeneration: generation,
    },
    ctx,
  );
  journalHandoffState(handoffId, created.handoff.state);
  if (created.handoff.state !== 'requested') {
    // Idempotent replay of an already-advanced handoff — rejoin the flow.
    return { ok: true, handoff: created.handoff };
  }
  if (ownership === null) {
    writeSessionOwnership(input.sessionId, generation, ctx.enrollmentId, 'owned');
  }

  const advance = (from: string, to: string, checkpoint?: SessionCheckpoint) => {
    // E2E: the checkpoint body is sealed under the ADK when this session
    // carries a sync scope; sessionId/sourceGeneration stay clear for the
    // backend's CAS assertions. Without a scope the legacy plaintext shape
    // is sent (self-host, or pre-key bootstrap).
    const wireCheckpoint: HandoffCheckpoint | undefined =
      checkpoint === undefined
        ? undefined
        : ctx.scope !== undefined
          ? {
              ...sealScopedJson(ctx.scope, `anvil/checkpoint/v1:${handoffId}`, checkpoint),
              sessionId: checkpoint.sessionId,
              sourceGeneration: checkpoint.sourceGeneration,
            }
          : checkpoint;
    return handoffRpc<HandoffAdvanceResult>(
      'handoff.advance',
      {
        handoffId,
        from,
        to,
        ...(wireCheckpoint === undefined ? {} : { checkpoint: wireCheckpoint }),
      },
      ctx,
    );
  };

  try {
    // The backend remains at `requested` until the target has actually
    // materialised this workspace at its pinned commits.
    const preparationRequest = await prepareHandoffTarget({
      handoffId,
      workspaceId: sourceContext.workspaceId,
      targetEnrollmentId: input.targetEnrollmentId,
      provider,
      model,
      permissionMode,
      context: ctx,
    });
    const preparationManifest = preparationRequest.inputManifest;
    for (const sourcePin of sourcePins) {
      const targetPin = preparationManifest.repositories.find(
        (repo) => repo.repositoryId === sourcePin.repositoryId,
      );
      if (targetPin?.commit !== sourcePin.commit)
        throw new Error(
          `target preparation does not match source HEAD: ${sourcePin.sourceRepositoryId}`,
        );
    }
    await assertSourceRepositoryPins(input.sessionId, sourcePins);
    journalActivationMetadata({
      handoffId,
      workspaceId: sourceContext.workspaceId,
      targetEnrollmentId: input.targetEnrollmentId,
      provider,
      model,
      permissionMode,
      authMode,
    });

    const prepared = await advance('requested', 'target-prepared-without-execution');
    journalHandoffState(handoffId, prepared.handoff.state);
    await assertSourceRepositoryPins(input.sessionId, sourcePins);

    // Durable reject-new-messages BEFORE interrupt/quiesce (spec ordering).
    writeSessionOwnership(input.sessionId, generation, ctx.enrollmentId, 'relinquished');
    const quiescing = await advance('target-prepared-without-execution', 'source-quiescing');
    journalHandoffState(handoffId, quiescing.handoff.state);

    // Interrupt any running turn, then verify child-process quiescence by
    // tearing the session process down — nothing left running means proven
    // stopped.
    interruptTurn(input.sessionId);
    await stopSessionAndWait(input.sessionId);

    const checkpoint = await captureSessionCheckpoint(input.sessionId, generation, permissionMode);
    assertCheckpointPins(checkpoint, sourcePins);
    journalSourceCheckpoint(handoffId, checkpoint);
    const activationRequestId = `handoff-start:${handoffId}`;
    const activationRequest = await prepareStartSessionJob({
      requestId: activationRequestId,
      workspaceId: sourceContext.workspaceId,
      targetEnrollmentId: input.targetEnrollmentId,
      provider,
      model,
      permissionMode,
      prompt: 'Continue the handed-off session using its checkpoint context.',
      handoffId,
      authMode,
      handoffCheckpoint: {
        ...checkpoint,
        repositories: sourcePins.map(({ repositoryId, commit }) => ({ repositoryId, commit })),
      },
      manifestPin: {
        workspaceDefinitionRevision: preparationManifest.workspaceDefinitionRevision,
        repositories: preparationManifest.repositories,
        bootstrapDigest: preparationManifest.bootstrapDigest,
      },
    });
    assertHandoffContext(ctx);
    journalJobRequest(handoffId, 'activation', activationRequestId, activationRequest);
    const relinquished = await advance(
      'source-quiescing',
      'source-relinquished-and-checkpointed',
      checkpoint,
    );
    journalHandoffState(handoffId, relinquished.handoff.state);

    // Post-transfer failures from here on must not restore ownership.
    const transferred = await advance(
      'source-relinquished-and-checkpointed',
      'ownership-transferred',
    );
    journalHandoffState(handoffId, transferred.handoff.state);
    try {
      assertHandoffContext(ctx);
      const activationJob = await submitPreparedJob(activationRequest);
      assertHandoffContext(ctx);
      journalJobId(handoffId, 'activation', activationJob.id);
      const preparationJobId = (
        getDb()
          .prepare('SELECT preparation_job_id FROM mesh_handoff_journal WHERE handoff_id = ?')
          .get(handoffId) as { preparation_job_id: string | null } | undefined
      )?.preparation_job_id;
      if (preparationJobId !== undefined && preparationJobId !== null) {
        adoptHandoffRemoteChat({
          handoffId,
          sourceSessionId: input.sessionId,
          workspaceId: sourceContext.workspaceId,
          targetEnrollmentId: input.targetEnrollmentId,
          provider,
          model,
          permissionMode,
          prepareJobId: preparationJobId,
          activationJobId: activationJob.id,
          activationRequestJson: JSON.stringify(activationRequest),
          credentialChoice: authMode,
        });
      }
    } catch {
      // The exact request is already in the journal. Boot reconciliation
      // replays it idempotently without restoring source ownership.
    }
    return { ok: true, handoff: transferred.handoff };
  } catch (error) {
    // Pre-transfer: the source never relinquished on the backend — cancel
    // the handoff and restore local ownership (proven-stopped resume under
    // still-valid ownership, spec §11).
    if (readSessionOwnership(input.sessionId)?.state === 'relinquished') {
      const row = getDb()
        .prepare('SELECT state FROM mesh_handoff_journal WHERE handoff_id = ?')
        .get(handoffId) as { state: string } | undefined;
      const preTransfer = row === undefined || row.state !== 'ownership-transferred';
      if (preTransfer) {
        writeSessionOwnership(input.sessionId, generation, ctx.enrollmentId, 'owned');
      }
    }
    await handoffRpc<HandoffCancelResult>('handoff.cancel', {
      handoffId,
      reason: 'source-failed',
    }).catch(() => undefined);
    journalHandoffState(handoffId, 'cancelled');
    throw error;
  }
}

/**
 * Boot reconciliation: local journal rows for non-terminal handoffs are
 * re-checked against the backend authority. A source whose handoff never
 * reached `ownership-transferred` and ended cancelled/failed resumes under
 * its still-valid ownership; post-transfer states keep the relinquish.
 */
export async function reconcileHandoffsOnBoot(): Promise<void> {
  const ctx = contextProvider?.() ?? null;
  if (ctx === null) return;
  const rows = getDb()
    .prepare(
      ctx.scope === undefined
        ? `SELECT handoff_id, session_id, role, state FROM mesh_handoff_journal
           WHERE state NOT IN ('completed', 'cancelled', 'failed')`
        : `SELECT handoff_id, session_id, role, state, backend_id, account_id, scope_epoch
           FROM mesh_handoff_journal j
           WHERE ((j.backend_id = ? AND j.account_id = ? AND j.scope_epoch = ?)
             OR (j.backend_id IS NULL AND j.account_id IS NULL AND j.scope_epoch IS NULL
               AND j.source_checkpoint_json IS NULL AND j.activation_request_json IS NULL))
             AND (j.state NOT IN ('completed', 'cancelled', 'failed')
              OR (j.state = 'completed' AND j.role = 'source'
                AND j.activation_request_json IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM remote_chats c WHERE c.handoff_id = j.handoff_id
                  AND c.backend_id = ? AND c.account_id = ? AND c.scope_epoch = ?
              )))`,
    )
    .all(
      ...(ctx.scope === undefined
        ? []
        : [
            ctx.scope.backendId,
            ctx.scope.accountId,
            ctx.scope.datasetEpoch,
            ctx.scope.backendId,
            ctx.scope.accountId,
            ctx.scope.datasetEpoch,
          ]),
    ) as HandoffJournalRow[];
  for (const row of rows) {
    if (activeHandoffIds.has(row.handoff_id)) continue;
    if (
      ctx.scope !== undefined &&
      row.backend_id !== null &&
      row.backend_id !== undefined &&
      (row.backend_id !== ctx.scope.backendId ||
        row.account_id !== ctx.scope.accountId ||
        row.scope_epoch !== ctx.scope.datasetEpoch)
    )
      continue;
    let remote: HandoffRecord;
    try {
      remote = (await handoffRpc<HandoffGetResult>('handoff.get', { handoffId: row.handoff_id }))
        .handoff;
    } catch {
      continue; // Backend unreachable — leave local state as-is.
    }
    journalHandoffState(row.handoff_id, remote.state);
    if (row.role !== 'source') continue;
    if (
      remote.state === 'source-quiescing' ||
      remote.state === 'source-relinquished-and-checkpointed'
    ) {
      const recovery = getDb()
        .prepare(
          `SELECT source_checkpoint_json, preparation_request_json, preparation_job_id,
                  activation_request_json, activation_workspace_id, activation_target_enrollment_id,
                  activation_provider, activation_model, activation_permission_mode, activation_auth_mode
           FROM mesh_handoff_journal WHERE handoff_id = ?`,
        )
        .get(row.handoff_id) as
        | {
            source_checkpoint_json: string | null;
            preparation_request_json: string | null;
            preparation_job_id: string | null;
            activation_request_json: string | null;
            activation_workspace_id: string | null;
            activation_target_enrollment_id: string | null;
            activation_provider: AgentProvider | null;
            activation_model: string | null;
            activation_permission_mode: PermissionMode | null;
            activation_auth_mode: 'target-local' | 'codex-account' | null;
          }
        | undefined;
      // source_checkpoint_json is written only after stopSessionAndWait
      // proves the source process group has exited. Without that durable
      // proof, recovery must leave source-quiescing untouched.
      if (
        recovery?.source_checkpoint_json !== null &&
        recovery?.source_checkpoint_json !== undefined &&
        recovery.preparation_request_json !== null &&
        recovery.preparation_job_id !== null &&
        recovery.activation_workspace_id !== null &&
        recovery.activation_target_enrollment_id !== null &&
        recovery.activation_provider !== null &&
        recovery.activation_model !== null &&
        recovery.activation_permission_mode !== null &&
        recovery.activation_auth_mode !== null
      ) {
        try {
          const checkpoint = JSON.parse(recovery.source_checkpoint_json) as SessionCheckpoint;
          const preparation = JSON.parse(recovery.preparation_request_json) as JobCreateParams;
          const activationRequestId = `handoff-start:${row.handoff_id}`;
          const activationRequest =
            recovery.activation_request_json === null
              ? await prepareStartSessionJob({
                  requestId: activationRequestId,
                  workspaceId: recovery.activation_workspace_id,
                  targetEnrollmentId: recovery.activation_target_enrollment_id,
                  provider: recovery.activation_provider,
                  model: recovery.activation_model,
                  permissionMode: recovery.activation_permission_mode,
                  prompt: 'Continue the handed-off session using its checkpoint context.',
                  handoffId: row.handoff_id,
                  authMode: recovery.activation_auth_mode,
                  handoffCheckpoint: {
                    ...checkpoint,
                    repositories: preparation.inputManifest.repositories.map(
                      ({ repositoryId, commit }) => ({
                        repositoryId,
                        commit,
                      }),
                    ),
                  },
                  manifestPin: {
                    workspaceDefinitionRevision:
                      preparation.inputManifest.workspaceDefinitionRevision,
                    repositories: preparation.inputManifest.repositories,
                    bootstrapDigest: preparation.inputManifest.bootstrapDigest,
                  },
                })
              : (JSON.parse(recovery.activation_request_json) as JobCreateParams);
          journalJobRequest(row.handoff_id, 'activation', activationRequestId, activationRequest);
          if (remote.state === 'source-quiescing') {
            const checkpointed = await handoffRpc<HandoffAdvanceResult>(
              'handoff.advance',
              {
                handoffId: row.handoff_id,
                from: 'source-quiescing',
                to: 'source-relinquished-and-checkpointed',
                checkpoint:
                  ctx.scope === undefined
                    ? checkpoint
                    : {
                        ...sealScopedJson(
                          ctx.scope,
                          `anvil/checkpoint/v1:${row.handoff_id}`,
                          checkpoint,
                        ),
                        sessionId: checkpoint.sessionId,
                        sourceGeneration: checkpoint.sourceGeneration,
                      },
              },
              ctx,
            );
            journalHandoffState(row.handoff_id, checkpointed.handoff.state);
          }
          remote = (
            await handoffRpc<HandoffAdvanceResult>(
              'handoff.advance',
              {
                handoffId: row.handoff_id,
                from: 'source-relinquished-and-checkpointed',
                to: 'ownership-transferred',
              },
              ctx,
            )
          ).handoff;
          journalHandoffState(row.handoff_id, remote.state);
        } catch {
          continue;
        }
      } else {
        continue;
      }
    }
    const transferred =
      remote.targetGeneration !== null ||
      remote.state === 'ownership-transferred' ||
      remote.state === 'target-activating' ||
      remote.state === 'completed';
    const ownership = readSessionOwnership(row.session_id);
    if (transferred) {
      const activation = getDb()
        .prepare(
          `SELECT activation_request_json, activation_job_id, preparation_job_id,
                  activation_workspace_id, activation_target_enrollment_id, activation_provider,
                  activation_model, activation_permission_mode, activation_auth_mode
           FROM mesh_handoff_journal WHERE handoff_id = ?`,
        )
        .get(row.handoff_id) as
        | {
            activation_request_json: string | null;
            activation_job_id: string | null;
            preparation_job_id: string | null;
            activation_workspace_id: string | null;
            activation_target_enrollment_id: string | null;
            activation_provider: AgentProvider | null;
            activation_model: string | null;
            activation_permission_mode: PermissionMode | null;
            activation_auth_mode: 'target-local' | 'codex-account' | null;
          }
        | undefined;
      if (activation?.activation_request_json != null) {
        try {
          let activationJobId = activation.activation_job_id;
          if (activationJobId === null) {
            const job = await submitPreparedJob(
              JSON.parse(activation.activation_request_json) as JobCreateParams,
            );
            activationJobId = job.id;
            journalJobId(row.handoff_id, 'activation', job.id);
          }
          if (
            activationJobId !== null &&
            activation.preparation_job_id !== null &&
            activation.activation_workspace_id !== null &&
            activation.activation_target_enrollment_id !== null &&
            activation.activation_provider !== null &&
            activation.activation_model !== null &&
            activation.activation_permission_mode !== null &&
            activation.activation_auth_mode !== null
          ) {
            adoptHandoffRemoteChat({
              handoffId: row.handoff_id,
              sourceSessionId: row.session_id,
              workspaceId: activation.activation_workspace_id,
              targetEnrollmentId: activation.activation_target_enrollment_id,
              provider: activation.activation_provider,
              model: activation.activation_model,
              permissionMode: activation.activation_permission_mode,
              prepareJobId: activation.preparation_job_id,
              activationJobId,
              activationRequestJson: activation.activation_request_json,
              credentialChoice: activation.activation_auth_mode,
            });
          }
        } catch {
          // Keep the exact request for a later Ready reconciliation.
        }
      }
    }
    if (
      !transferred &&
      (remote.state === 'cancelled' || remote.state === 'failed') &&
      ownership !== null &&
      ownership.state === 'relinquished' &&
      ownership.owner_enrollment_id === ctx.enrollmentId
    ) {
      // Proven-stopped source resumes under its still-valid generation.
      writeSessionOwnership(row.session_id, ownership.generation, ctx.enrollmentId, 'owned');
    }
  }
}
