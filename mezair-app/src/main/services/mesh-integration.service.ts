import { join } from 'node:path';
import { dialog } from 'electron';
import type { PermissionMode } from '../../../cloud/contract/permissions.js';
import { getDb } from '../db/database.js';
import { detectScripts } from './run-detection.service.js';
import { listSavedCommands } from './run-persistence.service.js';
import {
  allocateAttemptWorktrees,
  runGit,
  runVerificationCommand,
  withRepoRefLock,
} from './mesh-worktree.service.js';
import type {
  ChatDelegationIntegrationRepositoryPlan,
  ChatDelegationVerificationCandidate,
  ChatDelegationVerificationSelection,
} from '../../shared/chat-delegation.js';
import type {
  ResultManifestRepository,
  ResultManifestVerification,
} from '../../../cloud/contract/jobs.js';
import { applyVerifiedFastForward, inspectVerifiedFastForward } from './mesh-apply.service.js';

interface IntegrationContext {
  userDataDir: string;
}

let contextProvider: (() => IntegrationContext | null) | null = null;

export function configureMeshIntegrationContext(provider: () => IntegrationContext | null): void {
  contextProvider = provider;
}

export interface IntegrationConflict {
  repositoryId: string;
  dispatchId: string;
  /** The commit that failed to merge. */
  ref: string;
  conflictedFiles: string[];
}

export interface IntegratedRepo {
  repositoryId: string;
  name: string;
  baseCommit: string;
  /** The commit at the integration worktree's HEAD after every result merged. */
  integratedCommit: string | null;
  branch: string;
  worktreePath: string;
  appliedAt: string | null;
  destinationBranch: string | null;
  appliedCommit: string | null;
  applyError?: string;
  applyIntent?: {
    startedAt: string;
    baseCommit: string;
    integratedCommit: string;
    destinationBranch: string;
  };
  mergedRefs: Array<{ dispatchId: string; ref: string; commit: string }>;
  conflicts: IntegrationConflict[];
}

export type IntegrationVerificationState =
  'not-run' | 'running' | 'passed' | 'failed' | 'blocked' | 'stale';

export interface IntegrationVerificationResult extends ResultManifestVerification {
  approvalGranted: boolean;
  logTail: string;
  testedHead: string | null;
  testedTree: string | null;
}

export interface IntegrationVerificationAttempt {
  attempt: number;
  startedAt: string;
  completedAt?: string;
  state: IntegrationVerificationState;
  selections: ChatDelegationVerificationSelection[];
  results: IntegrationVerificationResult[];
}

export interface IntegrationResult {
  state: 'integrating' | 'integrated' | 'conflicted' | 'failed';
  combined: boolean;
  verificationState: IntegrationVerificationState;
  verificationAttempt: number;
  verificationSelections: ChatDelegationVerificationSelection[];
  verification: IntegrationVerificationResult[];
  verificationAttempts: IntegrationVerificationAttempt[];
  /** Integration stays in its dedicated checkout until a user applies it. */
  appliedAt: string | null;
  error?: string;
  repositories: IntegratedRepo[];
}

interface DispatchRow {
  dispatch_id: string;
  workspace_id: string;
  manifest_json: string;
  output_json: string | null;
}

interface WorkspaceRepoRow {
  portable_id: string;
  mapped_repo_id: string;
  repo_path: string;
  repo_name: string;
}

interface PendingMerge {
  dispatchId: string;
  repositoryId: string;
  ref: string;
  commit: string;
}

interface IntegrationInputs {
  mergesByRepo: Map<string, PendingMerge[]>;
  baseByRepo: Map<string, string>;
  repoByPortable: Map<string, WorkspaceRepoRow>;
}

const integrationLocks = new Map<string, Promise<void>>();
const MAX_CHECKS_PER_REPO = 3;
const MAX_COMMAND_LENGTH = 500;
const MAX_VERIFICATION_ATTEMPTS = 5;

function mergeEnvArgs(): string[] {
  return ['-c', 'user.name=Mezair Mesh', '-c', 'user.email=mesh@mezair.local'];
}

function maxVerificationScore(label: string, command: string): number {
  const value = `${label} ${command}`.toLowerCase();
  if (/\b(dev|start|serve|watch|deploy|publish)\b/.test(value)) return -1;
  if (/\b(test|unit|integration|spec)\b/.test(value)) return 5;
  if (/\b(lint|eslint|check|verify|typecheck|tsc)\b/.test(value)) return 4;
  if (/\b(build|compile)\b/.test(value)) return 2;
  return 0;
}

