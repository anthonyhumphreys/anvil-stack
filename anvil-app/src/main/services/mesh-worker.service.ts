import { bootstrapCommandArgv } from './bootstrap-runner.service.js';
import { executeMeshCommand } from './mesh-command.service.js';
// MESH-02: device-local worker runtime.
//
// Sync enrollment does not authorize Mesh. A device opts in locally via
// `setMeshWorkerEnabled(true)`, which publishes a `device.policy` whose
// worker section allows jobs; every backend worker.* op fails closed
// without it. The worker maintains a leased incarnation via periodic
// `worker.connect`, publishes capabilities, claims `job.available` work,
// writes a local attempt journal BEFORE doing any work (spec §9), renews
// attempt leases on the 30s cadence, and reports fenced outcomes.
//
// This module never imports sync-runtime: the runtime injects a context
// provider (apiUrl + token + enrollment) via `configureMeshWorkerContext`
// and calls the lifecycle hooks below on enable/disable/frame events.

import {
  bootstrapManifestPolicy,
  constrainPermissionMode,
  isPermissionMode,
  permissionSandbox,
  type PermissionMode,
} from '../../../cloud/contract/permissions.js';
import {
  effectiveMeshPermissionMode,
  getMeshMaximumPermissionMode,
  requestedMeshPermissionMode,
} from './mesh-permissions.service.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, totalmem } from 'node:os';
import { getDb } from '../db/database.js';
import { join } from 'node:path';
import { relative, sep } from 'node:path';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { uploadAttemptArtifact } from './mesh-artifact.service.js';
import { startWorkspaceClone } from './workspace-materialization.service.js';
import { boundedRemoteAssistantOutput } from './mesh-session-output.js';
import {
  installTaskWorkspaceDefinition,
  remoteWorkspaceDefinition,
} from './mesh-workspace-input.service.js';
import {
  probeSessionCli,
  runRemoteSessionTurn,
  satisfiesCliMin,
  type RemoteSessionProvider,
} from './mesh-session.service.js';
import { commonParentDir } from './codex-protocol.service.js';
import { resolveSessionModel } from './codex-session.service.js';
import { getSettings } from './settings.service.js';
import { writeSessionOwnership } from './mesh-ownership.service.js';
import { interruptBrowserWorkspaceTurnsAbove } from './browser-session-ownership.service.js';
import {
  allocateAttemptWorktrees,
  createAttemptBundle,
  finalizeAttemptWorktrees,
  runVerificationCommand,
} from './mesh-worktree.service.js';
import type {
  HandoffAdvanceResult,
  HandoffCheckpoint,
  HandoffGetResult,
  SessionCheckpoint,
} from '../../../cloud/contract/handoff.js';
import { isSealedCheckpoint } from '../../../cloud/contract/handoff.js';
import {
  listDeviceIdentities,
  mintTaskKey,
  sealTaskInputs,
  sealTaskKeyWrap,
  sealTaskResult,
  storeTaskKey,
  taskKeyFor,
  unsealCredentialGrant,
  unsealScopedJson,
  unsealTaskInputs,
  unsealTaskKeyWrap,
} from './sync-keyring.service.js';
import type {
  CredentialPullResult,
  SealedTaskPayload,
  TaskKeyDeliverResult,
  TaskKeyPullResult,
  TaskKeyWrapPayload,
} from '../../../cloud/contract/sealed.js';
import type { SyncScope } from '../../shared/sync-mesh.js';
import { workspaceDefinitionRevision } from './sync-entity-domain.js';
import type { AgentProvider, ReasoningEffort } from '../../shared/types.js';
import {
  computeBootstrapDigest,
  getWorkspaceBootstrap,
  recordBootstrapApproval,
  resolveWorkspaceCommits,
  startBootstrapRun,
  workspaceCheckoutRoot,
} from './bootstrap-policy.service.js';
import { LEASE_RENEW_INTERVAL_MS } from '../../../cloud/contract/version.js';
import { canonicalJson } from './sync-persistence.service.js';
import { rpc as backendRpc, BackendRpcError } from './sync-backend-client.service.js';
import type {
  DevicePolicy,
  WorkerCapabilities,
  WorkerConnectResult,
} from '../../../cloud/contract/workers.js';
import type {
  ApprovalDecision,
  ApprovalRecord,
  AttemptRenewResult,
  AttemptResultManifest,
  CapabilityRequirements,
  ExecutionAttempt,
  ExecutionManifest,
  JobClaimResult,
  JobCreateParams,
  JobGetResult,
  JobListResult,
  JobSummary,
  MeshJob,
  RequestedTarget,
  ResultManifestVerification,
} from '../../../cloud/contract/jobs.js';
import {
  EVENT_APPEND_MAX_BYTES,
  EVENT_APPEND_MAX_EVENTS,
  type EventAppendParams,
  type EventAppendResult,
} from '../../../cloud/contract/jobs.js';
import type { ActivityPayload } from '../../../cloud/contract/socket.js';
import {
  EPHEMERAL_ENV_CAPABILITY,
  isEnvironmentProviderId,
  type EnvironmentProviderId,
  type ProvisionEnvironmentInputs,
} from '../../../cloud/contract/environment.js';
import {
  provisionCapabilities,
  provisionEnvironment,
  reapExpiredEnvironments,
  type ProvisionerScope,
} from './cloud-environment.service.js';

export type { MeshWorkerStatus } from '../../shared/sync-runtime.js';
import type { MeshWorkerStatus } from '../../shared/sync-runtime.js';

interface MeshWorkerContext {
  apiUrl: string;
  backendUrl?: string;
  accessToken: string;
  enrollmentId: string;
  /** Sync scope for E2E unsealing (handoff checkpoints); optional. */
  scope?: SyncScope;
  /** userData root for worker-managed checkouts (mesh-checkouts/*). */
  userDataDir?: string;
  /**
   * Sends a frame on the account's live socket when one is connected.
   * Activity frames are an accelerator — the durable journal is the record —
   * so a null sender (socket down) just skips emission.
   */
  sendFrame?: (frame: unknown) => void;
  /** Publishes one durable attempt state transition over the direct host stream. */
  publishAttemptLifecycle?: (input: {
    attemptId: string;
    jobId: string;
    outcome: 'completed' | 'failed';
    status: string;
  }) => void;
  /**
   * True while the account socket is live. Control-channel sends (approval
   * requests) must NOT silently drop — callers check this and fail closed.
   */
  isLive?: () => boolean;
  /**
   * ENV-03: mints an ephemeral-class enrollment code for a cloud
   * environment. The code is authentication-only — environments receive
   * task-scoped keys via `taskkey.*` wraps, never account key material.
   */
  mintEnvironmentCode?: (options: {
    provider: string;
    ttlSeconds: number;
    environmentId: string;
    displayName?: string;
  }) => Promise<string | null>;
}

interface AttemptRow {
  id: string;
  job_id: string;
  enrollment_id: string;
  incarnation: string;
  fence: number;
  kind: string;
  state: string;
  manifest_json: string;
  journal_json: string;
  result_json: string | null;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
}

interface WorkerStateRow {
  enabled: number;
  incarnation: string | null;
  lease_expires_at: string | null;
  connected_at: string | null;
  last_error: string | null;
}

let contextProvider: (() => MeshWorkerContext | null) | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let connectInFlight: Promise<void> | null = null;
let policyPublishPending = false;

const DEFAULT_MAX_CONCURRENT_JOBS = 1;
const WORKER_CAPABILITIES = [
  'diagnostic',
  'prepare-workspace',
  'start-session',
  'code-task',
  'workflow-node',
];

export function configureMeshWorkerContext(provider: () => MeshWorkerContext | null): void {
  contextProvider = provider;
}

function workerContext(): MeshWorkerContext | null {
  return contextProvider?.() ?? null;
}

/**
 * ENV-04/05/09: when this process IS a cloud environment, the anvil-worker
 * image boot exports `ANVIL_ENVIRONMENT_ID` + `ANVIL_ENVIRONMENT_PROVIDER`
 * so the worker advertises `ephemeral-env` and self-reports `enrolled`
 * (image contract: docs/plans/sync-mesh/cloud-environments.md). The env's
 * pairing code is already bound to the environment record, so the backend
 * authorizes the report — the env vars only *describe* identity, never
 * authorize it.
 */
function environmentBinding(): { environmentId: string; provider: EnvironmentProviderId } | null {
  const environmentId = process.env['ANVIL_ENVIRONMENT_ID'];
  const provider = process.env['ANVIL_ENVIRONMENT_PROVIDER'];
  if (
    typeof environmentId !== 'string' ||
    environmentId.length === 0 ||
    !isEnvironmentProviderId(provider)
  ) {
    return null;
  }
  return { environmentId, provider };
}

/** ENV-01: the worker's sync scope as a provisioner scope, when present. */
function provisionerScope(): ProvisionerScope | null {
  const ctx = workerContext();
  if (ctx?.scope === undefined) return null;
  return {
    backendId: ctx.scope.backendId,
    accountId: ctx.scope.accountId,
    enrollmentId: ctx.enrollmentId,
    apiUrl: ctx.apiUrl,
    ...(ctx.backendUrl === undefined ? {} : { backendUrl: ctx.backendUrl }),
    accessToken: ctx.accessToken,
  };
}

