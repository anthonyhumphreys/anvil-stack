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
import {
  readSessionOwnership,
  writeSessionOwnership,
} from './mesh-ownership.service.js';
import { interruptTurn, stopSession } from './codex-session.service.js';
import type {
  HandoffAdvanceResult,
  HandoffCancelResult,
  HandoffCreateResult,
  HandoffGetResult,
  HandoffRecord,
  SessionCheckpoint,
} from '../../../cloud/contract/handoff.js';

const execFileAsync = promisify(execFile);

// ---- context ---------------------------------------------------------------

export interface MeshHandoffContext {
  apiUrl: string;
  accessToken: string;
  enrollmentId: string;
}

let contextProvider: (() => MeshHandoffContext | null) | null = null;

export function configureMeshHandoffContext(
  provider: () => MeshHandoffContext | null,
): void {
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
}

function journalHandoff(handoffId: string, sessionId: string, role: 'source' | 'target'): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO mesh_handoff_journal (handoff_id, session_id, role, state, created_at, updated_at)
       VALUES (?, ?, ?, 'requested', ?, ?)
       ON CONFLICT(handoff_id) DO NOTHING`,
    )
    .run(handoffId, sessionId, role, now, now);
}

function journalHandoffState(handoffId: string, state: string): void {
  getDb()
    .prepare('UPDATE mesh_handoff_journal SET state = ?, updated_at = ? WHERE handoff_id = ?')
    .run(state, new Date().toISOString(), handoffId);
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
    const repo = getDb()
      .prepare('SELECT id, path FROM repos WHERE id = ?')
      .get(repoId) as { id: string; path: string } | undefined;
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
  provider: string;
  model: string | null;
  planGoal: string | null;
} | null {
  const row = getDb()
    .prepare(
      `SELECT s.thread_id, s.provider, t.provider_thread_id, t.provider_thread_provider,
              t.active_plan_json, t.active_goal_json
       FROM chat_sessions s JOIN chat_threads t ON t.id = s.thread_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as
      | {
          thread_id: string;
          provider: string | null;
          provider_thread_provider: string | null;
          active_plan_json: string | null;
          active_goal_json: string | null;
        }
      | undefined;
  if (row === undefined) return null;
  return {
    threadId: row.thread_id,
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

function handoffRpc<R>(operation: string, params: unknown): Promise<R> {
  const ctx = handoffContext();
  return rpc<R>({ apiUrl: ctx.apiUrl }, operation, params, ctx.accessToken).then(
    (r) => r.result,
  );
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
export async function initiateHandoff(input: {
  sessionId: string;
  targetEnrollmentId: string;
  handoffId?: string;
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
  const handoffId = input.handoffId ?? randomUUID();

  journalHandoff(handoffId, input.sessionId, 'source');
  const created = await handoffRpc<HandoffCreateResult>('handoff.create', {
    handoffId,
    sessionId: input.sessionId,
    sourceEnrollmentId: ctx.enrollmentId,
    targetEnrollmentId: input.targetEnrollmentId,
    sourceGeneration: generation,
  });
  journalHandoffState(handoffId, created.handoff.state);
  if (created.handoff.state !== 'requested') {
    // Idempotent replay of an already-advanced handoff — rejoin the flow.
    return { ok: true, handoff: created.handoff };
  }
  if (ownership === null) {
    writeSessionOwnership(input.sessionId, generation, ctx.enrollmentId, 'owned');
  }

  const advance = (from: string, to: string, checkpoint?: SessionCheckpoint) =>
    handoffRpc<HandoffAdvanceResult>('handoff.advance', {
      handoffId,
      from,
      to,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    });

  try {
    const prepared = await advance('requested', 'target-prepared-without-execution');
    journalHandoffState(handoffId, prepared.handoff.state);

    // Durable reject-new-messages BEFORE interrupt/quiesce (spec ordering).
    writeSessionOwnership(input.sessionId, generation, ctx.enrollmentId, 'relinquished');
    const quiescing = await advance('target-prepared-without-execution', 'source-quiescing');
    journalHandoffState(handoffId, quiescing.handoff.state);

    // Interrupt any running turn, then verify child-process quiescence by
    // tearing the session process down — nothing left running means proven
    // stopped.
    interruptTurn(input.sessionId);
    stopSession(input.sessionId);

    const checkpoint = await captureSessionCheckpoint(input.sessionId, generation);
    const relinquished = await advance(
      'source-quiescing',
      'source-relinquished-and-checkpointed',
      checkpoint,
    );
    journalHandoffState(handoffId, relinquished.handoff.state);

    // Post-transfer failures from here on must not restore ownership.
    try {
      const transferred = await advance(
        'source-relinquished-and-checkpointed',
        'ownership-transferred',
      );
      journalHandoffState(handoffId, transferred.handoff.state);
      return { ok: true, handoff: transferred.handoff };
    } catch (error) {
      await handoffRpc<HandoffCancelResult>('handoff.advance', {
        handoffId,
        from: 'source-relinquished-and-checkpointed',
        to: 'failed',
      }).catch(() => undefined);
      journalHandoffState(handoffId, 'failed');
      throw error;
    }
  } catch (error) {
    // Pre-transfer: the source never relinquished on the backend — cancel
    // the handoff and restore local ownership (proven-stopped resume under
    // still-valid ownership, spec §11).
    if (readSessionOwnership(input.sessionId)?.state === 'relinquished') {
      const row = getDb()
        .prepare('SELECT state FROM mesh_handoff_journal WHERE handoff_id = ?')
        .get(handoffId) as { state: string } | undefined;
      const preTransfer =
        row === undefined ||
        row.state !== 'ownership-transferred';
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
  const rows = getDb()
    .prepare(
      `SELECT handoff_id, session_id, role, state FROM mesh_handoff_journal
       WHERE state NOT IN ('completed', 'cancelled', 'failed')`,
    )
    .all() as HandoffJournalRow[];
  const ctx = contextProvider?.() ?? null;
  if (ctx === null) return;
  for (const row of rows) {
    let remote: HandoffRecord;
    try {
      remote = (await handoffRpc<HandoffGetResult>('handoff.get', { handoffId: row.handoff_id }))
        .handoff;
    } catch {
      continue; // Backend unreachable — leave local state as-is.
    }
    journalHandoffState(row.handoff_id, remote.state);
    if (row.role !== 'source') continue;
    const transferred =
      remote.targetGeneration !== null ||
      remote.state === 'ownership-transferred' ||
      remote.state === 'target-activating' ||
      remote.state === 'completed';
    const ownership = readSessionOwnership(row.session_id);
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