function validateVerificationSelections(
  selections: ChatDelegationVerificationSelection[],
  repositoryIds: Set<string>,
): ChatDelegationVerificationSelection[] {
  if (!Array.isArray(selections) || selections.length > 32)
    throw new Error('Choose verification checks from the prepared repository plan.');
  const seenRepositories = new Set<string>();
  let totalCommands = 0;
  const normalised = selections.map((selection) => {
    if (
      !selection ||
      typeof selection.repositoryId !== 'string' ||
      !repositoryIds.has(selection.repositoryId) ||
      seenRepositories.has(selection.repositoryId) ||
      !Array.isArray(selection.commands)
    )
      throw new Error('A verification check refers to a repository outside this integration.');
    seenRepositories.add(selection.repositoryId);
    if (selection.commands.length > MAX_CHECKS_PER_REPO)
      throw new Error(`Choose up to ${MAX_CHECKS_PER_REPO} checks per repository.`);
    const commands = selection.commands.map((value) => {
      if (typeof value !== 'string' || value.trim() !== value || value.length > MAX_COMMAND_LENGTH)
        throw new Error('Each verification command must be trimmed and under 500 characters.');
      if (!value.trim() || value.includes('\0'))
        throw new Error('Verification commands cannot be empty.');
      totalCommands += 1;
      return value;
    });
    if (new Set(commands).size !== commands.length)
      throw new Error('Choose each verification command once per repository.');
    return { repositoryId: selection.repositoryId, commands };
  });
  if (totalCommands > 24) throw new Error('Choose up to 24 verification commands per integration.');
  return normalised.filter((selection) => selection.commands.length > 0);
}

async function withIntegrationLock<T>(integrationId: string, run: () => Promise<T>): Promise<T> {
  const previous = integrationLocks.get(integrationId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  integrationLocks.set(integrationId, current);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (integrationLocks.get(integrationId) === current) integrationLocks.delete(integrationId);
  }
}

function loadWorkspaceRepos(workspaceId: string): Map<string, WorkspaceRepoRow> {
  const rows = getDb()
    .prepare(
      `SELECT d.portable_id, d.mapped_repo_id, r.path AS repo_path, r.name AS repo_name
       FROM workspace_repo_definitions d
       JOIN repos r ON r.id = d.mapped_repo_id
       WHERE d.workspace_id = ?`,
    )
    .all(workspaceId) as WorkspaceRepoRow[];
  return new Map(rows.map((row) => [row.portable_id, row]));
}

function loadIntegrationInputs(input: {
  workspaceId: string;
  dispatchIds: string[];
}): IntegrationInputs {
  if (!input.dispatchIds.length)
    throw new Error('This workflow has no remote dispatches to integrate.');
  const rows = getDb()
    .prepare(
      `SELECT dispatch_id, workspace_id, manifest_json, output_json
       FROM mesh_node_dispatches WHERE dispatch_id IN (${input.dispatchIds.map(() => '?').join(',')})`,
    )
    .all(...input.dispatchIds) as DispatchRow[];
  const byDispatch = new Map(rows.map((row) => [row.dispatch_id, row]));
  const mergesByRepo = new Map<string, PendingMerge[]>();
  const baseByRepo = new Map<string, string>();
  for (const dispatchId of input.dispatchIds) {
    const row = byDispatch.get(dispatchId);
    if (row === undefined) throw new Error(`dispatch not found: ${dispatchId}`);
    if (row.workspace_id !== input.workspaceId)
      throw new Error(`dispatch ${dispatchId} belongs to a different workspace`);
    const manifest = JSON.parse(row.manifest_json) as {
      repositories?: Array<{ repositoryId: string; commit: string }>;
    };
    const output =
      row.output_json === null
        ? null
        : (JSON.parse(row.output_json) as {
            adoptedRefs?: Array<{ repositoryId: string; ref: string; commit: string }>;
            resultManifest?: { repositories?: ResultManifestRepository[] };
          });
    for (const adopted of output?.adoptedRefs ?? []) {
      const pinnedRepo = (manifest.repositories ?? []).find(
        (repository) => repository.repositoryId === adopted.repositoryId,
      );
      const resultRepo = (output?.resultManifest?.repositories ?? []).find(
        (repository) => repository.repositoryId === adopted.repositoryId,
      );
      const expectedRef = `refs/mesh/result/${dispatchId}/${adopted.repositoryId}`;
      if (
        !pinnedRepo ||
        !resultRepo ||
        pinnedRepo.commit !== resultRepo.baseCommit ||
        adopted.commit !== resultRepo.resultCommit ||
        adopted.ref !== expectedRef
      )
        throw new Error(
          `dispatch ${dispatchId} has an adopted result that does not match its pinned manifest and result manifest`,
        );
      const pinned = baseByRepo.get(adopted.repositoryId);
      if (pinned !== undefined && pinned !== resultRepo.baseCommit)
        throw new Error(
          `base-diverged: ${adopted.repositoryId} pinned at ${resultRepo.baseCommit} vs ${pinned} across dispatches`,
        );
      baseByRepo.set(adopted.repositoryId, resultRepo.baseCommit);
      const merges = mergesByRepo.get(adopted.repositoryId) ?? [];
      merges.push({
        dispatchId,
        repositoryId: adopted.repositoryId,
        ref: adopted.ref,
        commit: adopted.commit,
      });
      mergesByRepo.set(adopted.repositoryId, merges);
    }
  }
  return {
    mergesByRepo,
    baseByRepo,
    repoByPortable: loadWorkspaceRepos(input.workspaceId),
  };
}