async function meshRpc<T>(operation: string, params: unknown): Promise<T> {
  const ctx = workerContext();
  if (ctx === null) {
    throw new Error('Mesh worker has no active sync session.');
  }
  const { result } = await backendRpc<T>(
    { apiUrl: ctx.apiUrl },
    operation,
    params,
    ctx.accessToken,
  );
  return result;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---- durable worker state -------------------------------------------------

function readWorkerState(): WorkerStateRow {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mesh_worker_state WHERE id = 1').get() as
    | WorkerStateRow
    | undefined;
  return (
    row ?? {
      enabled: 0,
      incarnation: null,
      lease_expires_at: null,
      connected_at: null,
      last_error: null,
    }
  );
}

function writeWorkerState(patch: Partial<WorkerStateRow>): void {
  const db = getDb();
  const current = readWorkerState();
  const next = { ...current, ...patch };
  db.prepare(
    `INSERT INTO mesh_worker_state (
       id, enabled, incarnation, lease_expires_at, connected_at, last_error, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       incarnation = excluded.incarnation,
       lease_expires_at = excluded.lease_expires_at,
       connected_at = excluded.connected_at,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  ).run(
    next.enabled,
    next.incarnation,
    next.lease_expires_at,
    next.connected_at,
    next.last_error,
    nowIso(),
  );
}

// ---- attempt journal ------------------------------------------------------

function appendJournal(attemptId: string, event: string, detail?: Record<string, unknown>): void {
  const db = getDb();
  const row = db.prepare('SELECT journal_json FROM mesh_attempts WHERE id = ?').get(attemptId) as
    | { journal_json: string }
    | undefined;
  if (!row) return;
  const journal = JSON.parse(row.journal_json) as unknown[];
  journal.push({ at: nowIso(), event, ...(detail !== undefined ? { detail } : {}) });
  db.prepare('UPDATE mesh_attempts SET journal_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(journal),
    nowIso(),
    attemptId,
  );
}

function updateAttemptState(
  attemptId: string,
  state: string,
  patch?: { resultJson?: string | null; cancelRequested?: boolean },
): void {
  const db = getDb();
  db.prepare(
    `UPDATE mesh_attempts SET state = ?, result_json = COALESCE(?, result_json),
       cancel_requested = MAX(cancel_requested, ?), updated_at = ? WHERE id = ?`,
  ).run(
    state,
    patch?.resultJson ?? null,
    patch?.cancelRequested === true ? 1 : 0,
    nowIso(),
    attemptId,
  );
}

function activeAttempts(): AttemptRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM mesh_attempts
       WHERE state IN ('claimed', 'preparing', 'running', 'stopping')`,
    )
    .all() as AttemptRow[];
}

// ---- lifecycle ------------------------------------------------------------

export function isMeshWorkerEnabled(): boolean {
  return readWorkerState().enabled === 1;
}

export function getMeshWorkerStatus(): MeshWorkerStatus {
  const state = readWorkerState();
  const live =
    state.incarnation !== null &&
    state.lease_expires_at !== null &&
    Date.parse(state.lease_expires_at) > Date.now();
  return {
    enabled: state.enabled === 1,
    maxPermissionMode: getMeshMaximumPermissionMode(),
    connected: live,
    workerIncarnation: state.incarnation,
    leaseExpiresAt: state.lease_expires_at,
    activeAttempts: activeAttempts().length,
    lastError: state.last_error,
  };
}

/**
 * Local opt-in. Enabling publishes an allowing device policy (fail-closed:
 * the backend rejects worker.* ops without it), connects the incarnation,
 * and publishes capabilities. Disabling publishes `allowJobs: false`, stops
 * the heartbeat, and drops the local incarnation record — in-flight local
 * attempt rows keep their journals for inspection.
 */
export async function setMeshWorkerEnabled(enabled: boolean): Promise<MeshWorkerStatus> {
  if (!enabled) {
    stopHeartbeat();
    try {
      await meshRpc('device.policy.publish', {
        worker: { allowJobs: false },
      } satisfies DevicePolicy);
    } catch {
      // Best effort: the lease expires on its own within WORKER_LEASE_MS.
    }
    // Opt-out with in-flight work: the attempt leases are now unwinnable
    // (deny policy + dropped incarnation), so fence them off locally rather
    // than leaving them marked running forever.
    for (const attempt of activeAttempts()) {
      appendJournal(attempt.id, 'worker-disabled');
      updateAttemptState(attempt.id, 'unknown-outcome');
    }
    writeWorkerState({
      enabled: 0,
      incarnation: null,
      lease_expires_at: null,
      connected_at: null,
    });
    return getMeshWorkerStatus();
  }

  writeWorkerState({ enabled: 1, last_error: null });
  // Arm before connect: if the first connect fails (offline, policy lag),
  // the 30s tick retries instead of leaving the worker enabled-but-dead.
  armHeartbeat();
  try {
    await publishWorkerPolicy();
    await connectWorker();
  } catch (error) {
    writeWorkerState({ last_error: error instanceof Error ? error.message : String(error) });
    if (!(error instanceof BackendRpcError) || !error.retryable) throw error;
  }
  return getMeshWorkerStatus();
}

/**
 * The effective execution policy this device enforces — also the policy
 * input bootstrap digests commit to (WS-03 approval pins).
 */
export function buildDevicePolicy(): DevicePolicy {
  return {
    worker: {
      ...bootstrapManifestPolicy().worker,
      maxPermissionMode: getMeshMaximumPermissionMode(),
    },
  };
}

export async function setMeshMaximumPermissionMode(
  mode: PermissionMode,
): Promise<MeshWorkerStatus> {
  if (!isPermissionMode(mode)) throw new Error('Invalid Mesh permission mode.');
  const previous = getMeshMaximumPermissionMode();
  if (mode === previous) return getMeshWorkerStatus();
  getDb()
    .prepare(
      `INSERT INTO mesh_worker_state (id, enabled, max_permission_mode, updated_at)
    VALUES (1, 0, ?, ?) ON CONFLICT(id) DO UPDATE SET max_permission_mode = excluded.max_permission_mode, updated_at = excluded.updated_at`,
    )
    .run(mode, nowIso());
  // A downgrade stops active attempts; no running provider may retain greater access.
  if (constrainPermissionMode(previous, mode) !== previous) {
    interruptBrowserWorkspaceTurnsAbove(mode);
    const attempts = activeAttempts();
    for (const attempt of attempts)
      updateAttemptState(attempt.id, attempt.state, { cancelRequested: true });
    for (const attempt of attempts) {
      try {
        await meshRpc('job.cancel', { jobId: attempt.job_id });
      } catch {
        appendJournal(attempt.id, 'permission-cancel-pending');
      }
    }
  }
  policyPublishPending = true;
  if (isMeshWorkerEnabled()) {
    try {
      await publishWorkerPolicy();
    } catch (error) {
      writeWorkerState({
        last_error: `Permission mode saved locally; policy publication failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return getMeshWorkerStatus();
}

async function publishWorkerPolicy(): Promise<void> {
  await meshRpc('device.policy.publish', buildDevicePolicy());
  policyPublishPending = false;
}

function buildCapabilities(): WorkerCapabilities {
  // ENV-03: `provision:<provider>` per stored provider connection so
  // provision-environment jobs route here via kind:'auto' placement.
  const scope = provisionerScope();
  const provisionCaps = scope === null ? [] : provisionCapabilities(scope);
  // ENV-09: a cloud environment advertises itself so grants/env-targeted
  // placement can recognize ephemeral capacity.
  const envCaps = environmentBinding() === null ? [] : [EPHEMERAL_ENV_CAPABILITY];
  return {
    os: platform(),
    arch: process.arch,
    memoryMb: Math.round(totalmem() / (1024 * 1024)),
    capabilities: [...WORKER_CAPABILITIES, ...envCaps, ...provisionCaps],
    maxConcurrentJobs: DEFAULT_MAX_CONCURRENT_JOBS,
  };
}

/**
 * Registers or refreshes the worker incarnation, then publishes capabilities
 * on a fresh incarnation. Called on enable, on each heartbeat while the
 * lease is live, and lazily after expiry (a fresh incarnation is minted).
 */
async function connectWorker(): Promise<void> {
  // Coalesce concurrent connects (enable path vs sync-ready transition) onto
  // one flight so an awaited caller can't observe a half-connected state.
  connectInFlight ??= doConnectWorker().finally(() => {
    connectInFlight = null;
  });
  await connectInFlight;
}

async function doConnectWorker(): Promise<void> {
  try {
    const hadIncarnation = readWorkerState().incarnation;
    const result = await meshRpc<WorkerConnectResult>('worker.connect', {});
    writeWorkerState({
      incarnation: result.workerIncarnation,
      lease_expires_at: result.leaseExpiresAt,
      connected_at: nowIso(),
      last_error: null,
    });
    if (result.workerIncarnation !== hadIncarnation) {
      await meshRpc('worker.capabilities.publish', buildCapabilities());
      // ENV-09: a cloud environment links its enrollment to the environment
      // record — this is the self-report that resolves env-targeted jobs.
      // The report must not break the connect: enrollment is already done.
      const binding = environmentBinding();
      const ctx = workerContext();
      if (binding !== null && ctx !== null) {
        await meshRpc('environment.report', {
          environmentId: binding.environmentId,
          provider: binding.provider,
          state: 'enrolled',
          enrollmentId: ctx.enrollmentId,
        }).catch(() => undefined);
      }
      // A fresh incarnation means the backend forgot prior lease state; any
      // local attempt rows still marked active are stale — mark them for
      // inspection rather than assuming the backend still honors them.
      for (const attempt of activeAttempts()) {
        appendJournal(attempt.id, 'incarnation-expired', {
          previousIncarnation: attempt.incarnation,
        });
        updateAttemptState(attempt.id, 'unknown-outcome');
      }
    }
  } catch (error) {
    writeWorkerState({
      last_error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Called by the runtime when sync becomes enabled / the channel goes live. */
export function meshWorkerOnSyncReady(): void {
  if (!isMeshWorkerEnabled()) return;
  for (const attemptId of activityAppendQueues.keys()) void flushActivityAppend(attemptId);
  void publishWorkerPolicy()
    .then(() => connectWorker())
    .then(() => publishReplicas())
    .then(() => sweepClaimableJobs())
    // ENV-03: reclaim environments whose TTL lapsed while this provisioner
    // was offline; the backend marks `reap-requested`, the worker terminates.
    .then(() => {
      const scope = provisionerScope();
      return scope === null ? undefined : reapExpiredEnvironments(scope);
    })
    .catch(() => undefined);
  armHeartbeat();
}

/**
 * Durable catch-up for missed `job.available` frames: on connect, claim any
 * queued job already targeted at this enrollment. The socket accelerates;
 * this read is the recovery path.
 */
async function sweepClaimableJobs(): Promise<void> {
  const ctx = workerContext();
  const state = readWorkerState();
  if (ctx === null || state.incarnation === null) return;
  let result: JobListResult;
  try {
    result = await meshRpc<JobListResult>('job.list', { state: 'queued', limit: 20 });
  } catch {
    return;
  }
  for (const job of result.jobs) {
    if (job.targetEnrollmentId !== ctx.enrollmentId) continue;
    if (activeAttempts().length >= DEFAULT_MAX_CONCURRENT_JOBS) return;
    await handleJobAvailable(job.id).catch(() => undefined);
  }
}

/** Called when sync is disabled, the session is lost, or the backend changes. */
export function meshWorkerOnSyncGone(): void {
  stopHeartbeat();
  // enabled stays set — the worker re-arms on the next ready transition.
  writeWorkerState({ incarnation: null, lease_expires_at: null });
  clearActivityAppendQueues();
}

function clearActivityAppendQueues(): void {
  for (const queue of activityAppendQueues.values()) {
    if (queue.timer !== null) clearTimeout(queue.timer);
  }
  activityAppendQueues.clear();
}

function armHeartbeat(): void {
  if (heartbeatTimer !== null) return;
  heartbeatTimer = setInterval(() => {
    void heartbeat().catch(() => undefined);
  }, LEASE_RENEW_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer === null) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function heartbeat(): Promise<void> {
  if (!isMeshWorkerEnabled()) {
    stopHeartbeat();
    return;
  }
  if (policyPublishPending) await publishWorkerPolicy();
  const state = readWorkerState();
  const leaseExpiry = state.lease_expires_at !== null ? Date.parse(state.lease_expires_at) : 0;
  if (state.incarnation === null || leaseExpiry - Date.now() < LEASE_RENEW_INTERVAL_MS) {
    if (state.incarnation === null) await publishWorkerPolicy();
    await connectWorker();
  }
  await renewActiveAttempts();
}

// ---- replicas --------------------------------------------------------------

/**
 * Publishes coarse replica readiness for local workspace definitions.
 * Metadata only — workspace ids, the canonical definition revision (content
 * digest, identical on every converged replica), and a readiness enum;
 * paths and local config never leave the device.
 */
export async function publishReplicas(): Promise<void> {
  if (!isMeshWorkerEnabled() || readWorkerState().incarnation === null) return;
  const db = getDb();
  const rows = db
    .prepare(`SELECT w.id AS workspace_id, w.definition_state FROM workspaces w`)
    .all() as Array<{ workspace_id: string; definition_state: string }>;
  const observedAt = nowIso();
  const replicas = rows.flatMap((row) => {
    const definitionRevision = workspaceDefinitionRevision(row.workspace_id);
    if (definitionRevision === null) return [];
    return [
      {
        workspaceId: row.workspace_id,
        definitionRevision,
        readiness: row.definition_state === 'ready' ? ('ready' as const) : ('not-ready' as const),
        observedAt,
      },
    ];
  });
  if (replicas.length === 0) return;
  await meshRpc('worker.replica.publish', { replicas });
}

// ---- jobs ------------------------------------------------------------------

/**
 * `job.available` frame handler. Claims are serialized through the
 * heartbeat-owned incarnation; capacity is re-checked against the local
 * active-attempt count before claiming.
 */
export async function handleJobAvailable(jobId: string): Promise<void> {
  if (!isMeshWorkerEnabled()) return;
  const state = readWorkerState();
  if (state.incarnation === null) return;
  if (activeAttempts().length >= DEFAULT_MAX_CONCURRENT_JOBS) return;

  let claimed: JobClaimResult;
  try {
    claimed = await meshRpc<JobClaimResult>('job.claim', { jobId });
  } catch (error) {
    // Raced out, expired, cancelled, or policy-changed — not claimable by us.
    if (error instanceof BackendRpcError) return;
    throw error;
  }
  const job = claimed.job;
  const attempt = claimed.attempt;

  // Local attempt journal BEFORE any work starts (spec §9): a crash between
  // claim and execution is reconstructable from this row. The job's sealed
  // input envelope rides along so a restarted attempt can still unseal
  // without re-claiming.
  const db = getDb();
  db.prepare(
    `INSERT INTO mesh_attempts (
       id, job_id, enrollment_id, incarnation, fence, kind, state,
       manifest_json, journal_json, sealed_inputs_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?)`,
  ).run(
    attempt.id,
    job.id,
    workerContext()?.enrollmentId ?? '',
    attempt.workerIncarnation,
    attempt.fence,
    job.kind,
    JSON.stringify(claimed.manifest),
    JSON.stringify([{ at: nowIso(), event: 'claimed', detail: { fence: attempt.fence } }]),
    claimed.sealedInputs === undefined ? null : JSON.stringify(claimed.sealedInputs),
    nowIso(),
    nowIso(),
  );

  await runAttempt(attempt, job);
}

async function renewActiveAttempts(): Promise<void> {
  const active = activeAttempts();
  if (active.length === 0) return;
  const result = await meshRpc<AttemptRenewResult>('attempt.renew', {
    renewals: active.map((a) => ({
      attemptId: a.id,
      incarnation: a.incarnation,
      fence: a.fence,
    })),
  });
  const activeById = new Map(active.map((attempt) => [attempt.id, attempt]));
  for (const item of result.results) {
    if (item.status === 'rejected') {
      appendJournal(item.attemptId, 'lease-renewal-rejected', { reason: item.reason });
      updateAttemptState(item.attemptId, 'unknown-outcome');
      continue;
    }
    // The renewal response is a durable catch-up of the owning job's cancel
    // decision under the same attempt/incarnation/fence check. It replaces
    // the former extra job.get for every active attempt without changing the
    // 30-second lease cadence.
    const cancelRequested = item.cancelRequested;
    const attempt = activeById.get(item.attemptId);
    if (cancelRequested === true && attempt !== undefined && attempt.cancel_requested !== 1) {
      appendJournal(item.attemptId, 'cancel-requested');
      updateAttemptState(item.attemptId, 'stopping', { cancelRequested: true });
    }
  }
}

/**
 * ENV-06: unsealed per-attempt grant env vars, held in memory only for the
 * attempt's lifetime — pulled after claim (fence known), injected into the
 * provider spawn env, and dropped when the attempt goes terminal. Grants
 * are never journaled; only counts and rejections are.
 */
const attemptGrantEnv = new Map<string, Record<string, string>>();
const attemptCodexHostAuthJson = new Map<string, string>();
interface RemoteProviderAuth {
  provider: AgentProvider;
  env: Record<string, string>;
  devinCredentialsToml?: string;
}
const attemptProviderAuth = new Map<string, RemoteProviderAuth>();

const PROVIDER_AUTH_ENV: Partial<Record<AgentProvider, readonly string[]>> = {
  cursor: ['CURSOR_API_KEY'],
  openai: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  llmgateway: ['LLMGATEWAY_API_KEY', 'LLMGATEWAY_BILLING_MODE'],
  azure: [
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_API_VERSION',
    'AZURE_OPENAI_DEPLOYMENT',
  ],
  devin: [],
};
const PROVIDER_AUTH_REQUIRED_ENV: Partial<Record<AgentProvider, readonly string[]>> = {
  cursor: ['CURSOR_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  llmgateway: ['LLMGATEWAY_API_KEY'],
  azure: [
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_API_VERSION',
    'AZURE_OPENAI_DEPLOYMENT',
  ],
};

async function pullCredentialGrants(attempt: ExecutionAttempt): Promise<void> {
  const ctx = workerContext();
  if (ctx === null || ctx.scope === undefined) return;
  try {
    const { grants } = await meshRpc<CredentialPullResult>('credential.pull', {
      attemptId: attempt.id,
      fence: attempt.fence,
    });
    if (grants.length === 0) return;
    const merged: Record<string, string> = {};
    let applied = 0;
    for (const grant of grants) {
      // Binding fields must match the live attempt before we even try the
      // seal — a grant for a different fence/target is not ours to open.
      if (
        grant.jobId !== attempt.jobId ||
        grant.attemptId !== attempt.id ||
        grant.fence !== attempt.fence ||
        grant.targetEnrollmentId !== ctx.enrollmentId ||
        !Number.isFinite(Date.parse(grant.expiresAt)) ||
        Date.parse(grant.expiresAt) <= Date.now()
      ) {
        appendJournal(attempt.id, 'credential-grant-rejected', {
          reason: 'binding-or-expiry-mismatch',
        });
        continue;
      }
      const inner = unsealCredentialGrant(ctx.scope, ctx.enrollmentId, grant);
      if (inner === null) {
        appendJournal(attempt.id, 'credential-grant-rejected', { reason: 'unseal-failed' });
        continue;
      }
      if (inner.kind === 'credential-name') {
        for (const [name, value] of Object.entries(inner.env)) {
          merged[name] = value;
        }
        applied += 1;
      } else if (
        inner.kind === 'remote-codex-api-key' &&
        typeof inner.env.OPENAI_API_KEY === 'string' &&
        inner.env.OPENAI_API_KEY.length > 0
      ) {
        merged.OPENAI_API_KEY = inner.env.OPENAI_API_KEY;
        applied += 1;
      } else if (
        inner.kind === 'remote-codex-host-auth' &&
        typeof inner.codexAuthJson === 'string' &&
        inner.codexAuthJson.length > 0
      ) {
        attemptCodexHostAuthJson.set(attempt.id, inner.codexAuthJson);
        applied += 1;
      } else if (
        inner.kind === 'remote-provider-auth' &&
        inner.provider !== undefined &&
        PROVIDER_AUTH_ENV[inner.provider] !== undefined
      ) {
        const allowed = PROVIDER_AUTH_ENV[inner.provider]!;
        const env = inner.env as Record<string, string>;
        const hasInvalidEnv = Object.entries(env).some(
          ([name, value]) => !allowed.includes(name) || value.length === 0,
        );
        const missingRequiredEnv = (PROVIDER_AUTH_REQUIRED_ENV[inner.provider] ?? []).some(
          (name) => typeof env[name] !== 'string' || env[name]!.length === 0,
        );
        const invalidGatewayBillingMode =
          inner.provider === 'llmgateway' &&
          env.LLMGATEWAY_BILLING_MODE !== undefined &&
          env.LLMGATEWAY_BILLING_MODE !== 'devpass' &&
          env.LLMGATEWAY_BILLING_MODE !== 'payg';
        const isDevin = inner.provider === 'devin';
        const credentials = inner.devinCredentialsToml;
        if (
          !hasInvalidEnv &&
          !missingRequiredEnv &&
          !invalidGatewayBillingMode &&
          ((isDevin &&
            Object.keys(env).length === 0 &&
            typeof credentials === 'string' &&
            credentials.length > 0) ||
            (!isDevin && credentials === undefined && Object.keys(env).length > 0))
        ) {
          const previous = attemptProviderAuth.get(attempt.id);
          if (
            previous === undefined ||
            (previous.provider === inner.provider &&
              JSON.stringify(previous.env) === JSON.stringify(env) &&
              previous.devinCredentialsToml === credentials)
          ) {
            attemptProviderAuth.set(attempt.id, {
              provider: inner.provider,
              env: { ...env },
              ...(credentials === undefined ? {} : { devinCredentialsToml: credentials }),
            });
            applied += 1;
          } else {
            appendJournal(attempt.id, 'credential-grant-rejected', {
              reason: 'conflicting-provider-auth',
            });
          }
        } else {
          appendJournal(attempt.id, 'credential-grant-rejected', {
            reason: 'provider-auth-shape-invalid',
          });
        }
      } else {
        appendJournal(attempt.id, 'credential-grant-rejected', { reason: 'grant-kind-mismatch' });
      }
    }
    if (applied > 0) {
      if (Object.keys(merged).length > 0) attemptGrantEnv.set(attempt.id, merged);
      appendJournal(attempt.id, 'credential-grants-applied', { count: applied });
    }
  } catch (error) {
    // A pull failure leaves the attempt running without grants — provider
    // ambient credentials may still carry it. Not fatal, but journal it.
    appendJournal(attempt.id, 'credential-grant-pull-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Pulls this device's task-key wrap for a job and returns the TCK. The
 * source seals one wrap per recipient; the backend only stores opaque
 * envelopes. Returns null when no wrap exists for us yet — the caller
 * fails closed rather than executing without the sealed inputs.
 */
async function pullTaskKey(attempt: ExecutionAttempt): Promise<Buffer | null> {
  const ctx = workerContext();
  if (ctx === null || ctx.scope === undefined) return null;
  const cached = taskKeyFor(ctx.scope, attempt.jobId);
  if (cached !== null) return cached;
  let wraps: TaskKeyWrapPayload[];
  try {
    const result = await meshRpc<TaskKeyPullResult>('taskkey.pull', { jobId: attempt.jobId });
    wraps = result.wraps;
  } catch {
    return null;
  }
  for (const wrap of wraps) {
    if (wrap.targetEnrollmentId !== ctx.enrollmentId) continue;
    const key = unsealTaskKeyWrap(ctx.scope, ctx.enrollmentId, wrap);
    if (key === null) {
      appendJournal(attempt.id, 'task-key-wrap-rejected', { reason: 'unseal-failed' });
      continue;
    }
    storeTaskKey(ctx.scope, attempt.jobId, key);
    return key;
  }
  return null;
}

/**
 * Resolves the job's effective inputs: coordinator-visible manifest keys
 * plus the sealed envelope's contents, unsealed under the job's TCK.
 * Returns null when the job carries sealed inputs we cannot open — the
 * attempt must not run on partial context.
 */
async function resolveJobInputs(
  job: MeshJob,
  attempt: ExecutionAttempt,
  sealedInputs: SealedTaskPayload | undefined,
): Promise<Record<string, unknown> | null> {
  const envelope =
    sealedInputs ?? persistedSealedInputs(attempt.id) ?? job.sealedInputs ?? undefined;
  if (envelope === undefined) return job.inputManifest.inputs;
  const ctx = workerContext();
  if (ctx === null || ctx.scope === undefined) return null;
  const taskKey = await pullTaskKey(attempt);
  if (taskKey === null) {
    appendJournal(attempt.id, 'awaiting-key-delivery', { jobId: job.id });
    return null;
  }
  try {
    const sealed = unsealTaskInputs(ctx.scope, job.requestId, taskKey, envelope);
    return { ...job.inputManifest.inputs, ...sealed };
  } catch (error) {
    appendJournal(attempt.id, 'sealed-inputs-rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function persistedSealedInputs(attemptId: string): SealedTaskPayload | undefined {
  const row = getDb()
    .prepare('SELECT sealed_inputs_json FROM mesh_attempts WHERE id = ?')
    .get(attemptId) as { sealed_inputs_json: string | null } | undefined;
  if (row?.sealed_inputs_json == null) return undefined;
  try {
    return JSON.parse(row.sealed_inputs_json) as SealedTaskPayload;
  } catch {
    return undefined;
  }
}

async function runAttempt(attempt: ExecutionAttempt, job: MeshJob): Promise<void> {
  const attemptId = attempt.id;
  appendJournal(attemptId, 'preparing');
  updateAttemptState(attemptId, 'preparing');
  try {
    const executor = EXECUTORS[job.kind];
    if (executor === undefined) {
      appendJournal(attemptId, 'unsupported-kind', { kind: job.kind });
      updateAttemptState(attemptId, 'failed');
      await reportAttempt(attemptId, 'failed', {
        error: `unsupported job kind: ${job.kind}`,
      });
      return;
    }
    updateAttemptState(attemptId, 'running');
    appendJournal(attemptId, 'running');
    // ENV-06: sealed grants addressed to this claim are pulled now that the
    // fence is known; the executor injects them into provider spawns.
    await pullCredentialGrants(attempt);
    // Task-scoped inputs: the coordinator's manifest only carries public
    // routing keys; prompts/execution context arrive in `sealedInputs`
    // under a per-job key wrapped to this enrollment.
    const inputs = await resolveJobInputs(job, attempt, undefined);
    if (inputs === null) {
      // No report — a failed outcome would end the job. The attempt's
      // backend lease expires and the job is re-offered once key delivery
      // lands; locally the row stops renewing so the lease can die.
      updateAttemptState(attemptId, 'unknown-outcome');
      return;
    }
    const effectiveJob: MeshJob = {
      ...job,
      inputManifest: { ...job.inputManifest, inputs },
    };
    const result = await executor(effectiveJob, attempt);
    const cancelled = isCancelRequested(attemptId);
    // MESH-03: persist attempt evidence as a private R2 artifact while the
    // attempt is still active — reserve rejects terminal attempts, so this
    // must happen before reportAttempt. Best-effort: the outcome report is
    // authoritative and must not be held up by an artifact failure.
    try {
      const evidence = new TextEncoder().encode(JSON.stringify(result, null, 2));
      const manifest = await uploadAttemptArtifact({
        attemptId,
        bytes: evidence,
        mediaType: 'application/json',
      });
      appendJournal(attemptId, 'artifact-uploaded', { artifactId: manifest.id });
    } catch (artifactError) {
      appendJournal(attemptId, 'artifact-upload-failed', {
        error: artifactError instanceof Error ? artifactError.message : String(artifactError),
      });
    }
    updateAttemptState(attemptId, cancelled ? 'cancelled' : 'completed', {
      resultJson: JSON.stringify(result),
    });
    appendJournal(attemptId, cancelled ? 'cancelled' : 'completed', { result });
    // A clean stop reports 'completed': when the job is cancel-requested the
    // backend masks it to 'cancelled' (verified stop). Reporting 'failed'
    // would wrongly end the job as failed.
    await reportAttempt(attemptId, 'completed', result, job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendJournal(attemptId, 'failed', { error: message });
    updateAttemptState(attemptId, 'failed', {
      resultJson: JSON.stringify({ error: message }),
    });
    await reportAttempt(attemptId, 'failed', { error: message }, job);
  } finally {
    activitySequences.delete(`attempt:${attemptId}`);
    controlSequences.delete(attemptId);
    // ENV-06: grant material dies with the attempt — a re-fenced attempt
    // must pull fresh grants rather than reuse an old incarnation's.
    attemptGrantEnv.delete(attemptId);
    attemptCodexHostAuthJson.delete(attemptId);
    attemptProviderAuth.delete(attemptId);
  }
}

function isCancelRequested(attemptId: string): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT cancel_requested FROM mesh_attempts WHERE id = ?')
    .get(attemptId) as { cancel_requested: number } | undefined;
  return row?.cancel_requested === 1;
}

/**
 * Emits an `activity` status frame for an attempt. Best-effort: the frame is
 * ephemeral observation, the attempt journal + report are the durable record.
 * Sequence is per-attempt monotonic so observers can detect gaps.
 */
const activitySequences = new Map<string, number>();
interface ActivityAppendQueue {
  incarnation: string;
  generation: number;
  events: EventAppendParams['events'];
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
}
const activityAppendQueues = new Map<string, ActivityAppendQueue>();
const ACTIVITY_APPEND_MAX_AGE_MS = 1_000;
const ACTIVITY_APPEND_RETRY_MIN_MS = 25_000;
const ACTIVITY_APPEND_RETRY_MAX_MS = 35_000;

function emitActivity(attempt: ExecutionAttempt, text: string): void {
  const context = workerContext();
  if (context === null) return;
  const streamId = `attempt:${attempt.id}`;
  const sequence = (activitySequences.get(streamId) ?? 0) + 1;
  activitySequences.set(streamId, sequence);
  const payload: ActivityPayload = {
    kind: 'status',
    text,
    byteLength: Buffer.byteLength(text, 'utf8'),
    truncated: false,
  };
  const event: EventAppendParams['events'][number] = { streamId, sequence, payload };
  try {
    context.sendFrame?.({
      type: 'activity',
      version: 1,
      id: randomUUID(),
      attemptId: attempt.id,
      generation: attempt.fence,
      streamId,
      sequence,
      payload,
    });
  } catch {
    // The durable event.append path below recovers the transition.
  }
  enqueueActivityAppend(attempt.id, attempt.workerIncarnation, attempt.fence, event);
}

function enqueueActivityAppend(
  attemptId: string,
  incarnation: string,
  generation: number,
  event: EventAppendParams['events'][number],
): void {
  const ctx = workerContext();
  if (ctx === null) return;
  let queue = activityAppendQueues.get(attemptId);
  if (
    queue !== undefined &&
    (queue.incarnation !== incarnation || queue.generation !== generation)
  ) {
    return;
  }
  if (queue === undefined) {
    queue = { incarnation, generation, events: [], timer: null, inFlight: false };
    activityAppendQueues.set(attemptId, queue);
  }
  const next = [...queue.events, event];
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > EVENT_APPEND_MAX_BYTES) {
    if (queue.events.length === 0) return;
    void flushActivityAppend(attemptId);
    // A single event fits the cap; start the next batch after the current one.
    const later = activityAppendQueues.get(attemptId);
    if (later === undefined) return;
    later.events.push(event);
    scheduleActivityAppend(later, attemptId, ACTIVITY_APPEND_MAX_AGE_MS);
    return;
  }
  queue.events.push(event);
  if (queue.events.length >= EVENT_APPEND_MAX_EVENTS) {
    void flushActivityAppend(attemptId);
    return;
  }
  if (queue.timer === null) scheduleActivityAppend(queue, attemptId, ACTIVITY_APPEND_MAX_AGE_MS);
}

function scheduleActivityAppend(
  queue: ActivityAppendQueue,
  attemptId: string,
  delayMs: number,
): void {
  if (queue.timer !== null) clearTimeout(queue.timer);
  queue.timer = setTimeout(() => {
    queue.timer = null;
    void flushActivityAppend(attemptId);
  }, delayMs);
  queue.timer.unref?.();
}

async function flushActivityAppend(attemptId: string): Promise<void> {
  const queue = activityAppendQueues.get(attemptId);
  if (queue === undefined || queue.inFlight || queue.events.length === 0) return;
  if (queue.timer !== null) {
    clearTimeout(queue.timer);
    queue.timer = null;
  }
  const batch = queue.events.slice(0, EVENT_APPEND_MAX_EVENTS);
  if (Buffer.byteLength(JSON.stringify(batch), 'utf8') > EVENT_APPEND_MAX_BYTES) return;
  queue.events = queue.events.slice(batch.length);
  queue.inFlight = true;
  let failed = false;
  try {
    const result = await meshRpc<EventAppendResult>('event.append', {
      attemptId,
      incarnation: queue.incarnation,
      generation: queue.generation,
      events: batch,
    } satisfies EventAppendParams);
    if (
      !Array.isArray(result.results) ||
      result.results.length !== batch.length ||
      result.results.some(
        (item, index) =>
          item.streamId !== batch[index]?.streamId ||
          item.sequence !== batch[index]?.sequence ||
          !['journaled', 'dropped', 'duplicate'].includes(item.status),
      )
    ) {
      throw new Error('event-append-response-invalid');
    }
  } catch (error) {
    failed = true;
    queue.events = [...batch, ...queue.events];
    const terminalFenceFailure =
      error instanceof BackendRpcError &&
      !error.retryable &&
      ['conflict', 'forbidden', 'not-found', 'stale-generation'].includes(error.code);
    if (terminalFenceFailure) {
      if (queue.timer !== null) clearTimeout(queue.timer);
      activityAppendQueues.delete(attemptId);
      return;
    }
    // Retain the exact stream sequences and let durable dedupe make retries safe.
  } finally {
    queue.inFlight = false;
  }
  if (activityAppendQueues.get(attemptId) !== queue || queue.events.length === 0) {
    activityAppendQueues.delete(attemptId);
    return;
  }
  const delay = failed
    ? ACTIVITY_APPEND_RETRY_MIN_MS +
      Math.floor(Math.random() * (ACTIVITY_APPEND_RETRY_MAX_MS - ACTIVITY_APPEND_RETRY_MIN_MS + 1))
    : ACTIVITY_APPEND_MAX_AGE_MS;
  scheduleActivityAppend(queue, attemptId, delay);
}

/**
 * The diagnostic job proves the claim→journal→renew→report pipeline without
 * an agent runner: verify the manifest's declared digest shape, record
 * timings, and return a small result. Checkpoints between steps observe the
 * cancel flag so a `job.cancel` during execution ends the attempt cleanly.
 */
async function executeDiagnostic(
  manifest: ExecutionManifest,
  attemptId: string,
  attempt?: ExecutionAttempt,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  appendJournal(attemptId, 'diagnostic.manifest', {
    workspaceDefinitionRevision: manifest.workspaceDefinitionRevision,
    repositoryCount: manifest.repositories.length,
    provider: manifest.provider,
    model: manifest.model,
  });
  if (attempt !== undefined) {
    emitActivity(attempt, 'diagnostic: manifest received');
  }
  if (isCancelRequested(attemptId)) {
    return { ok: false, cancelled: true, tookMs: Date.now() - started };
  }
  appendJournal(attemptId, 'diagnostic.environment', {
    os: platform(),
    arch: process.arch,
    capabilities: WORKER_CAPABILITIES,
  });
  if (attempt !== undefined) {
    emitActivity(attempt, 'diagnostic: environment recorded');
  }
  return {
    ok: true,
    manifestReceived: true,
    repositoriesDeclared: manifest.repositories.length,
    tookMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// SESSION-02: prepare-workspace + remote approval gate
// ---------------------------------------------------------------------------

const EXECUTORS: Record<
  string,
  (job: MeshJob, attempt: ExecutionAttempt) => Promise<Record<string, unknown>>
> = {
  diagnostic: (job, attempt) => executeDiagnostic(job.inputManifest, attempt.id, attempt),
  'prepare-workspace': executePrepareWorkspace,
  'start-session': executeStartSession,
  'code-task': executeCodeTask,
  // FLOW-02: a workflow node IS a code-task unit plus result transfer —
  // the manifest declares `resultTransfer: bundle-artifacts`.
  'workflow-node': executeCodeTask,
  // ENV-03: provider-side environment create + pairing bootstrap.
  'provision-environment': executeProvisionEnvironment,
};

/**
 * ENV-03: claims a `provision-environment` job, mints the ephemeral
 * enrollment code (authentication-only — no account key material), and
 * drives the matching provider's create. Enrollment completes
 * asynchronously inside the environment — it self-reports `enrolled` and
 * the backend resolves environment-targeted jobs onto it.
 */
async function executeProvisionEnvironment(
  job: MeshJob,
  attempt: ExecutionAttempt,
): Promise<Record<string, unknown>> {
  const inputs = parseProvisionEnvironmentInputs(job.inputManifest);
  const scope = provisionerScope();
  if (scope === null) {
    throw new Error('provision-environment requires an active sync scope.');
  }
  const mint = workerContext()?.mintEnvironmentCode;
  if (mint === undefined) {
    throw new Error('Environment code mint is unavailable on this runtime.');
  }
  emitActivity(attempt, `provisioning ${inputs.provider} environment ${inputs.environmentId}`);
  const enrollmentCode = await mint({
    provider: inputs.provider,
    ttlSeconds: inputs.ttlSeconds,
    environmentId: inputs.environmentId,
    displayName: inputs.displayName ?? `env:${inputs.environmentId}`,
  });
  if (enrollmentCode === null) {
    throw new Error('Could not mint an ephemeral enrollment code.');
  }
  const result = await provisionEnvironment(scope, inputs, enrollmentCode, job.id);
  appendJournal(attempt.id, 'environment-provisioned', {
    environmentId: inputs.environmentId,
    provider: inputs.provider,
    providerRef: result['providerRef'],
  });
  emitActivity(attempt, `environment ${inputs.environmentId} accepted by ${inputs.provider}`);
  return result;
}

function parseProvisionEnvironmentInputs(manifest: ExecutionManifest): ProvisionEnvironmentInputs {
  const inputs = manifest.inputs;
  const provider = inputs['provider'];
  const environmentId = inputs['environmentId'];
  const ttlSeconds = inputs['ttlSeconds'];
  if (!isEnvironmentProviderId(provider)) {
    throw new Error('provision-environment manifest has no valid provider');
  }
  if (typeof environmentId !== 'string' || environmentId.length === 0) {
    throw new Error('provision-environment manifest has no environmentId');
  }
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds < 60) {
    throw new Error('provision-environment manifest ttlSeconds must be >= 60');
  }
  const imageRef = inputs['imageRef'];
  const connectionId = inputs['connectionId'];
  const displayName = inputs['displayName'];
  const networkPolicy = inputs['networkPolicy'];
  const resources = inputs['resources'];
  return {
    environmentId,
    provider,
    ttlSeconds,
    ...(typeof imageRef === 'string' ? { imageRef } : {}),
    ...(typeof connectionId === 'string' ? { connectionId } : {}),
    ...(typeof displayName === 'string' ? { displayName } : {}),
    ...(Array.isArray(networkPolicy) && networkPolicy.every((v) => typeof v === 'string')
      ? { networkPolicy: networkPolicy as string[] }
      : {}),
    ...(typeof resources === 'object' && resources !== null
      ? { resources: resources as { vcpus?: number; memoryMb?: number } }
      : {}),
  };
}

/** Worker→backend control stream (`streamId: 'control'`) sequence space. */
const controlSequences = new Map<string, number>();

/**
 * Sends a control request on the attempt's reserved stream. Control frames
 * need a live socket — an approval request cannot be queued for later
 * (the backend binds it to the current fence), so a missing sender throws.
 */
function sendControl(attempt: ExecutionAttempt, doc: Record<string, unknown>): void {
  const ctx = workerContext();
  if (ctx?.sendFrame === undefined || ctx.isLive?.() === false) {
    throw new Error('control channel unavailable: no live socket');
  }
  const send = ctx.sendFrame;
  const sequence = (controlSequences.get(attempt.id) ?? 0) + 1;
  controlSequences.set(attempt.id, sequence);
  const text = JSON.stringify(doc);
  send({
    type: 'activity',
    version: 1,
    id: randomUUID(),
    attemptId: attempt.id,
    generation: attempt.fence,
    streamId: 'control',
    sequence,
    payload: { kind: 'status', text, byteLength: text.length, truncated: false },
  });
}

const APPROVAL_RECHECK_MIN_MS = 25_000;
const APPROVAL_RECHECK_MAX_MS = 35_000;
const APPROVAL_WAIT_CAP_MS = 10 * 60 * 1000; // backend default TTL
const approvalWaiters = new Map<string, Set<() => void>>();

/** Wake a durable approval catch-up when a scoped account/host event arrives. */
export function notifyMeshWorkerAttemptEvent(attemptId: string): void {
  for (const wake of approvalWaiters.get(attemptId) ?? []) wake();
}

function waitForApprovalWake(attemptId: string, fallbackMs: number): Promise<void> {
  return new Promise((resolve) => {
    const waiters = approvalWaiters.get(attemptId) ?? new Set<() => void>();
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      clearTimeout(timer);
      waiters.delete(finish);
      if (waiters.size === 0) approvalWaiters.delete(attemptId);
      resolve();
    };
    waiters.add(finish);
    approvalWaiters.set(attemptId, waiters);
    timer = setTimeout(finish, fallbackMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Requests a durable approval on the reserved control stream, then checks
 * `approval.get` on scoped push events with a bounded jittered safety read.
 * Two fail-closed rules:
 *
 * 1. The approval ROW is the decision authority — the job is 'running' both
 *    before the request lands and after a grant, so job state alone can
 *    never prove a grant.
 * 2. The request is only "sent" once its row exists — control frames ride a
 *    reconnecting socket, so the send retries each poll until the row
 *    appears (the backend dedupes same-digest re-requests).
 *
 * Reaching the TTL cap, a dead socket, or an unreachable backend all
 * resolve 'denied'. A terminal job state ends the wait early. Push only wakes
 * the waiter; the durable approval row remains the decision authority.
 */
async function requestAndAwaitApproval(
  job: MeshJob,
  attempt: ExecutionAttempt,
  actionDigest: string,
  pollMs?: number,
  capMs = APPROVAL_WAIT_CAP_MS,
  details?: string,
): Promise<'approved' | 'denied'> {
  const ctx = workerContext();
  const key = ctx?.scope === undefined ? null : taskKeyFor(ctx.scope, job.id);
  const sealedDetails =
    details === undefined
      ? undefined
      : ctx?.scope !== undefined && key !== null
        ? sealTaskResult(ctx.scope, job.id, attempt.id, key, { actionDigest, details })
        : undefined;
  if (details !== undefined && sealedDetails === undefined)
    throw new Error('approval-details-key-unavailable');
  appendJournal(attempt.id, 'approval-requested', { actionDigest });
  emitActivity(attempt, `approval requested: ${actionDigest.slice(0, 12)}…`);
  const deadline = Date.now() + capMs;
  let requestSeen = false;
  // Retries journal once per distinct failure reason — a dead socket would
  // otherwise append an identical row every poll for the whole TTL window.
  let lastRetryReason: string | null = null;
  const journalRetry = (event: string, error: unknown): void => {
    const reason = error instanceof Error ? error.message : String(error);
    if (reason === lastRetryReason) return;
    lastRetryReason = reason;
    appendJournal(attempt.id, event, { reason });
  };
  while (Date.now() < deadline && !isCancelRequested(attempt.id)) {
    if (!requestSeen) {
      try {
        sendControl(attempt, {
          request: 'approval',
          actionDigest,
          ...(sealedDetails === undefined ? {} : { sealedDetails }),
        });
      } catch (error) {
        // Socket still connecting or mid-reconnect — retried next poll.
        journalRetry('approval-send-retry', error);
      }
    }
    try {
      const { approvals } = await meshRpc<{ approvals: ApprovalRecord[] }>('approval.get', {
        attemptId: attempt.id,
      });
      const mine = approvals.find((row) => row.actionDigest === actionDigest);
      if (mine !== undefined) {
        if (!requestSeen) {
          requestSeen = true;
          appendJournal(attempt.id, 'approval-registered', {
            actionDigest,
            approvalId: mine.id,
            expiresAt: mine.expiresAt,
          });
        }
        if (mine.state !== 'pending') {
          appendJournal(attempt.id, `approval-${mine.state}`, {
            actionDigest,
            approvalId: mine.id,
          });
          return mine.state === 'approved' ? 'approved' : 'denied';
        }
      }
      const { job: current } = await meshRpc<JobGetResult>('job.get', { jobId: job.id });
      if (current.state !== 'running' && current.state !== 'awaiting-approval') {
        appendJournal(attempt.id, 'approval-resolved', {
          actionDigest,
          jobState: current.state,
        });
        return 'denied';
      }
    } catch (error) {
      // Reachability blip — keep polling inside the TTL window.
      journalRetry('approval-poll-retry', error);
    }
    const fallbackMs =
      pollMs ??
      APPROVAL_RECHECK_MIN_MS +
        Math.floor(Math.random() * (APPROVAL_RECHECK_MAX_MS - APPROVAL_RECHECK_MIN_MS + 1));
    await waitForApprovalWake(attempt.id, Math.min(fallbackMs, Math.max(1, deadline - Date.now())));
  }
  appendJournal(attempt.id, 'approval-expired', { actionDigest });
  return 'denied';
}

async function approveProviderAction(
  job: MeshJob,
  attempt: ExecutionAttempt,
  permissionMode: PermissionMode,
  event: import('../../shared/types.js').CodexEvent,
): Promise<boolean> {
  if (permissionMode !== 'on-request' || isCancelRequested(attempt.id)) return false;
  const action = {
    kind: event.approvalKind,
    command: event.approvalCommand,
    cwd: event.approvalCwd,
    reason: event.approvalReason,
    permissions: event.approvalPermissions,
    requestId: event.approvalRequestId,
  };
  const digest = createHash('sha256')
    .update(canonicalJson({ jobId: job.id, attemptId: attempt.id, action, permissionMode }))
    .digest('hex');
  return (
    (await requestAndAwaitApproval(
      job,
      attempt,
      digest,
      undefined,
      undefined,
      `Provider action:\n${canonicalJson(action)}`,
    )) === 'approved' && !isCancelRequested(attempt.id)
  );
}

/**
 * `prepare-workspace`: materialize the manifest's pinned repositories into
 * a worker-managed checkout root, then run the workspace bootstrap recipe
 * when its content digest matches. The chosen running mode is capped locally:
 * approval mode requests one-run authorization; unattended modes execute under
 * their corresponding access policy.
 */
async function executePrepareWorkspace(
  job: MeshJob,
  attempt: ExecutionAttempt,
): Promise<Record<string, unknown>> {
  const attemptId = attempt.id;
  const manifest = job.inputManifest;
  const workspaceId = manifest.inputs['workspaceId'];
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new Error('prepare-workspace requires manifest.inputs.workspaceId');
  }
  emitActivity(attempt, `prepare: materialising workspace ${workspaceId}`);

  // The worker's synced definition must match the pinned content revision —
  // a stale replica prepares the wrong thing silently otherwise.
  // `workspaces.updated_at` is a local clock (remote applies re-stamp it);
  // the manifest pins the canonical payload digest instead.
  installTaskWorkspaceDefinition(manifest);
  const localRevision = workspaceDefinitionRevision(workspaceId);
  if (localRevision === null) {
    throw new Error(`workspace not replicated on this device: ${workspaceId}`);
  }
  if (localRevision !== manifest.workspaceDefinitionRevision) {
    throw new Error(
      `definition-not-converged: local ${localRevision} != manifest ${manifest.workspaceDefinitionRevision}`,
    );
  }

  const userDataDir = workerContext()?.userDataDir;
  if (userDataDir === undefined) {
    throw new Error('worker context has no userDataDir for managed checkouts');
  }
  const checkoutRoot = join(userDataDir, 'mesh-checkouts', workspaceId);
  const manifestCommits = Object.fromEntries(
    manifest.repositories.map((repo) => [repo.repositoryId, repo.commit]),
  );

  // Mapped checkouts belong to the device's user — verify HEAD against the
  // pin but never mutate them. Unmapped definitions clone into the managed
  // root at the exact commit.
  const defs = getDb()
    .prepare(
      `SELECT portable_id, remote_url, mapped_repo_id FROM workspace_repo_definitions
       WHERE workspace_id = ?`,
    )
    .all(workspaceId) as Array<{
    portable_id: string;
    remote_url: string | null;
    mapped_repo_id: string | null;
  }>;
  const defByPortable = new Map(defs.map((d) => [d.portable_id, d]));
  const toClone: Array<{ portableId: string; commit: string }> = [];
  const prepared: Array<{ portableId: string; commit: string; source: string }> = [];
  for (const repo of manifest.repositories) {
    const def = defByPortable.get(repo.repositoryId);
    if (def === undefined) {
      throw new Error(`manifest repository not in workspace definition: ${repo.repositoryId}`);
    }
    if (def.mapped_repo_id !== null) {
      const checkoutPath = (
        getDb().prepare('SELECT path FROM repos WHERE id = ?').get(def.mapped_repo_id) as
          | { path: string }
          | undefined
      )?.path;
      const head = checkoutPath === undefined ? null : await gitHead(checkoutPath);
      if (head !== repo.commit) {
        throw new Error(
          `mapped-checkout-diverged: ${repo.repositoryId} at ${head ?? 'unknown'} != ${repo.commit}`,
        );
      }
      prepared.push({ portableId: repo.repositoryId, commit: repo.commit, source: 'mapped' });
    } else {
      toClone.push({ portableId: repo.repositoryId, commit: repo.commit });
    }
  }
  if (isCancelRequested(attemptId)) return { ok: false, cancelled: true };

  if (toClone.length > 0) {
    emitActivity(attempt, `prepare: cloning ${toClone.length} repositories`);
    const clone = await startWorkspaceClone({
      workspaceId,
      destinationRoot: checkoutRoot,
      repos: toClone.map((repo) => ({ portableId: repo.portableId, commit: repo.commit })),
    });
    for (const repo of clone.repos) {
      if (repo.stage !== 'mapping-published') {
        throw new Error(`clone failed for ${repo.portableId}: ${repo.reason ?? repo.stage}`);
      }
      prepared.push({
        portableId: repo.portableId,
        commit: repo.resolvedCommit ?? manifestCommits[repo.portableId] ?? '',
        source: 'cloned',
      });
    }
  }
  appendJournal(attemptId, 'materialized', { repositories: prepared });
  emitActivity(attempt, `prepare: ${prepared.length} repositories materialised`);

  // ---- Bootstrap under the approval gate.
  const recipe = getWorkspaceBootstrap(workspaceId);
  let bootstrap: 'none' | 'verified' = 'none';
  if (recipe !== null) {
    const digest = computeBootstrapDigest({
      recipe,
      repositoryCommits: manifestCommits,
      executionPolicy: bootstrapManifestPolicy(),
    });
    if (digest !== manifest.bootstrapDigest) {
      throw new Error(
        `bootstrap-digest-mismatch: computed ${digest} != manifest ${manifest.bootstrapDigest}`,
      );
    }
    const mode = effectiveMeshPermissionMode(manifest.inputs);
    // The transport pin covers recipe+commits. Local authorization additionally
    // pins this target's policy and this one attempt, never another device's policy.
    const localPolicy = { ...buildDevicePolicy(), mode, jobId: job.id, attemptId: attempt.id };
    const localDigest = computeBootstrapDigest({
      recipe,
      repositoryCommits: manifestCommits,
      executionPolicy: localPolicy,
    });
    if (mode === 'on-request') {
      if (
        (await requestAndAwaitApproval(
          job,
          attempt,
          localDigest,
          undefined,
          undefined,
          `Bootstrap recipe:\n${recipe.steps.map((step) => step.shell ?? step.argv?.join(' ') ?? step.kind).join('\n')}`,
        )) !== 'approved'
      )
        throw new Error('bootstrap-approval-denied-or-expired');
    }
    if (isCancelRequested(attempt.id)) throw new Error('bootstrap-cancelled');
    recordBootstrapApproval(workspaceId, {
      recipe,
      repositoryCommits: manifestCommits,
      executionPolicy: localPolicy,
      shellApproved: true,
    });
    const root = workspaceCheckoutRoot(workspaceId) ?? checkoutRoot;
    emitActivity(attempt, 'bootstrap: running recipe');
    const run = startBootstrapRun({
      workspaceId,
      recipe,
      repositoryCommits: manifestCommits,
      executionPolicy: localPolicy,
      checkoutRoot: root,
      definitionRevision: manifest.workspaceDefinitionRevision,
      commandExecutor: async ({ step, cwd, env, onSpawn }) => {
        if (isCancelRequested(attempt.id) || effectiveMeshPermissionMode(manifest.inputs) !== mode)
          throw new Error('bootstrap-permission-policy-changed');
        const outcome = await executeMeshCommand({
          argv: bootstrapCommandArgv(step),
          cwd,
          env,
          mode,
          timeoutMs: step.timeoutMs,
          onSpawn,
        });
        return {
          stepId: step.id,
          state: outcome.exitCode === 0 ? 'verified' : 'failed',
          ...outcome,
        };
      },
    });
    if (run.handle === null) {
      throw new Error('bootstrap run parked awaiting-approval unexpectedly');
    }
    const cancelTimer = setInterval(() => {
      if (isCancelRequested(attempt.id)) run.handle?.cancel();
    }, 500);
    let runResult;
    try {
      runResult = await run.handle.done;
    } finally {
      clearInterval(cancelTimer);
    }
    if (runResult.state !== 'verified') {
      throw new Error(`bootstrap-${runResult.state}`);
    }
    bootstrap = 'verified';
    emitActivity(attempt, 'bootstrap: verified');
  }

  // PLACE-01: the workspace is now materialised at this revision — the
  // scheduler's readiness hard constraint only sees it once the replica
  // row republishes.
  void publishReplicas().catch(() => undefined);

  return {
    ok: true,
    workspaceId,
    checkoutRoot,
    repositories: prepared,
    bootstrap,
  };
}

// ---- start-session ---------------------------------------------------------

const SESSION_TURN_DEFAULT_TIMEOUT_MS = 10 * 60_000;
const SESSION_TURN_MAX_TIMEOUT_MS = 60 * 60_000;

/**
 * Resolves a manifest-pinned repository to a local checkout at the exact
 * commit. Mapped checkouts are verified, never mutated; managed checkouts
 * come from a prior `prepare-workspace` and are identified BY their commit
 * (the directory name is a materialization detail, not an identity).
 */
async function resolveSessionCheckout(
  repositoryId: string,
  commit: string,
  defs: Map<string, { mapped_repo_id: string | null }>,
  managedRoot: string | null,
): Promise<string> {
  const def = defs.get(repositoryId);
  if (def === undefined) {
    throw new Error(`manifest repository not in workspace definition: ${repositoryId}`);
  }
  if (def.mapped_repo_id !== null) {
    const path = (
      getDb().prepare('SELECT path FROM repos WHERE id = ?').get(def.mapped_repo_id) as
        | { path: string }
        | undefined
    )?.path;
    const head = path === undefined ? null : await gitHead(path);
    if (head !== commit) {
      throw new Error(
        `mapped-checkout-diverged: ${repositoryId} at ${head ?? 'unknown'} != ${commit}`,
      );
    }
    return path!;
  }
  if (managedRoot === null) {
    throw new Error(`workspace-not-prepared: no managed checkout root for ${repositoryId}`);
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(managedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // Root absent entirely — falls through to the not-prepared error.
  }
  for (const entry of entries) {
    const candidate = join(managedRoot, entry);
    if ((await gitHead(candidate)) === commit) return candidate;
  }
  throw new Error(
    `workspace-not-prepared: no managed checkout at ${commit} for ${repositoryId} — run prepare-workspace first`,
  );
}

interface RemoteSessionCheckout {
  repositoryId: string;
  path: string;
  mappedRepoId: string | null;
}

async function readRemoteSessionCheckouts(input: {
  workspaceId: string;
  provider: string;
  providerThreadId: string;
  repositoryIds: string[];
}): Promise<RemoteSessionCheckout[] | null> {
  const ctx = workerContext();
  if (ctx?.scope === undefined) throw new Error('remote-session-checkout-scope-missing');
  const row = getDb()
    .prepare(
      `SELECT checkouts_json FROM mesh_remote_provider_sessions
       WHERE backend_id = ? AND account_id = ? AND scope_epoch = ? AND workspace_id = ?
         AND provider = ? AND provider_thread_id = ?`,
    )
    .get(
      ctx.scope.backendId,
      ctx.scope.accountId,
      ctx.scope.datasetEpoch,
      input.workspaceId,
      input.provider,
      input.providerThreadId,
    ) as { checkouts_json: string } | undefined;
  if (row === undefined) return null;
  let checkouts: RemoteSessionCheckout[];
  try {
    checkouts = JSON.parse(row.checkouts_json) as RemoteSessionCheckout[];
  } catch {
    throw new Error('provider-session-checkout-corrupt');
  }
  if (
    !Array.isArray(checkouts) ||
    checkouts.length !== input.repositoryIds.length ||
    input.repositoryIds.some((id) => !checkouts.some((checkout) => checkout.repositoryId === id))
  )
    throw new Error('provider-session-checkout-mismatch');
  const userDataDir = ctx.userDataDir;
  for (const checkout of checkouts) {
    const def = getDb()
      .prepare(
        'SELECT mapped_repo_id FROM workspace_repo_definitions WHERE workspace_id = ? AND portable_id = ?',
      )
      .get(input.workspaceId, checkout.repositoryId) as
      | { mapped_repo_id: string | null }
      | undefined;
    if (def === undefined || def.mapped_repo_id !== checkout.mappedRepoId) {
      throw new Error('provider-session-checkout-mapping-changed');
    }
    if (checkout.mappedRepoId !== null) {
      const mappedPath = getDb()
        .prepare('SELECT path FROM repos WHERE id = ?')
        .get(checkout.mappedRepoId) as { path: string } | undefined;
      if (mappedPath?.path !== checkout.path)
        throw new Error('provider-session-checkout-mapping-changed');
    } else {
      if (userDataDir === undefined)
        throw new Error('worker context has no userDataDir for managed checkouts');
      const root = join(userDataDir, 'mesh-checkouts', input.workspaceId);
      const pathFromRoot = relative(root, checkout.path);
      if (pathFromRoot === '' || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
        throw new Error('provider-session-checkout-outside-managed-root');
      }
    }
    if ((await gitHead(checkout.path)) === null)
      throw new Error('provider-session-checkout-unavailable');
  }
  return checkouts;
}

function persistRemoteSessionCheckouts(input: {
  workspaceId: string;
  provider: string;
  providerThreadId: string;
  checkouts: RemoteSessionCheckout[];
}): void {
  const scope = workerContext()?.scope;
  if (scope === undefined) throw new Error('remote-session-checkout-scope-missing');
  getDb()
    .prepare(
      `INSERT INTO mesh_remote_provider_sessions
       (backend_id, account_id, scope_epoch, workspace_id, provider, provider_thread_id, checkouts_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(backend_id, account_id, scope_epoch, workspace_id, provider, provider_thread_id)
       DO UPDATE SET checkouts_json=excluded.checkouts_json, updated_at=excluded.updated_at`,
    )
    .run(
      scope.backendId,
      scope.accountId,
      scope.datasetEpoch,
      input.workspaceId,
      input.provider,
      input.providerThreadId,
      JSON.stringify(input.checkouts),
      new Date().toISOString(),
    );
}

/**
 * Prior attempts' spawn evidence (spec §9 inspect-before-retry): a prior
 * attempt that journaled `provider-spawn` but never `provider-thread`
 * may have left an orphan provider process — the retry must NOT spawn a
 * second one. A recorded `provider-thread` is the verified same-home
 * resume handle (audit: codex native-resume, same CODEX_HOME).
 */
function priorSessionEvidence(
  jobId: string,
  excludeAttemptId: string,
): { unresolvedSpawn: boolean; resumeThreadId: string | null } {
  const rows = getDb()
    .prepare(
      `SELECT journal_json FROM mesh_attempts WHERE job_id = ? AND id != ? ORDER BY created_at`,
    )
    .all(jobId, excludeAttemptId) as Array<{ journal_json: string }>;
  let unresolvedSpawn = false;
  let resumeThreadId: string | null = null;
  for (const row of rows) {
    let events: Array<{ event?: string; detail?: Record<string, unknown> }>;
    try {
      events = JSON.parse(row.journal_json) as typeof events;
    } catch {
      continue;
    }
    const spawned = events.some((e) => e.event === 'provider-spawn');
    const thread = events.find((e) => e.event === 'provider-thread');
    const threadId = thread?.detail?.['threadId'];
    if (typeof threadId === 'string' && threadId.length > 0) {
      resumeThreadId = threadId;
    } else if (spawned) {
      unresolvedSpawn = true;
    }
  }
  return { unresolvedSpawn, resumeThreadId };
}

/** Wait for the source to observe this fenced claim and deliver its explicit API-key grant. */
async function awaitRemoteApiKey(attempt: ExecutionAttempt): Promise<void> {
  const deadline = Math.min(Date.now() + 60_000, Date.parse(attempt.leaseExpiresAt));
  if (!Number.isFinite(deadline)) throw new Error('provider-credential-lease-invalid');
  while (Date.now() < deadline) {
    if (isCancelRequested(attempt.id)) throw new Error('provider-credential-wait-cancelled');
    if (attemptGrantEnv.get(attempt.id)?.OPENAI_API_KEY) return;
    await pullCredentialGrants(attempt);
    if (attemptGrantEnv.get(attempt.id)?.OPENAI_API_KEY) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('provider-credential-grant-not-delivered');
}

/** Wait for the launch-host Codex credential grant without exposing it to logs or env. */
async function awaitRemoteCodexHostAuth(attempt: ExecutionAttempt): Promise<string> {
  const deadline = Math.min(Date.now() + 60_000, Date.parse(attempt.leaseExpiresAt));
  if (!Number.isFinite(deadline)) throw new Error('provider-credential-lease-invalid');
  while (Date.now() < deadline) {
    if (isCancelRequested(attempt.id)) throw new Error('provider-credential-wait-cancelled');
    const authJson = attemptCodexHostAuthJson.get(attempt.id);
    if (authJson !== undefined) return authJson;
    await pullCredentialGrants(attempt);
    const delivered = attemptCodexHostAuthJson.get(attempt.id);
    if (delivered !== undefined) return delivered;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('provider-codex-host-auth-grant-not-delivered');
}

/** Wait for the provider-specific grant sealed to this exact live claim. */
async function awaitRemoteProviderAuth(
  attempt: ExecutionAttempt,
  provider: AgentProvider,
): Promise<RemoteProviderAuth> {
  const deadline = Math.min(Date.now() + 60_000, Date.parse(attempt.leaseExpiresAt));
  if (!Number.isFinite(deadline)) throw new Error('provider-credential-lease-invalid');
  while (Date.now() < deadline) {
    if (isCancelRequested(attempt.id)) throw new Error('provider-credential-wait-cancelled');
    const auth = attemptProviderAuth.get(attempt.id);
    if (auth !== undefined) {
      if (auth.provider !== provider) throw new Error('provider-auth-grant-provider-mismatch');
      return auth;
    }
    await pullCredentialGrants(attempt);
    const delivered = attemptProviderAuth.get(attempt.id);
    if (delivered !== undefined) {
      if (delivered.provider !== provider) throw new Error('provider-auth-grant-provider-mismatch');
      return delivered;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('provider-auth-grant-not-delivered');
}

function codexAuthSessionId(
  inputs: Record<string, unknown>,
  handoffSessionId: string | null,
  handoffId: unknown,
  priorResumeThreadId: string | null,
): string | undefined {
  const candidate = inputs['authSessionId'];
  if (typeof candidate === 'string' && candidate.trim().length > 0 && candidate.length <= 512)
    return candidate;
  if (handoffSessionId !== null) return handoffSessionId;
  if (typeof handoffId === 'string' && handoffId.length > 0) return handoffId;
  const resumeThreadId = inputs['resumeThreadId'];
  if (typeof resumeThreadId === 'string' && resumeThreadId.length > 0) return resumeThreadId;
  return priorResumeThreadId ?? undefined;
}

function codexAuthHomeForSession(
  userDataDir: string | undefined,
  scope: SyncScope | undefined,
  sessionId: string | undefined,
): string {
  if (userDataDir === undefined)
    throw new Error('worker context has no userDataDir for Codex auth');
  if (scope === undefined) throw new Error('Codex host auth requires a sync scope');
  if (sessionId === undefined || sessionId.trim().length === 0 || sessionId.length > 512)
    throw new Error('Codex host auth requires a stable session identity');
  const identityHash = createHash('sha256')
    .update(`${scope.backendId}\0${scope.accountId}\0${scope.datasetEpoch}\0${sessionId}`)
    .digest('hex');
  const parent = join(userDataDir, 'mesh-codex-auth');
  const home = join(parent, identityHash);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (lstatSync(parent).isSymbolicLink() || lstatSync(home).isSymbolicLink())
    throw new Error('Codex auth home must be a private directory');
  chmodSync(parent, 0o700);
  chmodSync(home, 0o700);
  return home;
}

function providerDataHomeForSession(
  userDataDir: string | undefined,
  scope: SyncScope | undefined,
  sessionId: string | undefined,
): string {
  if (userDataDir === undefined)
    throw new Error('worker context has no userDataDir for provider auth');
  if (scope === undefined) throw new Error('provider auth requires a sync scope');
  if (sessionId === undefined || sessionId.trim().length === 0 || sessionId.length > 512)
    throw new Error('provider auth requires a stable session identity');
  const identityHash = createHash('sha256')
    .update(`${scope.backendId}\0${scope.accountId}\0${scope.datasetEpoch}\0${sessionId}`)
    .digest('hex');
  const parent = join(userDataDir, 'mesh-provider-data');
  const home = join(parent, identityHash);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (lstatSync(parent).isSymbolicLink() || lstatSync(home).isSymbolicLink())
    throw new Error('provider auth home must be a private directory');
  chmodSync(parent, 0o700);
  chmodSync(home, 0o700);
  return home;
}

/**
 * Run one provider turn on the exact prepared workspace. The target caps the
 * selected permission mode; action approvals use the durable mesh approval
 * path. Provider prompts requiring unattended human input fail explicitly.
 * The attempt journal records spawn/thread lifecycle and provider output is
 * returned only inside the sealed task result.
 */
async function executeStartSession(
  job: MeshJob,
  attempt: ExecutionAttempt,
): Promise<Record<string, unknown>> {
  const attemptId = attempt.id;
  const manifest = job.inputManifest;
  const workspaceId = manifest.inputs['workspaceId'];
  const prompt = manifest.inputs['prompt'];
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new Error('start-session requires manifest.inputs.workspaceId');
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('start-session requires manifest.inputs.prompt');
  }
  const provider = manifest.provider;
  if (
    provider !== 'codex' &&
    provider !== 'azure' &&
    provider !== 'openai' &&
    provider !== 'cursor' &&
    provider !== 'devin' &&
    provider !== 'llmgateway'
  ) {
    throw new Error(`provider-unsupported-remote: ${provider}`);
  }
  if (manifest.inputs['authMode'] === 'codex-host-auth' && provider !== 'codex') {
    throw new Error('provider-codex-host-auth-requires-codex');
  }

  const localRevision = workspaceDefinitionRevision(workspaceId);
  if (localRevision === null) {
    throw new Error(`workspace not replicated on this device: ${workspaceId}`);
  }
  if (localRevision !== manifest.workspaceDefinitionRevision) {
    throw new Error(
      `definition-not-converged: local ${localRevision} != manifest ${manifest.workspaceDefinitionRevision}`,
    );
  }

  const defs = new Map(
    (
      getDb()
        .prepare(
          `SELECT portable_id, mapped_repo_id FROM workspace_repo_definitions
           WHERE workspace_id = ?`,
        )
        .all(workspaceId) as Array<{ portable_id: string; mapped_repo_id: string | null }>
    ).map((d) => [d.portable_id, { mapped_repo_id: d.mapped_repo_id }]),
  );
  const userDataDir = workerContext()?.userDataDir;
  const managedRoot =
    userDataDir === undefined ? null : join(userDataDir, 'mesh-checkouts', workspaceId);
  if (manifest.repositories.length === 0) {
    throw new Error('start-session requires at least one pinned repository');
  }
  const repoPaths: string[] = [];
  const resumeThreadId = manifest.inputs['resumeThreadId'];
  const handoffId = manifest.inputs['handoffId'];
  const savedCheckouts =
    typeof resumeThreadId === 'string' && resumeThreadId.length > 0
      ? await readRemoteSessionCheckouts({
          workspaceId,
          provider,
          providerThreadId: resumeThreadId,
          repositoryIds: manifest.repositories.map((repo) => repo.repositoryId),
        })
      : typeof handoffId === 'string' && handoffId.length > 0
        ? await readRemoteSessionCheckouts({
            workspaceId,
            provider,
            providerThreadId: `handoff:${handoffId}`,
            repositoryIds: manifest.repositories.map((repo) => repo.repositoryId),
          })
        : null;
  if (typeof resumeThreadId === 'string' && resumeThreadId.length > 0 && savedCheckouts === null)
    throw new Error('provider-session-checkout-missing');
  const sessionCheckouts: RemoteSessionCheckout[] = [];
  for (const repo of manifest.repositories) {
    const saved = savedCheckouts?.find((checkout) => checkout.repositoryId === repo.repositoryId);
    const path =
      saved?.path ??
      (await resolveSessionCheckout(repo.repositoryId, repo.commit, defs, managedRoot));
    repoPaths.push(path);
    sessionCheckouts.push({
      repositoryId: repo.repositoryId,
      path,
      mappedRepoId: defs.get(repo.repositoryId)?.mapped_repo_id ?? null,
    });
  }
  const cwd = commonParentDir(repoPaths);

  // SESSION-03 target activation: a start-session job carrying a handoffId
  // continues a session whose ownership was transferred to this device.
  // Gate BEFORE spawn: the handoff row must show ownership-transferred to
  // us; we advance to target-activating so a crash here is reconstructable.
  let handoffCheckpoint: SessionCheckpoint | null = null;
  let handoffTargetGeneration: number | null = null;
  let handoffSessionId: string | null = null;
  if (typeof handoffId === 'string' && handoffId.length > 0) {
    const ctx = workerContext();
    const remote = (await meshRpc<HandoffGetResult>('handoff.get', { handoffId })).handoff;
    if (remote.targetEnrollmentId !== ctx?.enrollmentId) {
      throw new Error('handoff-not-for-this-device');
    }
    const privateCheckpoint = manifest.inputs['handoffCheckpoint'];
    const openPrivateCheckpoint = (): SessionCheckpoint | null => {
      if (privateCheckpoint === undefined) return null;
      if (privateCheckpoint === null || typeof privateCheckpoint !== 'object')
        throw new Error('invalid-private-handoff-checkpoint');
      const candidate = privateCheckpoint as SessionCheckpoint;
      const expectedPins = new Map(
        manifest.repositories.map((pin) => [pin.repositoryId, pin.commit]),
      );
      const seenCheckpointPins = new Set<string>();
      if (
        candidate.sessionId !== remote.sessionId ||
        candidate.sourceGeneration !== remote.sourceGeneration ||
        !Array.isArray(candidate.repositories) ||
        candidate.repositories.length === 0 ||
        candidate.repositories.some((pin) => {
          if (
            typeof pin.repositoryId !== 'string' ||
            typeof pin.commit !== 'string' ||
            seenCheckpointPins.has(pin.repositoryId)
          )
            return true;
          seenCheckpointPins.add(pin.repositoryId);
          const expectedCommit = expectedPins.get(pin.repositoryId);
          return expectedCommit === undefined || pin.commit !== expectedCommit;
        })
      )
        throw new Error('private-handoff-checkpoint-does-not-match-authority');
      return candidate;
    };
    if (remote.state === 'ownership-transferred') {
      const activating = (
        await meshRpc<HandoffAdvanceResult>('handoff.advance', {
          handoffId,
          from: 'ownership-transferred',
          to: 'target-activating',
        })
      ).handoff;
      appendJournal(attemptId, 'handoff-activating', { handoffId });
      handoffCheckpoint =
        openPrivateCheckpoint() ??
        openHandoffCheckpoint(activating.checkpoint, handoffId, ctx?.scope);
      handoffTargetGeneration = activating.targetGeneration;
      handoffSessionId = activating.sessionId;
    } else if (remote.state === 'target-activating') {
      // Re-claim after an earlier activating attempt — the journal's
      // prior-spawn check below still applies.
      handoffCheckpoint =
        openPrivateCheckpoint() ?? openHandoffCheckpoint(remote.checkpoint, handoffId, ctx?.scope);
      handoffTargetGeneration = remote.targetGeneration;
      handoffSessionId = remote.sessionId;
    } else {
      throw new Error(`handoff-not-transferred: state ${remote.state}`);
    }
    if (handoffSessionId !== null && handoffTargetGeneration !== null && ctx !== null) {
      // The target's verified activation gate is the ownership boundary. A
      // provider startup failure stays retryable on this device and must not
      // make the relinquished source appear to own the transferred session.
      writeSessionOwnership(handoffSessionId, handoffTargetGeneration, ctx.enrollmentId, 'owned');
      persistRemoteSessionCheckouts({
        workspaceId,
        provider,
        providerThreadId: `handoff:${handoffId}`,
        checkouts: sessionCheckouts,
      });
    }
  }

  const prior = priorSessionEvidence(job.id, attemptId);
  if (prior.unresolvedSpawn) {
    // A prior attempt spawned a provider and never recorded the thread —
    // its process may still hold the checkout. Spec §9: inspect first.
    throw new Error('prior-spawn-unresolved: inspect the orphaned provider process first');
  }

  const authMode = manifest.inputs['authMode'];
  let codexAuthJson: string | undefined;
  let codexAuthHome: string | undefined;
  let providerAuth: RemoteProviderAuth | undefined;
  let providerDataHome: string | undefined;
  if (authMode === 'openai-api-key') await awaitRemoteApiKey(attempt);
  if (authMode === 'codex-host-auth') {
    codexAuthJson = await awaitRemoteCodexHostAuth(attempt);
    const authSessionId = codexAuthSessionId(
      manifest.inputs,
      handoffSessionId,
      handoffId,
      prior.resumeThreadId,
    );
    const ctx = workerContext();
    codexAuthHome = codexAuthHomeForSession(ctx?.userDataDir, ctx?.scope, authSessionId);
  }
  if (authMode === 'cloud-provider') {
    providerAuth = await awaitRemoteProviderAuth(attempt, provider);
    if (provider === 'devin') {
      const authSessionId = codexAuthSessionId(
        manifest.inputs,
        handoffSessionId,
        handoffId,
        prior.resumeThreadId,
      );
      const ctx = workerContext();
      providerDataHome = providerDataHomeForSession(ctx?.userDataDir, ctx?.scope, authSessionId);
    }
  }

  const sessionModel =
    provider === 'azure' && typeof providerAuth?.env.AZURE_OPENAI_DEPLOYMENT === 'string'
      ? providerAuth.env.AZURE_OPENAI_DEPLOYMENT
      : manifest.model;

  const cliVersion = await probeSessionCli(provider);
  if (cliVersion === null) {
    throw new Error(`provider-cli-unavailable: ${provider} CLI not on PATH`);
  }
  const cliMinVersion = manifest.inputs['cliMinVersion'];
  if (
    typeof cliMinVersion === 'string' &&
    cliMinVersion.length > 0 &&
    !satisfiesCliMin(cliVersion, cliMinVersion)
  ) {
    throw new Error(
      `cli-version-pin-violation: codex ${cliVersion} < pinned minimum ${cliMinVersion}`,
    );
  }

  // Journal the spawn intent BEFORE spawn (audit item 1): a crash between
  // here and `provider-thread` leaves this row as the orphan evidence.
  appendJournal(attemptId, 'provider-spawn', {
    provider,
    model: sessionModel,
    cliVersion,
    creationKey: job.requestId,
    resumeThreadId: prior.resumeThreadId,
    cwd,
  });
  emitActivity(attempt, `session: starting ${provider} on ${workspaceId}`);

  const rawTimeout = manifest.inputs['turnTimeoutMs'];
  const turnTimeoutMs = Math.min(
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : SESSION_TURN_DEFAULT_TIMEOUT_MS,
    SESSION_TURN_MAX_TIMEOUT_MS,
  );
  const permissionMode = effectiveMeshPermissionMode({
    ...manifest.inputs,
    ...(handoffCheckpoint?.permissionMode === undefined
      ? {}
      : { permissionMode: handoffCheckpoint.permissionMode }),
  });
  const sandbox = permissionSandbox(permissionMode);
  appendJournal(attemptId, 'execution-permissions', {
    requestedMode: manifest.inputs['permissionMode'] ?? manifest.inputs['sandbox'] ?? 'on-request',
    effectiveMode: permissionMode,
    maximumMode: getMeshMaximumPermissionMode(),
  });
  const rawEffort = manifest.inputs['reasoningEffort'];

  // SESSION-03: a handoff continuation seeds a FRESH provider thread from
  // the checkpoint — cross-device provider resume is summary-continuation
  // by contract (native-resume is same-home only, SESSION-01 audit).
  const effectivePrompt =
    handoffCheckpoint === null
      ? prompt
      : renderHandoffContinuationPrompt(handoffCheckpoint, prompt);

  const result = await runRemoteSessionTurn(
    {
      provider: provider as RemoteSessionProvider,
      model: sessionModel,
      cwd,
      prompt: effectivePrompt,
      ...(manifest.inputs['authMode'] === 'target-local' ||
      manifest.inputs['authMode'] === 'codex-account' ||
      manifest.inputs['authMode'] === 'codex-host-auth' ||
      manifest.inputs['authMode'] === 'openai-api-key' ||
      manifest.inputs['authMode'] === 'cloud-provider'
        ? { authMode: manifest.inputs['authMode'] }
        : {}),
      ...(codexAuthJson === undefined ? {} : { codexAuthJson }),
      ...(codexAuthHome === undefined ? {} : { codexAuthHome }),
      ...(typeof rawEffort === 'string' ? { reasoningEffort: rawEffort as ReasoningEffort } : {}),
      sandbox,
      permissionMode,
      ...(typeof manifest.inputs['resumeThreadId'] === 'string'
        ? { resumeThreadId: manifest.inputs['resumeThreadId'] }
        : prior.resumeThreadId !== null
          ? { resumeThreadId: prior.resumeThreadId }
          : {}),
      // ENV-06: grants for this claim are in-memory only and win over
      // ambient provider credentials for the duration of the turn.
      ...(attemptGrantEnv.get(attempt.id) === undefined && providerAuth === undefined
        ? {}
        : {
            extraEnv: {
              ...(attemptGrantEnv.get(attempt.id) ?? {}),
              ...(providerAuth?.env ?? {}),
              ...(providerDataHome === undefined ? {} : { XDG_DATA_HOME: providerDataHome }),
            },
          }),
      ...(providerAuth?.devinCredentialsToml === undefined
        ? {}
        : { devinCredentialsToml: providerAuth.devinCredentialsToml }),
      turnTimeoutMs,
    },
    {
      onThreadStarted: (threadId) => {
        appendJournal(attemptId, 'provider-thread', { threadId });
        persistRemoteSessionCheckouts({
          workspaceId,
          provider,
          providerThreadId: threadId,
          checkouts: sessionCheckouts,
        });
      },
      emitActivity: (text) => emitActivity(attempt, text),
      isCancelled: () => isCancelRequested(attemptId),
      approve: (event) => approveProviderAction(job, attempt, permissionMode, event),
      authenticate: async ({ verificationUrl, userCode }) => {
        let url: URL;
        try {
          url = new URL(verificationUrl);
        } catch {
          return false;
        }
        if (url.origin !== 'https://auth.openai.com' || url.protocol !== 'https:') return false;
        const actionDigest = createHash('sha256')
          .update(canonicalJson({ jobId: job.id, attemptId, verificationUrl: url.href, userCode }))
          .digest('hex');
        return (
          (await requestAndAwaitApproval(
            job,
            attempt,
            actionDigest,
            undefined,
            undefined,
            `Open ${url.href} in your browser, enter code ${userCode}, then approve after Codex confirms sign-in.`,
          )) === 'approved'
        );
      },
    },
  );

  if (typeof result.resumeHandle === 'string' && result.resumeHandle.length > 0) {
    persistRemoteSessionCheckouts({
      workspaceId,
      provider,
      providerThreadId: result.resumeHandle,
      checkouts: sessionCheckouts,
    });
  }

  if (result.turnStatus === 'failed') {
    if (typeof handoffId === 'string' && handoffId.length > 0) {
      // Keep target-activating as the durable retry gate. The failed job is
      // visible to the controller; an explicit retry creates a fresh turn
      // from the transferred checkpoint without restoring source ownership.
      appendJournal(attemptId, 'handoff-activation-retryable', { handoffId });
    }
    throw new Error('provider-turn-failed');
  }

  if (
    typeof handoffId === 'string' &&
    handoffId.length > 0 &&
    result.turnStatus === 'completed' &&
    !result.cancelled
  ) {
    // The session is live on this device — close the handoff and record
    // local ownership of the transferred generation.
    await meshRpc<HandoffAdvanceResult>('handoff.advance', {
      handoffId,
      from: 'target-activating',
      to: 'completed',
    }).catch(() => undefined);
    appendJournal(attemptId, 'handoff-completed', {
      handoffId,
      sessionId: handoffSessionId,
      generation: handoffTargetGeneration,
    });
  }

  const boundedOutput = boundedRemoteAssistantOutput(result.assistantOutput);
  return {
    ok: result.turnStatus === 'completed' && !result.cancelled,
    workspaceId,
    providerThreadId: result.providerThreadId,
    resumeHandle: result.resumeHandle,
    assistantOutput: boundedOutput.text,
    assistantOutputTruncated: boundedOutput.truncated,
    turnId: result.turnId,
    turnStatus: result.turnStatus,
    cliVersion: result.cliVersion,
    cancelled: result.cancelled,
    ...(handoffSessionId === null ? {} : { handoffSessionId }),
  };
}

/**
 * Opens a handoff checkpoint for the continuation prompt. A sealed
 * checkpoint is unsealed under the ADK bound to `handoffId`; a missing
 * key or tamper fails the activation rather than feeding the provider
 * garbage. Plaintext checkpoints pass through (self-host / pre-E2E).
 */
function openHandoffCheckpoint(
  checkpoint: HandoffCheckpoint | null,
  handoffId: string,
  scope: SyncScope | undefined,
): SessionCheckpoint | null {
  if (checkpoint === null) return null;
  if (!isSealedCheckpoint(checkpoint)) return checkpoint;
  if (scope === undefined) {
    throw new Error('handoff checkpoint is sealed but this device has no sync scope');
  }
  const opened = unsealScopedJson(scope, `anvil/checkpoint/v1:${handoffId}`, checkpoint);
  return opened as SessionCheckpoint;
}

/**
 * Seeds a fresh provider thread with the handed-off context: the source
 * device's summary and bounded message tail plus the new instruction. The
 * exact-commit manifest is already verified by checkout resolution.
 */
function renderHandoffContinuationPrompt(
  checkpoint: SessionCheckpoint,
  instruction: string,
): string {
  const parts = ['This session was handed off from another device at an exact-commit checkpoint.'];
  if (typeof checkpoint.summary === 'string' && checkpoint.summary.length > 0) {
    parts.push(`Prior context summary:\n${checkpoint.summary}`);
  }
  const tail = (checkpoint.messages ?? []).slice(-8);
  if (tail.length > 0) {
    parts.push(
      `Recent conversation:\n${tail
        .map((m) => {
          const msg = m as { role?: unknown; content?: unknown };
          return `${typeof msg.role === 'string' ? msg.role : 'unknown'}: ${typeof msg.content === 'string' ? msg.content : ''}`;
        })
        .join('\n')}`,
    );
  }
  if (typeof checkpoint.planGoalState === 'string' && checkpoint.planGoalState.length > 0) {
    parts.push(`Plan/goal state: ${checkpoint.planGoalState}`);
  }
  parts.push(`Continue the work. Instruction: ${instruction}`);
  return parts.join('\n\n');
}

// ---- FLOW-01: code-task — attempt-scoped worktrees + result manifest ------

/**
 * `code-task`: one write-capable provider turn executed in a per-attempt
 * worktree per pinned repository. The source checkouts are never mutated
 * — the attempt gets `mesh/attempt/<attemptId>` branches created at the
 * pinned commits, the provider turn runs with cwd inside the attempt
 * trees, residual changes are committed onto the attempt branch, and the
 * durable output is a result manifest (base→result commits, declared
 * verification outcomes, provenance) — not a textual claim (spec §455).
 *
 * Failure leaves every allocated worktree in place, journaled — preserved
 * evidence a retry does not touch (the retry's attempt id names its own
 * trees).
 */
async function executeCodeTask(
  job: MeshJob,
  attempt: ExecutionAttempt,
): Promise<Record<string, unknown>> {
  const attemptId = attempt.id;
  const manifest = job.inputManifest;
  const startedAt = new Date().toISOString();
  const workspaceId = manifest.inputs['workspaceId'];
  const prompt = manifest.inputs['prompt'];
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new Error('code-task requires manifest.inputs.workspaceId');
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('code-task requires manifest.inputs.prompt');
  }
  const provider = manifest.provider;
  if (provider !== 'codex' && provider !== 'azure' && provider !== 'openai') {
    throw new Error(`provider-unsupported-remote: ${provider}`);
  }
  const refPolicy = manifest.inputs['refPolicy'] ?? 'local-branches';
  if (refPolicy !== 'local-branches') {
    // §455: remote refs require explicit policy — nothing else exists yet.
    throw new Error(`ref-policy-unsupported: ${String(refPolicy)}`);
  }
  const resultTransfer = manifest.inputs['resultTransfer'] ?? 'manifest-only';
  if (resultTransfer !== 'manifest-only' && resultTransfer !== 'bundle-artifacts') {
    throw new Error(`result-transfer-unsupported: ${String(resultTransfer)}`);
  }

  const localRevision = workspaceDefinitionRevision(workspaceId);
  if (localRevision === null) {
    throw new Error(`workspace not replicated on this device: ${workspaceId}`);
  }
  if (localRevision !== manifest.workspaceDefinitionRevision) {
    throw new Error(
      `definition-not-converged: local ${localRevision} != manifest ${manifest.workspaceDefinitionRevision}`,
    );
  }

  const userDataDir = workerContext()?.userDataDir;
  if (userDataDir === undefined) {
    throw new Error('worker context has no userDataDir for attempt worktrees');
  }
  const managedRoot = join(userDataDir, 'mesh-checkouts', workspaceId);
  const worktreeRoot = join(userDataDir, 'mesh-worktrees', attemptId);

  const defs = new Map(
    (
      getDb()
        .prepare(
          `SELECT portable_id, mapped_repo_id FROM workspace_repo_definitions
           WHERE workspace_id = ?`,
        )
        .all(workspaceId) as Array<{ portable_id: string; mapped_repo_id: string | null }>
    ).map((d) => [d.portable_id, { mapped_repo_id: d.mapped_repo_id }]),
  );
  if (manifest.repositories.length === 0) {
    throw new Error('code-task requires at least one pinned repository');
  }
  const sources: Array<{ repositoryId: string; sourcePath: string; commit: string }> = [];
  for (const repo of manifest.repositories) {
    sources.push({
      repositoryId: repo.repositoryId,
      sourcePath: await resolveSessionCheckout(repo.repositoryId, repo.commit, defs, managedRoot),
      commit: repo.commit,
    });
  }
  if (isCancelRequested(attemptId)) return { ok: false, cancelled: true };

  // Attempt-scoped isolation: one branch+worktree per repo, allocated at
  // the pinned commit, journaled as it lands so a crash mid-allocation is
  // reconstructable.
  const worktrees = await allocateAttemptWorktrees({
    attemptId,
    rootDir: worktreeRoot,
    repositories: sources,
    onAllocated: (worktree) => {
      appendJournal(attemptId, 'worktree-allocated', {
        repositoryId: worktree.repositoryId,
        worktreePath: worktree.worktreePath,
        branch: worktree.branch,
        baseCommit: worktree.baseCommit,
      });
      emitActivity(attempt, `task: worktree ready for ${worktree.repositoryId}`);
    },
  });
  const cwd = commonParentDir(worktrees.map((w) => w.worktreePath));

  const prior = priorSessionEvidence(job.id, attemptId);
  if (prior.unresolvedSpawn) {
    throw new Error('prior-spawn-unresolved: inspect the orphaned provider process first');
  }
  const cliVersion = await probeSessionCli();
  if (cliVersion === null) {
    throw new Error('provider-cli-unavailable: codex not on PATH');
  }
  const cliMinVersion = manifest.inputs['cliMinVersion'];
  if (
    typeof cliMinVersion === 'string' &&
    cliMinVersion.length > 0 &&
    !satisfiesCliMin(cliVersion, cliMinVersion)
  ) {
    throw new Error(
      `cli-version-pin-violation: codex ${cliVersion} < pinned minimum ${cliMinVersion}`,
    );
  }

  appendJournal(attemptId, 'provider-spawn', {
    provider,
    model: manifest.model,
    cliVersion,
    creationKey: job.requestId,
    resumeThreadId: prior.resumeThreadId,
    cwd,
  });
  emitActivity(attempt, `task: starting ${provider} in attempt worktrees`);

  const rawTimeout = manifest.inputs['turnTimeoutMs'];
  const turnTimeoutMs = Math.min(
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : SESSION_TURN_DEFAULT_TIMEOUT_MS,
    SESSION_TURN_MAX_TIMEOUT_MS,
  );
  const permissionMode = effectiveMeshPermissionMode(manifest.inputs);
  const sandbox = permissionSandbox(permissionMode);
  appendJournal(attemptId, 'execution-permissions', {
    requestedMode: manifest.inputs['permissionMode'] ?? manifest.inputs['sandbox'] ?? 'on-request',
    effectiveMode: permissionMode,
    maximumMode: getMeshMaximumPermissionMode(),
  });
  const rawEffort = manifest.inputs['reasoningEffort'];

  const turnFailure: { error: Error | null } = { error: null };
  const result = await runRemoteSessionTurn(
    {
      provider: provider as RemoteSessionProvider,
      model: manifest.model,
      cwd,
      prompt,
      ...(typeof rawEffort === 'string' ? { reasoningEffort: rawEffort as ReasoningEffort } : {}),
      sandbox,
      permissionMode,
      ...(prior.resumeThreadId !== null ? { resumeThreadId: prior.resumeThreadId } : {}),
      // ENV-06: grants for this claim are in-memory only and win over
      // ambient provider credentials for the duration of the turn.
      ...(attemptGrantEnv.get(attempt.id) === undefined
        ? {}
        : { extraEnv: attemptGrantEnv.get(attempt.id) }),
      turnTimeoutMs,
    },
    {
      onThreadStarted: (threadId) => {
        appendJournal(attemptId, 'provider-thread', { threadId });
      },
      emitActivity: (text) => emitActivity(attempt, text),
      isCancelled: () => isCancelRequested(attemptId),
      approve: (event) => approveProviderAction(job, attempt, permissionMode, event),
    },
  ).catch((error) => {
    turnFailure.error = error instanceof Error ? error : new Error(String(error));
    return null;
  });

  if (result === null || result.turnStatus === 'failed' || result.cancelled) {
    // The attempt's trees stay on disk — journaled paths are the
    // inventory an operator (or a future retention sweep) inspects.
    appendJournal(attemptId, 'worktrees-preserved', {
      paths: worktrees.map((w) => w.worktreePath),
      reason: result === null ? (turnFailure.error?.message ?? 'turn-error') : result.turnStatus,
    });
    if (result !== null && result.cancelled) {
      return { ok: false, cancelled: true };
    }
    throw turnFailure.error ?? new Error('provider-turn-failed');
  }

  // Commit residual changes onto each attempt branch and capture the
  // result pins — the manifest records commits, not claims.
  const finalized = await finalizeAttemptWorktrees(worktrees, attemptId);
  for (const repo of finalized) {
    appendJournal(attemptId, 'result-commit', {
      repositoryId: repo.repositoryId,
      baseCommit: repo.baseCommit,
      resultCommit: repo.resultCommit,
      branch: repo.branch,
      changed: repo.changed,
      residualCommitted: repo.residualCommitted,
    });
  }
  emitActivity(
    attempt,
    `task: ${finalized.filter((r) => r.changed).length}/${finalized.length} repositories changed`,
  );

  // Declared verification runs in each attempt worktree under the
  // restricted exec env; every outcome is recorded honestly.
  const verificationCommands = Array.isArray(manifest.inputs['verification'])
    ? (manifest.inputs['verification'] as unknown[]).filter(
        (cmd): cmd is string => typeof cmd === 'string' && cmd.length > 0,
      )
    : [];
  const verification: ResultManifestVerification[] = [];
  for (const repo of finalized) {
    for (const command of verificationCommands) {
      if (isCancelRequested(attemptId)) return { ok: false, cancelled: true };
      const outcome = await runVerificationCommand({
        repositoryId: repo.repositoryId,
        command,
        cwd: repo.worktreePath,
        target: { kind: 'remote-job', jobId: job.id, attemptId },
        permissionMode,
        isCancelled: () => isCancelRequested(attemptId),
        approve: async () => {
          const digest = createHash('sha256')
            .update(
              canonicalJson({
                jobId: job.id,
                attemptId,
                repositoryId: repo.repositoryId,
                cwd: repo.worktreePath,
                command,
                permissionMode,
              }),
            )
            .digest('hex');
          return (
            (await requestAndAwaitApproval(
              job,
              attempt,
              digest,
              undefined,
              undefined,
              `Verification command:\n${command}\nWorking directory: ${repo.worktreePath}`,
            )) === 'approved' && !isCancelRequested(attemptId)
          );
        },
      });
      verification.push({
        repositoryId: outcome.repositoryId,
        command: outcome.command,
        approvalGranted: outcome.approvalGranted,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
      });
      appendJournal(attemptId, 'verification', {
        repositoryId: outcome.repositoryId,
        command: outcome.command,
        approvalGranted: outcome.approvalGranted,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
        logTail: outcome.logTail,
      });
    }
  }
  if (isCancelRequested(attemptId)) return { ok: false, cancelled: true };

  // FLOW-02 result transfer: with `bundle-artifacts` declared, each
  // attempt branch is packed as a thin bundle (rooted on the pinned base
  // the parent provably holds) and published as an R2 artifact — the
  // fetchable ref transport. Publication happens while the attempt is
  // still active (artifact.reserve rejects terminal attempts).
  const artifacts: Array<{ artifactId: string; label: string }> = [];
  if (resultTransfer === 'bundle-artifacts') {
    const bundleDir = join(worktreeRoot, 'bundles');
    mkdirSync(bundleDir, { recursive: true });
    for (const [index, repo] of finalized.entries()) {
      // An unchanged repo transfers nothing — its range is empty and a
      // bundle would carry no commits. The manifest records base==result.
      if (!repo.changed) continue;
      const { bundlePath, ref } = await createAttemptBundle(
        repo,
        join(bundleDir, `${index}-${repo.repositoryId}.bundle`),
      );
      try {
        const uploaded = await uploadAttemptArtifact({
          attemptId,
          bytes: readFileSync(bundlePath),
          mediaType: 'application/vnd.git-bundle',
        });
        artifacts.push({ artifactId: uploaded.id, label: `bundle:${repo.repositoryId}` });
        appendJournal(attemptId, 'result-bundle-published', {
          repositoryId: repo.repositoryId,
          artifactId: uploaded.id,
          ref,
        });
      } catch (error) {
        // Publication failure is a transfer failure, not silent absence —
        // journal it; the manifest still records the local refs.
        appendJournal(attemptId, 'result-bundle-failed', {
          repositoryId: repo.repositoryId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const ctx = workerContext();
  const resultManifest: AttemptResultManifest = {
    schemaVersion: 1,
    jobId: job.id,
    attemptId,
    repositories: finalized.map((repo) => ({
      repositoryId: repo.repositoryId,
      baseCommit: repo.baseCommit,
      resultCommit: repo.resultCommit,
      branch: repo.branch,
      changed: repo.changed,
    })),
    verification,
    artifacts,
    provenance: {
      workerEnrollmentId: ctx?.enrollmentId ?? 'unknown',
      workerIncarnation: attempt.workerIncarnation,
      cliVersion: result.cliVersion,
      startedAt,
      completedAt: new Date().toISOString(),
    },
  };
  appendJournal(attemptId, 'result-manifest', {
    repositories: resultManifest.repositories,
    verificationCount: verification.length,
  });
  emitActivity(attempt, 'task: result manifest recorded');

  return {
    ok: true,
    workspaceId,
    providerThreadId: result.providerThreadId,
    turnId: result.turnId,
    turnStatus: result.turnStatus,
    cliVersion: result.cliVersion,
    cancelled: false,
    resultManifest,
    // The attempt trees persist for inspection/integration — the paths are
    // part of the result so the source can locate the refs.
    worktrees: finalized.map((repo) => ({
      repositoryId: repo.repositoryId,
      worktreePath: repo.worktreePath,
      branch: repo.branch,
    })),
  };
}

const execFileAsync = promisify(execFile);

async function gitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
      timeout: 10_000,
      env: { PATH: process.env['PATH'] ?? '', GIT_TERMINAL_PROMPT: '0' },
    });
    return String(stdout).trim();
  } catch {
    return null;
  }
}

/**
 * Coordinator-visible copy of an attempt result: verification commands and
 * other free-text detail ride the sealed result envelope, so the public
 * copy carries only bounded metadata.
 */
function publicResultSummary(result: Record<string, unknown>): Record<string, unknown> {
  const redactVerification = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = { ...record };
    if (Array.isArray(record['verification'])) {
      out['verification'] = (record['verification'] as ResultManifestVerification[]).map((v) => ({
        ...v,
        command: '[task-sealed]',
      }));
    }
    for (const [key, nested] of Object.entries(record)) {
      if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
        out[key] = redactVerification(nested);
      }
    }
    return out;
  };
  return redactVerification(result) as Record<string, unknown>;
}

async function reportAttempt(
  attemptId: string,
  outcome: 'completed' | 'failed',
  result: Record<string, unknown>,
  job?: MeshJob,
): Promise<void> {
  const db = getDb();
  const row = db
    .prepare('SELECT job_id, incarnation, fence FROM mesh_attempts WHERE id = ?')
    .get(attemptId) as { job_id: string; incarnation: string; fence: number } | undefined;
  if (!row) return;
  const ctx = workerContext();
  await flushActivityAppend(attemptId);
  const taskKey =
    job !== undefined && ctx?.scope !== undefined ? taskKeyFor(ctx.scope, job.id) : null;
  const sealedResult =
    taskKey !== null && job !== undefined && ctx?.scope !== undefined
      ? sealTaskResult(ctx.scope, job.id, attemptId, taskKey, result)
      : undefined;
  const publicResult = sealedResult === undefined ? result : publicResultSummary(result);
  try {
    // Local policy cancellation must also reach the coordinator before a clean
    // stop is reported, otherwise it would be mistaken for successful completion.
    if (job !== undefined && isCancelRequested(attemptId))
      await meshRpc('job.cancel', { jobId: job.id });
    const report = await meshRpc<{ status: string }>('attempt.report', {
      attemptId,
      incarnation: row.incarnation,
      fence: row.fence,
      outcome,
      result: publicResult,
      ...(sealedResult === undefined ? {} : { sealedResult }),
      ...(outcome === 'failed' && typeof result['error'] === 'string'
        ? { error: result['error'] }
        : {}),
    });
    ctx?.publishAttemptLifecycle?.({
      attemptId,
      jobId: row.job_id,
      outcome,
      status: report.status,
    });
    if (report.status === 'late-result-retained') {
      // Fence was stale — the backend kept the result for forensics but the
      // attempt is already terminal there.
      appendJournal(attemptId, 'report-late-result');
      updateAttemptState(attemptId, 'unknown-outcome');
    }
  } catch (error) {
    // A rejected report (stale fence, expired lease) leaves the local row
    // terminal with its journal — the backend retains it as a late result.
    appendJournal(attemptId, 'report-rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof BackendRpcError && !error.retryable) {
      updateAttemptState(attemptId, 'unknown-outcome');
    }
  }
}

/**
 * Boot-time reconciliation: attempts still marked active were interrupted by
 * a crash/quit. The incarnation lease is certainly dead, so fences are stale —
 * mark them `unknown-outcome` locally and best-effort report the retained
 * result so the backend keeps it for forensics.
 */
export async function reconcileMeshAttemptsOnBoot(): Promise<void> {
  for (const attempt of activeAttempts()) {
    appendJournal(attempt.id, 'reconciled-on-boot');
    updateAttemptState(attempt.id, 'unknown-outcome');
    if (attempt.result_json !== null && isMeshWorkerEnabled()) {
      void meshRpc('attempt.report', {
        attemptId: attempt.id,
        incarnation: attempt.incarnation,
        fence: attempt.fence,
        outcome: 'failed',
        result: { error: 'interrupted; recovered on boot' },
      }).catch(() => undefined);
    }
  }
}

export function resetMeshWorkerForTests(): void {
  policyPublishPending = false;
  for (const waiters of approvalWaiters.values()) {
    for (const wake of waiters) wake();
  }
  approvalWaiters.clear();
  stopHeartbeat();
  connectInFlight = null;
  contextProvider = null;
  activitySequences.clear();
  clearActivityAppendQueues();
  controlSequences.clear();
  attemptGrantEnv.clear();
  attemptCodexHostAuthJson.clear();
}

/** Test seam: one heartbeat tick without waiting for the 30s interval. */
export function meshWorkerHeartbeatForTests(): Promise<void> {
  return heartbeat();
}

/** Test seam: the approval wait with injectable poll timing. */
export function requestApprovalForTests(
  job: MeshJob,
  attempt: ExecutionAttempt,
  actionDigest: string,
  pollMs: number,
  capMs: number,
): Promise<'approved' | 'denied'> {
  return requestAndAwaitApproval(job, attempt, actionDigest, pollMs, capMs);
}

// ---- source side ------------------------------------------------------------

// `job.create`/`job.get` are account ops, not worker ops — any enrolled device
// may request work. The diagnostic kind is the MESH-02 pipeline proof; richer
// kinds (prepare-workspace, start-session, workflow-node) land with SESSION-02+.

/**
 * Local TCK store key used before the backend job id exists. The dispatch
 * path persists its job.create request before submitting; keying the TCK
 * by request id means a crash between seal and create can still deliver
 * (and re-derive) the key.
 */
function taskKeyStoreId(requestId: string): string {
  return `req:${requestId}`;
}

interface SealedJobRequest {
  requestId: string;
  kind: JobCreateParams['kind'];
  requestedTarget: RequestedTarget;
  manifest: ExecutionManifest;
  /**
   * Sensitive inputs sealed under a fresh task content key (TCK). With a
   * sync scope these travel in `sealedInputs`; without one (self-hosted /
   * account-less backend) they fall back to plaintext manifest inputs —
   * the coordinator is the user's own in that mode.
   */
  privateInputs?: Record<string, unknown>;
  /** Additional enrollments authorised to receive the TCK. */
  resultRecipients?: string[];
  retryPolicy?: JobCreateParams['retryPolicy'];
}

/**
 * Delivers the job's TCK to the resolved target plus declared result
 * recipients. Idempotent — the backend dedupes wraps per (job, target);
 * recipients whose device identity is not yet replicated are retried on
 * the next observation (`job.get`, dispatch refresh).
 */
async function deliverTaskKeys(scope: SyncScope, job: JobSummary): Promise<void> {
  const ctx = workerContext();
  const taskKey = taskKeyFor(scope, job.id) ?? taskKeyFor(scope, taskKeyStoreId(job.requestId));
  if (taskKey === null) return;
  storeTaskKey(scope, job.id, taskKey);
  const pubs = new Map(listDeviceIdentities(scope).map((d) => [d.enrollmentId, d.pub]));
  const recipients = new Set<string>(job.resultRecipients ?? []);
  if (job.targetEnrollmentId !== undefined) recipients.add(job.targetEnrollmentId);
  if (ctx !== null) recipients.delete(ctx.enrollmentId);
  const wraps: TaskKeyWrapPayload[] = [];
  for (const enrollmentId of recipients) {
    const pub = pubs.get(enrollmentId);
    if (pub === undefined) continue;
    wraps.push(
      sealTaskKeyWrap({
        scope,
        jobId: job.id,
        targetEnrollmentId: enrollmentId,
        recipientPubB64: pub,
        taskKey,
      }),
    );
  }
  if (wraps.length === 0) return;
  await meshRpc<TaskKeyDeliverResult>('taskkey.deliver', { jobId: job.id, wraps });
}

/**
 * Source-side key delivery is lazily retried whenever the job is observed:
 * `kind:'auto'`/`kind:'environment'` jobs resolve their target after
 * creation, and peers' identities replicate asynchronously.
 */
export async function ensureTaskKeyDelivery(job: JobSummary): Promise<void> {
  const ctx = workerContext();
  if (ctx?.scope === undefined || job.keyDelivery !== 'pending') return;
  await deliverTaskKeys(ctx.scope, job).catch(() => undefined);
}

/**
 * Builds the byte-exact `job.create` params for a request — sealing
 * private inputs under a fresh TCK when a sync scope exists and persisting
 * that key under the request id BEFORE any submission. The dispatch path
 * stores the returned params so a crash before/after `job.create` replays
 * deterministically (same requestId + payloadHash → same job).
 */
export function prepareSealedJob(request: SealedJobRequest): JobCreateParams {
  const scope = workerContext()?.scope;
  const privateInputs = request.privateInputs ?? {};
  const manifest = request.manifest;
  let sealedInputs: SealedTaskPayload | undefined;
  if (Object.keys(privateInputs).length > 0) {
    if (scope === undefined) {
      // Fail closed: private inputs never ride the coordinator-visible
      // manifest — without a sync scope there is no TCK to seal under.
      throw new Error('job has private inputs but no sync scope is available to seal them');
    }
    const taskKey = mintTaskKey();
    sealedInputs = sealTaskInputs(scope, request.requestId, taskKey, privateInputs);
    storeTaskKey(scope, taskKeyStoreId(request.requestId), taskKey);
  }
  // The backend verifies the hash covers the canonical job payload — a
  // replay of the same requestId with a different payload is a conflict.
  const payloadHash = createHash('sha256')
    .update(
      canonicalJson({
        kind: request.kind,
        requestedTarget: request.requestedTarget,
        inputManifest: manifest,
        ...(sealedInputs === undefined ? {} : { sealedInputs }),
        ...(request.resultRecipients === undefined
          ? {}
          : { resultRecipients: request.resultRecipients }),
      }),
      'utf8',
    )
    .digest('hex');
  return {
    requestId: request.requestId,
    payloadHash,
    kind: request.kind,
    requestedTarget: request.requestedTarget,
    inputManifest: manifest,
    ...(sealedInputs === undefined ? {} : { sealedInputs }),
    ...(request.resultRecipients === undefined
      ? {}
      : { resultRecipients: request.resultRecipients }),
    retryPolicy: request.retryPolicy,
  };
}

/** Sends a prepared `job.create` and delivers TCK wraps. */
export async function submitPreparedJob(params: JobCreateParams): Promise<JobSummary> {
  const result = await meshRpc<{ job: JobSummary }>('job.create', params);
  const scope = workerContext()?.scope;
  if (scope !== undefined) {
    await deliverTaskKeys(scope, result.job).catch(() => undefined);
  }
  return result.job;
}

/**
 * `job.create` with E2E input sealing. The coordinator's manifest carries
 * only allowlisted routing keys; sensitive inputs are sealed under a fresh
 * TCK bound to the request id, the TCK is persisted before submission, and
 * key wraps are delivered to the target/result recipients after the job
 * id exists.
 */
export async function submitSealedJob(request: SealedJobRequest): Promise<JobSummary> {
  return submitPreparedJob(prepareSealedJob(request));
}

export interface DiagnosticJobInput {
  requestId: string;
  targetEnrollmentId?: string;
  /** PLACE-01: hard capability constraints for auto placement. */
  requirements?: CapabilityRequirements;
  manifest?: Partial<ExecutionManifest>;
}

/**
 * Creates a diagnostic job against a target enrollment (or auto placement).
 * Idempotent by requestId + payload hash — safe to retry after a lost
 * response without duplicating work.
 */
export async function createDiagnosticJob(input: DiagnosticJobInput): Promise<JobSummary> {
  const manifest: ExecutionManifest = {
    workspaceDefinitionRevision: 'diagnostic',
    repositories: [],
    bootstrapDigest: 'diagnostic',
    provider: 'local',
    model: 'none',
    configVersions: {},
    inputs: {},
    ...(input.manifest ?? {}),
  };
  const requestedTarget =
    input.targetEnrollmentId !== undefined
      ? { kind: 'device' as const, enrollmentId: input.targetEnrollmentId }
      : {
          kind: 'auto' as const,
          ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
        };
  return submitSealedJob({
    requestId: input.requestId,
    kind: 'diagnostic',
    requestedTarget,
    manifest,
    retryPolicy: 'never',
  });
}

export interface PrepareWorkspaceJobInput {
  requestId: string;
  permissionMode?: PermissionMode;
  workspaceId: string;
  /** Explicit device target; omitted = automatic placement. */
  targetEnrollmentId?: string;
  requirements?: CapabilityRequirements;
  provider?: string;
  model?: string;
}

/**
 * `prepare-workspace` (SESSION-02): pins the workspace's current definition
 * revision and every repository's resolved HEAD. Unmapped local definitions
 * cannot be pinned — the source can only commit to what it can prove.
 */
export async function preparePrepareWorkspaceJob(
  input: PrepareWorkspaceJobInput,
): Promise<JobCreateParams> {
  const revision = workspaceDefinitionRevision(input.workspaceId);
  if (revision === null) {
    throw new Error(`workspace not found: ${input.workspaceId}`);
  }
  const commits = await resolveWorkspaceCommits(input.workspaceId);
  const defs = getDb()
    .prepare(
      `SELECT portable_id, mapped_repo_id FROM workspace_repo_definitions WHERE workspace_id = ?`,
    )
    .all(input.workspaceId) as Array<{ portable_id: string; mapped_repo_id: string | null }>;
  const repositories = defs.map((def) => {
    const commit = commits[def.portable_id];
    if (def.mapped_repo_id === null || commit === undefined) {
      throw new Error(
        `repository ${def.portable_id} has no resolved commit on this device — map a checkout first`,
      );
    }
    return { repositoryId: def.portable_id, commit };
  });
  const recipe = getWorkspaceBootstrap(input.workspaceId);
  const policy = bootstrapManifestPolicy();
  const bootstrapDigest =
    recipe === null
      ? 'none'
      : computeBootstrapDigest({
          recipe,
          repositoryCommits: commits,
          executionPolicy: policy,
        });
  const manifest: ExecutionManifest = {
    workspaceDefinitionRevision: revision,
    repositories,
    bootstrapDigest,
    provider: input.provider ?? 'local',
    model: input.model ?? 'none',
    configVersions: {},
    inputs: { workspaceId: input.workspaceId },
  };
  const requestedTarget =
    input.targetEnrollmentId !== undefined
      ? { kind: 'device' as const, enrollmentId: input.targetEnrollmentId }
      : {
          kind: 'auto' as const,
          ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
        };
  return prepareSealedJob({
    requestId: input.requestId,
    kind: 'prepare-workspace',
    requestedTarget,
    manifest,
    privateInputs: {
      permissionMode: input.permissionMode ?? getSettings().codexMode,
      workspaceDefinition: remoteWorkspaceDefinition(input.workspaceId),
    },
    retryPolicy: 'inspect-before-retry',
  });
}

export async function createPrepareWorkspaceJob(
  input: PrepareWorkspaceJobInput,
): Promise<JobSummary> {
  return submitPreparedJob(await preparePrepareWorkspaceJob(input));
}

export interface StartSessionJobInput {
  requestId: string;
  workspaceId: string;
  /** The initial user message the remote turn runs. */
  prompt: string;
  targetEnrollmentId?: string;
  requirements?: CapabilityRequirements;
  provider?: AgentProvider;
  model?: string;
  personaId?: string;
  reasoningEffort?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  permissionMode?: PermissionMode;
  /** Pinned minimum `codex --version` the target must satisfy (audit §9). */
  cliMinVersion?: string;
  turnTimeoutMs?: number;
  /** SESSION-03: the handoff this job activates on the target. */
  handoffId?: string;
  /** Controller-verified same-device provider session id for a follow-up. */
  resumeThreadId?: string;
  authMode?:
    | 'target-local'
    | 'codex-account'
    | 'codex-host-auth'
    | 'openai-api-key'
    | 'cloud-provider';
  /** Stable source-session identity for private Codex host-auth homes. */
  authSessionId?: string;
  /** Reuse the controller's original pins for a provider-thread follow-up. */
  manifestPin?: Pick<
    ExecutionManifest,
    'workspaceDefinitionRevision' | 'repositories' | 'bootstrapDigest'
  >;
  /** Private source context carried under this activation job's task key. */
  handoffCheckpoint?: SessionCheckpoint;
}

/**
 * `job.create` for `start-session` (SESSION-02). The manifest pins the
 * canonical definition revision, exact resolved commits, the bootstrap
 * digest (the target verifies it matches the synced recipe even though
 * session start does not re-run bootstrap), and the provider/model/CLI
 * requirements the worker enforces before spawn.
 */
export async function prepareStartSessionJob(
  input: StartSessionJobInput,
): Promise<JobCreateParams> {
  const provider: RemoteSessionProvider = input.provider ?? 'codex';
  const revision =
    input.manifestPin?.workspaceDefinitionRevision ??
    workspaceDefinitionRevision(input.workspaceId);
  if (revision === null) {
    throw new Error(`workspace not found: ${input.workspaceId}`);
  }
  const commits =
    input.manifestPin === undefined
      ? await resolveWorkspaceCommits(input.workspaceId)
      : Object.fromEntries(
          input.manifestPin.repositories.map((repo) => [repo.repositoryId, repo.commit]),
        );
  const defs = getDb()
    .prepare(
      `SELECT portable_id, mapped_repo_id FROM workspace_repo_definitions WHERE workspace_id = ?`,
    )
    .all(input.workspaceId) as Array<{ portable_id: string; mapped_repo_id: string | null }>;
  const repositories =
    input.manifestPin?.repositories ??
    defs.map((def) => {
      const commit = commits[def.portable_id];
      if (def.mapped_repo_id === null || commit === undefined) {
        throw new Error(
          `repository ${def.portable_id} has no resolved commit on this device — map a checkout first`,
        );
      }
      return { repositoryId: def.portable_id, commit };
    });
  const recipe = getWorkspaceBootstrap(input.workspaceId);
  const bootstrapDigest =
    input.manifestPin?.bootstrapDigest ??
    (recipe === null
      ? 'none'
      : computeBootstrapDigest({
          recipe,
          repositoryCommits: commits,
          executionPolicy: bootstrapManifestPolicy(),
        }));
  const model =
    input.model ?? resolveSessionModel(provider as AgentProvider, getSettings().openaiModel);
  // The coordinator's manifest carries routing keys only; the prompt and
  // execution context seal under the job's task content key.
  const manifest: ExecutionManifest = {
    workspaceDefinitionRevision: revision,
    repositories,
    bootstrapDigest,
    provider,
    model,
    configVersions: {},
    inputs: { workspaceId: input.workspaceId },
  };
  const privateInputs: Record<string, unknown> = {
    prompt: input.prompt,
    ...(input.personaId === undefined ? {} : { personaId: input.personaId }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    permissionMode:
      input.permissionMode ??
      (input.sandbox === undefined
        ? getSettings().codexMode
        : requestedMeshPermissionMode({ sandbox: input.sandbox })),
    ...(input.cliMinVersion === undefined ? {} : { cliMinVersion: input.cliMinVersion }),
    ...(input.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: input.turnTimeoutMs }),
    ...(input.handoffId === undefined ? {} : { handoffId: input.handoffId }),
    ...(input.resumeThreadId === undefined ? {} : { resumeThreadId: input.resumeThreadId }),
    ...(input.authMode === undefined ? {} : { authMode: input.authMode }),
    ...(input.authSessionId === undefined ? {} : { authSessionId: input.authSessionId }),
    ...(input.handoffCheckpoint === undefined
      ? {}
      : { handoffCheckpoint: input.handoffCheckpoint }),
  };
  const requestedTarget =
    input.targetEnrollmentId !== undefined
      ? { kind: 'device' as const, enrollmentId: input.targetEnrollmentId }
      : {
          kind: 'auto' as const,
          ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
        };
  return prepareSealedJob({
    requestId: input.requestId,
    kind: 'start-session',
    requestedTarget,
    manifest,
    privateInputs,
    retryPolicy: 'inspect-before-retry',
  });
}

export async function createStartSessionJob(input: StartSessionJobInput): Promise<JobSummary> {
  return submitPreparedJob(await prepareStartSessionJob(input));
}

export interface CodeTaskJobInput {
  requestId: string;
  workspaceId: string;
  /** The task instruction the remote turn executes. */
  prompt: string;
  targetEnrollmentId?: string;
  requirements?: CapabilityRequirements;
  provider?: 'codex' | 'azure' | 'openai';
  model?: string;
  personaId?: string;
  reasoningEffort?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  permissionMode?: PermissionMode;
  cliMinVersion?: string;
  turnTimeoutMs?: number;
  /**
   * Declared verification commands run per repository worktree after the
   * turn, under the restricted exec env; outcomes go into the result
   * manifest verbatim (spec §455 — declared, honestly recorded).
   */
  verification?: string[];
}

/**
 * `job.create` for `code-task` (FLOW-01). Same pinning discipline as
 * start-session; the worker runs the turn inside per-attempt worktrees
 * and returns a result manifest. `inspect-before-retry`: a retry
 * allocates a fresh attempt-scoped tree — prior attempt work is
 * preserved, never reset.
 */
export async function createCodeTaskJob(input: CodeTaskJobInput): Promise<JobSummary> {
  const provider: RemoteSessionProvider = input.provider ?? 'codex';
  const revision = workspaceDefinitionRevision(input.workspaceId);
  if (revision === null) {
    throw new Error(`workspace not found: ${input.workspaceId}`);
  }
  const commits = await resolveWorkspaceCommits(input.workspaceId);
  const defs = getDb()
    .prepare(
      `SELECT portable_id, mapped_repo_id FROM workspace_repo_definitions WHERE workspace_id = ?`,
    )
    .all(input.workspaceId) as Array<{ portable_id: string; mapped_repo_id: string | null }>;
  const repositories = defs.map((def) => {
    const commit = commits[def.portable_id];
    if (def.mapped_repo_id === null || commit === undefined) {
      throw new Error(
        `repository ${def.portable_id} has no resolved commit on this device — map a checkout first`,
      );
    }
    return { repositoryId: def.portable_id, commit };
  });
  const recipe = getWorkspaceBootstrap(input.workspaceId);
  const bootstrapDigest =
    recipe === null
      ? 'none'
      : computeBootstrapDigest({
          recipe,
          repositoryCommits: commits,
          executionPolicy: bootstrapManifestPolicy(),
        });
  const model =
    input.model ?? resolveSessionModel(provider as AgentProvider, getSettings().openaiModel);
  const manifest: ExecutionManifest = {
    workspaceDefinitionRevision: revision,
    repositories,
    bootstrapDigest,
    provider,
    model,
    configVersions: {},
    inputs: { workspaceId: input.workspaceId },
  };
  const privateInputs: Record<string, unknown> = {
    prompt: input.prompt,
    refPolicy: 'local-branches',
    ...(input.personaId === undefined ? {} : { personaId: input.personaId }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    permissionMode:
      input.permissionMode ??
      (input.sandbox === undefined
        ? getSettings().codexMode
        : requestedMeshPermissionMode({ sandbox: input.sandbox })),
    ...(input.cliMinVersion === undefined ? {} : { cliMinVersion: input.cliMinVersion }),
    ...(input.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: input.turnTimeoutMs }),
    ...(input.verification === undefined ? {} : { verification: input.verification }),
  };
  const requestedTarget =
    input.targetEnrollmentId !== undefined
      ? { kind: 'device' as const, enrollmentId: input.targetEnrollmentId }
      : {
          kind: 'auto' as const,
          ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
        };
  return submitSealedJob({
    requestId: input.requestId,
    kind: 'code-task',
    requestedTarget,
    manifest,
    privateInputs,
    retryPolicy: 'inspect-before-retry',
  });
}

export interface WorkflowNodeJobInput extends Omit<CodeTaskJobInput, 'requestId'> {
  /**
   * The parent run's stable dispatch identity — becomes the job's
   * requestId so re-dispatch after a parent restart re-binds to the
   * existing job instead of duplicating work (spec §449).
   */
  dispatchId: string;
  runId: string;
  nodeId: string;
  /** Run-start manifest. When supplied, never resolve the checkout again. */
  pinnedManifest?: ExecutionManifest;
  /** Full target policy resolved for this dispatch. */
  requestedTarget?: RequestedTarget;
  /** Durable trusted recipients for the sealed result. */
  resultRecipients?: string[];
}

/**
 * `job.create` for `workflow-node` (FLOW-02). Same pinning as code-task
 * plus `resultTransfer: bundle-artifacts` — the worker publishes each
 * attempt branch as a fetchable bundle artifact so the parent can adopt
 * the result refs. requestId is `node-dispatch/<dispatchId>`: the
 * backend's (source, requestId) idempotency makes re-dispatch safe.
 *
 * The request is built in two steps so the dispatch can persist the
 * byte-exact params BEFORE submitting: a crash between persist and create
 * replays deterministically instead of recomputing.
 */
export function workflowNodeJobRequest(input: WorkflowNodeJobInput): {
  requestId: string;
  build: () => Promise<SealedJobRequest>;
} {
  const requestId = `node-dispatch/${input.dispatchId}`;
  return {
    requestId,
    build: async () => {
      const provider: RemoteSessionProvider = input.provider ?? 'codex';
      const model =
        input.model ?? resolveSessionModel(provider as AgentProvider, getSettings().openaiModel);
      const manifest: ExecutionManifest =
        input.pinnedManifest ??
        (await (async () => {
          const revision = workspaceDefinitionRevision(input.workspaceId);
          if (revision === null) throw new Error(`workspace not found: ${input.workspaceId}`);
          const commits = await resolveWorkspaceCommits(input.workspaceId);
          const defs = getDb()
            .prepare(
              `SELECT portable_id, mapped_repo_id FROM workspace_repo_definitions WHERE workspace_id = ?`,
            )
            .all(input.workspaceId) as Array<{
            portable_id: string;
            mapped_repo_id: string | null;
          }>;
          const repositories = defs.map((def) => {
            const commit = commits[def.portable_id];
            if (def.mapped_repo_id === null || commit === undefined) {
              throw new Error(
                `repository ${def.portable_id} has no resolved commit on this device — map a checkout first`,
              );
            }
            return { repositoryId: def.portable_id, commit };
          });
          const recipe = getWorkspaceBootstrap(input.workspaceId);
          const bootstrapDigest =
            recipe === null
              ? 'none'
              : computeBootstrapDigest({
                  recipe,
                  repositoryCommits: commits,
                  executionPolicy: bootstrapManifestPolicy(),
                });
          return {
            workspaceDefinitionRevision: revision,
            repositories,
            bootstrapDigest,
            provider,
            model,
            configVersions: {},
            inputs: { workspaceId: input.workspaceId },
          };
        })());
      const privateInputs: Record<string, unknown> = {
        prompt: input.prompt,
        refPolicy: 'local-branches',
        resultTransfer: 'bundle-artifacts',
        dispatchId: input.dispatchId,
        runId: input.runId,
        nodeId: input.nodeId,
        ...(input.personaId === undefined ? {} : { personaId: input.personaId }),
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
        permissionMode:
          input.permissionMode ??
          (input.sandbox === undefined
            ? getSettings().codexMode
            : requestedMeshPermissionMode({ sandbox: input.sandbox })),
        ...(input.cliMinVersion === undefined ? {} : { cliMinVersion: input.cliMinVersion }),
        ...(input.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: input.turnTimeoutMs }),
        ...(input.verification === undefined ? {} : { verification: input.verification }),
      };
      const requestedTarget: RequestedTarget =
        input.requestedTarget ??
        (input.targetEnrollmentId !== undefined
          ? { kind: 'device', enrollmentId: input.targetEnrollmentId }
          : {
              kind: 'auto',
              ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
            });
      return {
        requestId,
        kind: 'workflow-node',
        requestedTarget,
        manifest,
        privateInputs,
        ...(input.resultRecipients === undefined
          ? {}
          : { resultRecipients: input.resultRecipients }),
        retryPolicy: 'inspect-before-retry',
      };
    },
  };
}

export async function createWorkflowNodeJob(input: WorkflowNodeJobInput): Promise<JobSummary> {
  const prepared = workflowNodeJobRequest(input);
  return submitSealedJob(await prepared.build());
}

/** `approval.get` — by approvalId, or list pending for a job/attempt. */
export async function listMeshApprovals(scope: {
  approvalId?: string;
  jobId?: string;
  attemptId?: string;
}): Promise<ApprovalRecord[]> {
  const result = await meshRpc<{ approvals: ApprovalRecord[] }>('approval.get', scope);
  return result.approvals;
}

/**
 * `approval.decide` — idempotent on (approvalId, decision). The executing
 * worker can never decide its own request (backend enforces too).
 */
export async function decideMeshApproval(
  approvalId: string,
  decision: ApprovalDecision,
  reason?: string,
): Promise<{ approval: ApprovalRecord; job: JobSummary; duplicate: boolean }> {
  return meshRpc('approval.decide', {
    approvalId,
    decision,
    ...(reason === undefined ? {} : { reason }),
  });
}

export async function getMeshJob(jobId: string): Promise<JobSummary | null> {
  const result = await meshRpc<JobGetResult>('job.get', { jobId });
  if (result.job !== null) {
    // Late-bound targets and newly replicated identities retry delivery on
    // every source-side observation.
    void ensureTaskKeyDelivery(result.job).catch(() => undefined);
  }
  return result.job ?? null;
}

/**
 * Requests cancellation of a job this account created. Running jobs enter
 * `cancel-requested`; the worker's heartbeat job.get observes it and stops
 * the attempt before reporting.
 */
export async function cancelMeshJob(jobId: string): Promise<JobSummary> {
  const result = await meshRpc<{ job: JobSummary }>('job.cancel', { jobId });
  return result.job;
}