/**
 * Read-only detection for an explicit, bounded verification plan. It reads
 * repository scripts and saved commands but never runs candidate commands.
 */
export async function prepareIntegrationVerification(input: {
  workspaceId: string;
  dispatchIds: string[];
}): Promise<ChatDelegationIntegrationRepositoryPlan[]> {
  const { mergesByRepo, repoByPortable } = loadIntegrationInputs(input);
  const plans: ChatDelegationIntegrationRepositoryPlan[] = [];
  for (const repositoryId of mergesByRepo.keys()) {
    const repo = repoByPortable.get(repositoryId);
    if (!repo) throw new Error(`No mapped checkout for repository ${repositoryId}.`);
    const saved = listSavedCommands(repo.mapped_repo_id).map((command) => ({
      label: command.label,
      command: command.command,
      source: 'saved' as const,
    }));
    const detected = (await detectScripts(repo.mapped_repo_id, repo.repo_path)).map((command) => ({
      label: command.label,
      command: command.command,
      source: 'detected' as const,
    }));
    const byCommand = new Map<string, ChatDelegationVerificationCandidate>();
    for (const candidate of [...saved, ...detected]) {
      if (
        !candidate.command.trim() ||
        maxVerificationScore(candidate.label, candidate.command) <= 0
      )
        continue;
      if (!byCommand.has(candidate.command)) byCommand.set(candidate.command, candidate);
    }
    const candidates = [...byCommand.values()]
      .sort(
        (left, right) =>
          maxVerificationScore(right.label, right.command) -
          maxVerificationScore(left.label, left.command),
      )
      .slice(0, 6);
    plans.push({
      repositoryId,
      name: repo.repo_name,
      candidates,
      recommendedCommands: candidates
        .slice(0, MAX_CHECKS_PER_REPO)
        .map((candidate) => candidate.command),
    });
  }
  return plans;
}

function persistIntegration(input: {
  integrationId: string;
  runId: string;
  workspaceId: string;
  dispatchIds: string[];
  result: IntegrationResult;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO mesh_integrations
       (integration_id, run_id, workspace_id, dispatch_ids_json, state, result_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(integration_id) DO UPDATE SET state = excluded.state,
         result_json = excluded.result_json, updated_at = excluded.updated_at`,
    )
    .run(
      input.integrationId,
      input.runId,
      input.workspaceId,
      JSON.stringify(input.dispatchIds),
      input.result.state,
      JSON.stringify(input.result),
      now,
      now,
    );
}

function normaliseLegacyIntegration(value: unknown): IntegrationResult {
  const stored = value as Partial<IntegrationResult> & {
    verification?: Array<Partial<IntegrationVerificationResult>>;
    repositories?: IntegratedRepo[];
  };
  const verification = (stored.verification ?? []).map((result) => ({
    repositoryId: result.repositoryId ?? '',
    command: result.command ?? '',
    approvalGranted: result.approvalGranted ?? true,
    exitCode: result.exitCode ?? null,
    timedOut: result.timedOut ?? false,
    durationMs: result.durationMs ?? 0,
    logTail: result.logTail ?? '',
    testedHead: result.testedHead ?? null,
    testedTree: result.testedTree ?? null,
  }));
  const repositories = (stored.repositories ?? []).map((repository) => ({
    ...repository,
    appliedAt: repository.appliedAt ?? null,
    destinationBranch: repository.destinationBranch ?? null,
    appliedCommit: repository.appliedCommit ?? null,
    conflicts: repository.conflicts ?? [],
    mergedRefs: repository.mergedRefs ?? [],
  }));
  const combined =
    stored.combined ??
    (stored.state === 'integrated' &&
      repositories.length > 0 &&
      repositories.every((repo) => repo.integratedCommit !== null && repo.conflicts.length === 0));
  const verificationState =
    stored.verificationState ??
    (verification.length === 0
      ? 'not-run'
      : verification.some((result) => result.approvalGranted === false)
        ? 'blocked'
        : verification.some(
              (result) => result.exitCode !== 0 || result.timedOut || result.exitCode === null,
            )
          ? 'failed'
          : 'passed');
  return {
    state: stored.state ?? (combined ? 'integrated' : 'failed'),
    combined,
    verificationState,
    verificationAttempt: stored.verificationAttempt ?? (verification.length > 0 ? 1 : 0),
    verificationSelections: stored.verificationSelections ?? [],
    verification,
    verificationAttempts: stored.verificationAttempts ?? [],
    appliedAt: stored.appliedAt ?? null,
    ...(stored.error ? { error: stored.error } : {}),
    repositories,
  };
}

/** Merges returned refs into a dedicated integration checkout, once per id. */
export async function integrateResults(input: {
  integrationId: string;
  runId: string;
  workspaceId: string;
  /** Declared dependency order — dispatch N+1 merges on top of N. */
  dispatchIds: string[];
  /** Legacy workflow API. When supplied, these commands run in every result repo. */
  verification?: string[];
  verificationSelections?: ChatDelegationVerificationSelection[];
  permissionMode?: PermissionMode;
}): Promise<IntegrationResult> {
  return withIntegrationLock(input.integrationId, async () => {
    const existing = getIntegration(input.integrationId);
    if (existing !== null) return existing;
    return integrateResultsLocked(input);
  });
}

async function integrateResultsLocked(input: {
  integrationId: string;
  runId: string;
  workspaceId: string;
  dispatchIds: string[];
  verification?: string[];
  verificationSelections?: ChatDelegationVerificationSelection[];
  permissionMode?: PermissionMode;
}): Promise<IntegrationResult> {
  const context = contextProvider?.() ?? null;
  if (context === null) throw new Error('Mesh integration has no userDataDir context.');
  const { mergesByRepo, baseByRepo, repoByPortable } = loadIntegrationInputs(input);
  const expectedRepoIds = new Set(mergesByRepo.keys());
  const verificationSelections = validateVerificationSelections(
    input.verificationSelections ??
      (input.verification
        ? [...mergesByRepo.keys()].map((repositoryId) => ({
            repositoryId,
            commands: input.verification!,
          }))
        : []),
    expectedRepoIds,
  );
  const emptyResult: IntegrationResult = {
    state: 'integrating',
    combined: false,
    verificationState: 'not-run',
    verificationAttempt: 0,
    verificationSelections,
    verification: [],
    verificationAttempts: [],
    appliedAt: null,
    repositories: [],
  };
  persistIntegration({ ...input, result: emptyResult });
  if (mergesByRepo.size === 0) {
    emptyResult.state = 'failed';
    emptyResult.error = 'No returned repository changes were available to combine.';
    persistIntegration({ ...input, result: emptyResult });
    return emptyResult;
  }

  const rootDir = join(context.userDataDir, 'mesh-integrations', input.integrationId);
  let sawConflict = false;
  try {
    for (const [repositoryId, merges] of mergesByRepo) {
      const repoInfo = repoByPortable.get(repositoryId);
      const baseCommit = baseByRepo.get(repositoryId);
      if (!repoInfo || !baseCommit)
        throw new Error(`No mapped checkout for repository ${repositoryId}.`);
      for (const merge of merges) {
        const adoptedCommit = (
          await runGit(repoInfo.repo_path, ['rev-parse', '--verify', `${merge.ref}^{commit}`])
        ).trim();
        if (adoptedCommit !== merge.commit)
          throw new Error(`Adopted result ref ${merge.ref} moved after it was recorded.`);
      }
      const [worktree] = await allocateAttemptWorktrees({
        attemptId: input.integrationId,
        rootDir,
        branchPrefix: 'mesh/integrate',
        repositories: [{ repositoryId, sourcePath: repoInfo.repo_path, commit: baseCommit }],
      });
      if (!worktree)
        throw new Error(`Could not allocate an integration checkout for ${repoInfo.repo_name}.`);
      const repo: IntegratedRepo = {
        repositoryId,
        name: repoInfo.repo_name,
        baseCommit,
        integratedCommit: null,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        appliedAt: null,
        destinationBranch: null,
        appliedCommit: null,
        mergedRefs: [],
        conflicts: [],
      };
      emptyResult.repositories.push(repo);
      persistIntegration({ ...input, result: emptyResult });
      for (const merge of merges) {
        const outcome = await withRepoRefLock(repoInfo.repo_path, async () => {
          try {
            await runGit(worktree.worktreePath, [
              ...mergeEnvArgs(),
              'merge',
              '--no-ff',
              '--no-edit',
              merge.commit,
            ]);
            return { ok: true as const, conflictedFiles: [] as string[] };
          } catch (error) {
            let conflictedFiles: string[] = [];
            try {
              const raw = await runGit(worktree.worktreePath, [
                'diff',
                '--name-only',
                '--diff-filter=U',
              ]);
              conflictedFiles = raw
                .split('\n')
                .map((file) => file.trim())
                .filter(Boolean);
            } catch {
              // Preserve the original Git error below when there was no conflict.
            }
            if (conflictedFiles.length === 0) throw error;
            await runGit(worktree.worktreePath, ['merge', '--abort']).catch(() => undefined);
            return { ok: false as const, conflictedFiles };
          }
        });
        if (!outcome.ok) {
          sawConflict = true;
          repo.conflicts.push({
            repositoryId,
            dispatchId: merge.dispatchId,
            ref: merge.ref,
            conflictedFiles: outcome.conflictedFiles,
          });
          persistIntegration({ ...input, result: emptyResult });
          break;
        }
        repo.mergedRefs.push({
          dispatchId: merge.dispatchId,
          ref: merge.ref,
          commit: merge.commit,
        });
        persistIntegration({ ...input, result: emptyResult });
      }
      if (repo.conflicts.length === 0) {
        repo.integratedCommit = (await runGit(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
        persistIntegration({ ...input, result: emptyResult });
      }
    }
    emptyResult.state = sawConflict ? 'conflicted' : 'integrated';
    emptyResult.combined =
      !sawConflict &&
      emptyResult.repositories.length > 0 &&
      emptyResult.repositories.every((repo) => repo.integratedCommit !== null);
    persistIntegration({ ...input, result: emptyResult });
  } catch (error) {
    emptyResult.state = 'failed';
    emptyResult.error = error instanceof Error ? error.message : String(error);
    persistIntegration({ ...input, result: emptyResult });
    return emptyResult;
  }

  if (emptyResult.combined && verificationSelections.length > 0)
    return verifyIntegrationLocked({
      integrationId: input.integrationId,
      runId: input.runId,
      selections: verificationSelections,
      permissionMode: input.permissionMode ?? 'on-request',
      integration: emptyResult,
      persistence: input,
    });
  return emptyResult;
}

interface WorktreeSnapshot {
  head: string;
  tree: string;
  status: string;
}

async function snapshotWorktree(path: string): Promise<WorktreeSnapshot> {
  const head = (await runGit(path, ['rev-parse', 'HEAD'])).trim();
  // Clean snapshots use the pinned commit tree. write-tree can contend with
  // status's index refresh and turn an unchanged checkout into stale evidence.
  const [tree, status] = await Promise.all([
    runGit(path, ['rev-parse', `${head}^{tree}`]),
    runGit(path, ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  return { head, tree: tree.trim(), status: status.trim() };
}

function sameSnapshot(left: WorktreeSnapshot, right: WorktreeSnapshot): boolean {
  return left.head === right.head && left.tree === right.tree && left.status === right.status;
}

function appendVerificationAttempt(
  integration: IntegrationResult,
  attempt: IntegrationVerificationAttempt,
): void {
  integration.verificationAttempts = [...integration.verificationAttempts, attempt].slice(
    -MAX_VERIFICATION_ATTEMPTS,
  );
  integration.verificationAttempt = attempt.attempt;
  integration.verificationSelections = attempt.selections;
  integration.verification = attempt.results;
  integration.verificationState = attempt.state;
}

function integrationPersistence(integrationId: string): {
  workspaceId: string;
  dispatchIds: string[];
} {
  const row = getDb()
    .prepare(
      'SELECT workspace_id, dispatch_ids_json FROM mesh_integrations WHERE integration_id = ?',
    )
    .get(integrationId) as { workspace_id: string; dispatch_ids_json: string } | undefined;
  if (!row) throw new Error('Integration checkout not found.');
  return {
    workspaceId: row.workspace_id,
    dispatchIds: JSON.parse(row.dispatch_ids_json) as string[],
  };
}

export async function prepareExistingIntegrationVerification(
  integrationId: string,
): Promise<ChatDelegationIntegrationRepositoryPlan[]> {
  const integration = getIntegration(integrationId);
  if (!integration?.combined)
    throw new Error('There is no combined integration checkout to verify.');
  const persistence = integrationPersistence(integrationId);
  return prepareIntegrationVerification(persistence);
}

async function verifyIntegrationLocked(input: {
  integrationId: string;
  runId: string;
  selections: ChatDelegationVerificationSelection[];
  permissionMode: PermissionMode;
  integration: IntegrationResult;
  persistence: { workspaceId: string; dispatchIds: string[] };
}): Promise<IntegrationResult> {
  const expectedRepoIds = new Set(input.integration.repositories.map((repo) => repo.repositoryId));
  const persistence = {
    ...input.persistence,
    integrationId: input.integrationId,
    runId: input.runId,
  };
  const selections = validateVerificationSelections(input.selections, expectedRepoIds);
  if (!input.integration.combined || input.integration.state !== 'integrated')
    throw new Error('Verification needs a fully combined integration checkout.');
  if (selections.length === 0) {
    input.integration.verificationSelections = [];
    input.integration.verification = [];
    input.integration.verificationState = 'not-run';
    persistIntegration({ ...persistence, result: input.integration });
    return input.integration;
  }
  const selectedCount = selections.reduce(
    (count, selection) => count + selection.commands.length,
    0,
  );
  if (selectedCount === 0) throw new Error('Select at least one verification command to run.');

  const attempt: IntegrationVerificationAttempt = {
    attempt: input.integration.verificationAttempt + 1,
    startedAt: new Date().toISOString(),
    state: 'running',
    selections,
    results: [],
  };
  input.integration.error = undefined;
  appendVerificationAttempt(input.integration, attempt);
  persistIntegration({ ...persistence, result: input.integration });

  const selectedByRepo = new Map(
    selections.map((selection) => [selection.repositoryId, selection.commands]),
  );
  for (const repository of input.integration.repositories) {
    const commands = selectedByRepo.get(repository.repositoryId) ?? [];
    if (!commands.length) continue;
    if (repository.integratedCommit === null) {
      attempt.state = 'stale';
      break;
    }
    for (const command of commands) {
      let before: WorktreeSnapshot;
      try {
        before = await snapshotWorktree(repository.worktreePath);
      } catch (error) {
        attempt.state = 'stale';
        input.integration.error = `Could not inspect ${repository.name ?? repository.repositoryId} before verification: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
      if (before.head !== repository.integratedCommit || before.status !== '') {
        attempt.state = 'stale';
        input.integration.error = `The integration checkout for ${repository.repositoryId} changed after it was combined. Restore its pinned commit and clean worktree before retrying checks.`;
        break;
      }
      const outcome = await runVerificationCommand({
        repositoryId: repository.repositoryId,
        command,
        cwd: repository.worktreePath,
        permissionMode: input.permissionMode,
        target: { kind: 'integration', integrationId: input.integrationId, runId: input.runId },
      });
      let after: WorktreeSnapshot | null = null;
      try {
        after = await snapshotWorktree(repository.worktreePath);
      } catch {
        // The command may have removed or damaged the checkout. Treat proof as stale.
      }
      attempt.results.push({
        repositoryId: outcome.repositoryId,
        command: outcome.command,
        approvalGranted: outcome.approvalGranted,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
        logTail: outcome.logTail,
        testedHead: before.head,
        testedTree: before.tree,
      });
      if (outcome.approvalGranted === false) {
        attempt.state = 'blocked';
      } else if (after === null || !sameSnapshot(before, after)) {
        attempt.state = 'stale';
        input.integration.error = `The verification command changed the integration checkout for ${repository.repositoryId}. Its result does not prove the pinned candidate.`;
      } else if (outcome.exitCode !== 0 || outcome.timedOut) {
        attempt.state = 'failed';
      }
      appendVerificationAttempt(input.integration, attempt);
      persistIntegration({ ...persistence, result: input.integration });
      if (attempt.state === 'blocked' || attempt.state === 'stale') break;
    }
    if (attempt.state === 'blocked' || attempt.state === 'stale') break;
  }
  if (attempt.state === 'running')
    attempt.state =
      attempt.results.length > 0 &&
      attempt.results.every(
        (result) => result.approvalGranted && result.exitCode === 0 && !result.timedOut,
      )
        ? 'passed'
        : 'failed';
  attempt.completedAt = new Date().toISOString();
  appendVerificationAttempt(input.integration, attempt);
  persistIntegration({ ...persistence, result: input.integration });
  return input.integration;
}

/** Runs reviewed verification selections against an existing merge without replaying any merge. */
export async function runIntegrationVerification(input: {
  integrationId: string;
  runId: string;
  permissionMode: PermissionMode;
  selections: ChatDelegationVerificationSelection[];
}): Promise<IntegrationResult> {
  return withIntegrationLock(input.integrationId, async () => {
    const integration = getIntegration(input.integrationId);
    if (!integration) throw new Error('Integration checkout not found.');
    return runIntegrationVerificationLocked(input, integration);
  });
}

async function runIntegrationVerificationLocked(
  input: {
    integrationId: string;
    runId: string;
    permissionMode: PermissionMode;
    selections: ChatDelegationVerificationSelection[];
  },
  integration: IntegrationResult,
): Promise<IntegrationResult> {
  return verifyIntegrationLocked({
    ...input,
    integration,
    persistence: integrationPersistence(input.integrationId),
  });
}

/** Re-runs only the persisted verification selection against retained worktrees. */
export async function retryIntegrationVerification(input: {
  integrationId: string;
  runId: string;
  permissionMode: PermissionMode;
}): Promise<IntegrationResult> {
  return withIntegrationLock(input.integrationId, async () => {
    const integration = getIntegration(input.integrationId);
    if (!integration || integration.verificationSelections.length === 0)
      throw new Error('No saved verification checks are available to retry.');
    return runIntegrationVerificationLocked(
      { ...input, selections: integration.verificationSelections },
      integration,
    );
  });
}

/** Applies one fully verified repository by fast-forwarding its recorded clean base. */
export async function applyIntegrationRepository(input: {
  integrationId: string;
  runId: string;
  repositoryId: string;
  permissionMode: PermissionMode;
}): Promise<IntegrationResult> {
  if (input.permissionMode === 'read-only')
    throw new Error('Read-only delegations cannot apply integration changes.');
  return withIntegrationLock(input.integrationId, async () => {
    const integration = getIntegration(input.integrationId);
    if (!integration || !integration.combined || integration.state !== 'integrated')
      throw new Error('Only a combined integration can be applied.');
    const repository = integration.repositories.find(
      (item) => item.repositoryId === input.repositoryId,
    );
    if (!repository) throw new Error('Choose a repository in this integration.');
    if (repository.appliedAt) return integration;
    if (!repository.integratedCommit)
      throw new Error('This repository has no combined commit to apply.');

    const persistence = integrationPersistence(input.integrationId);
    const workspaceRepo = loadWorkspaceRepos(persistence.workspaceId).get(repository.repositoryId);
    if (!workspaceRepo) throw new Error('The original repository mapping is no longer available.');

    // An apply intent is persisted after the Git helper has locked HEAD, the
    // index, and the destination ref, immediately before changing the checkout.
    // If the process stopped before writing its receipt, only an exact, clean
    // match on that recorded branch and commit is safe to reconcile.
    if (repository.applyIntent) {
      const intent = repository.applyIntent;
      if (
        intent.baseCommit !== repository.baseCommit ||
        intent.integratedCommit !== repository.integratedCommit
      ) {
        repository.applyError =
          'The saved apply intent does not match this integration. Inspect the source checkout before retrying.';
        persistIntegration({
          ...persistence,
          integrationId: input.integrationId,
          runId: input.runId,
          result: integration,
        });
        return integration;
      }
      const inspection = await inspectVerifiedFastForward({
        repoPath: workspaceRepo.repo_path,
        expectedBranch: intent.destinationBranch,
        baseCommit: intent.baseCommit,
        targetCommit: intent.integratedCommit,
      });
      if (inspection.status === 'alreadyApplied') {
        recordApplyReceipt(
          integration,
          repository,
          intent.destinationBranch,
          intent.integratedCommit,
        );
        persistIntegration({
          ...persistence,
          integrationId: input.integrationId,
          runId: input.runId,
          result: integration,
        });
        return integration;
      }
      if (inspection.status === 'attention') {
        repository.applyError = `${inspection.reason} The saved apply intent is retained for inspection.`;
        persistIntegration({
          ...persistence,
          integrationId: input.integrationId,
          runId: input.runId,
          result: integration,
        });
        return integration;
      }
    }

    const selectedCommands =
      integration.verificationSelections.find(
        (item) => item.repositoryId === repository.repositoryId,
      )?.commands ?? [];
    let integratedTree: string;
    try {
      integratedTree = (
        await runGit(repository.worktreePath, [
          'rev-parse',
          `${repository.integratedCommit}^{tree}`,
        ])
      ).trim();
    } catch {
      integration.verificationState = 'stale';
      repository.applyError =
        'The retained integration commit is no longer available. Open the integration checkout and recover the reviewed commit before applying.';
      persistIntegration({
        ...integrationPersistence(input.integrationId),
        integrationId: input.integrationId,
        runId: input.runId,
        result: integration,
      });
      return integration;
    }
    const integrationCheckout = await snapshotWorktree(repository.worktreePath).catch(() => null);
    if (
      !integrationCheckout ||
      integrationCheckout.head !== repository.integratedCommit ||
      integrationCheckout.tree !== integratedTree ||
      integrationCheckout.status !== ''
    ) {
      integration.verificationState = 'stale';
      repository.applyError =
        'The retained integration checkout changed after verification. Restore its verified commit and clean worktree, then review the result again.';
      persistIntegration({
        ...integrationPersistence(input.integrationId),
        integrationId: input.integrationId,
        runId: input.runId,
        result: integration,
      });
      return integration;
    }
    const results = integration.verification.filter(
      (result) => result.repositoryId === repository.repositoryId,
    );
    const verifiedCommands = new Set(
      results
        .filter(
          (result) =>
            result.approvalGranted &&
            result.exitCode === 0 &&
            !result.timedOut &&
            result.testedHead === repository.integratedCommit &&
            result.testedTree === integratedTree,
        )
        .map((result) => result.command),
    );
    if (
      integration.verificationState !== 'passed' ||
      selectedCommands.length === 0 ||
      !selectedCommands.every((command) => verifiedCommands.has(command))
    )
      throw new Error('Run passing verification checks for this repository before applying it.');

    const expectedBranch = repository.applyIntent?.destinationBranch;
    const preflight = await inspectVerifiedFastForward({
      repoPath: workspaceRepo.repo_path,
      expectedBranch: expectedBranch ?? (await currentNamedBranch(workspaceRepo.repo_path)),
      baseCommit: repository.baseCommit,
      targetCommit: repository.integratedCommit,
    });
    if (preflight.status === 'attention') {
      repository.applyError = preflight.reason;
      persistIntegration({
        ...persistence,
        integrationId: input.integrationId,
        runId: input.runId,
        result: integration,
      });
      return integration;
    }
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Apply verified changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: `Apply ${repository.name}`,
      message: `Fast-forward ${preflight.branch} to the verified integration commit?`,
      detail: `Repository: ${workspaceRepo.repo_path}\nFrom: ${repository.baseCommit}\nTo: ${repository.integratedCommit}\nThe app will not push this branch.`,
      noLink: true,
    });
    if (confirmation.response !== 0) return integration;

    try {
      const receipt = await applyVerifiedFastForward({
        repoPath: workspaceRepo.repo_path,
        expectedBranch: preflight.branch,
        baseCommit: repository.baseCommit,
        targetCommit: repository.integratedCommit,
        onPrepared: async (intent) => {
          repository.applyIntent = {
            startedAt: intent.startedAt,
            baseCommit: intent.baseCommit,
            integratedCommit: intent.targetCommit,
            destinationBranch: intent.branch,
          };
          repository.applyError = undefined;
          persistIntegration({
            ...persistence,
            integrationId: input.integrationId,
            runId: input.runId,
            result: integration,
          });
        },
      });
      recordApplyReceipt(integration, repository, receipt.branch, receipt.targetCommit);
    } catch (error) {
      repository.applyError =
        error instanceof Error ? error.message : 'The fast-forward could not be applied safely.';
      persistIntegration({
        ...persistence,
        integrationId: input.integrationId,
        runId: input.runId,
        result: integration,
      });
      return integration;
    }
    persistIntegration({
      ...persistence,
      integrationId: input.integrationId,
      runId: input.runId,
      result: integration,
    });
    return integration;
  });
}

async function currentNamedBranch(sourcePath: string): Promise<string> {
  try {
    return (await runGit(sourcePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  } catch {
    return '';
  }
}

function recordApplyReceipt(
  integration: IntegrationResult,
  repository: IntegratedRepo,
  branch: string,
  commit: string,
): void {
  repository.appliedAt = new Date().toISOString();
  repository.destinationBranch = branch;
  repository.appliedCommit = commit;
  repository.applyIntent = undefined;
  repository.applyError = undefined;
  integration.error = undefined;
  integration.appliedAt = integration.repositories.every((item) => item.appliedAt !== null)
    ? new Date().toISOString()
    : null;
}

/** Reads a persisted integration run, including its retained checkout paths. */
export function getIntegration(integrationId: string): IntegrationResult | null {
  const row = getDb()
    .prepare('SELECT result_json FROM mesh_integrations WHERE integration_id = ?')
    .get(integrationId) as { result_json: string } | undefined;
  return row === undefined ? null : normaliseLegacyIntegration(JSON.parse(row.result_json));
}

/** Test seam: clears the injected context and in-process integration locks. */
export function resetMeshIntegrationForTests(): void {
  contextProvider = null;
  integrationLocks.clear();
}
