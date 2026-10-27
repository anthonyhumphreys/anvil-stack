import { createHash, randomUUID } from 'node:crypto';
import type { AgentUISurfaceIntent } from '../../shared/agent-ui-intents.js';
import type { WorkItemReference } from '../../shared/change-review-types.js';
import type {
  ValidationCriterion,
  ValidationSource,
  ValidationSurfaceData,
} from '../../shared/surfaces/kinds/validation.js';
import { extractAcceptanceCriteria } from '../../shared/workitem-intent.js';
import { constrainPermissionMode } from '../../../cloud/contract/permissions.js';
import {
  AgentToolError,
  assertRepoInScope,
  type AgentToolSessionContext,
} from '../agent-tools/dispatch.js';
import { getDb } from '../db/database.js';
import {
  deliverSurfaceFeedback,
  getSurface,
  patchSurface,
  publishSurface,
  requestUserApproval,
  requireSurfaceInScope,
} from '../surfaces/core.js';
import { getRepoRecord } from '../surfaces/kinds/data/tool-kit.js';
import { captureReviewSnapshot } from './review-snapshot.service.js';
import { getActiveProvider } from './workitem-provider.js';
import { getChangeReview } from './change-review.service.js';
import { getSettings } from './settings.service.js';
import { runVerificationCommand } from './mesh-worktree.service.js';
import type { ValidationHistoryEntry } from '../../shared/surfaces/ipc.js';
import { getAgentUIIntent, listAgentUISurfaces } from './agent-ui-intent.service.js';
import { getAgentToolSessionContext } from './codex-session.service.js';

interface ValidationContext {
  sessionId: string;
  createdAt: number;
  data: ValidationSurfaceData;
  request: string;
}
const contexts = new Map<string, ValidationContext>();
const running = new Map<string, AbortController>();
const completions = new Map<string, Promise<void>>();
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface WorkflowValidationTarget {
  id: string;
  graph_json: string;
}
function workflowForThread(
  workspaceId: string,
  threadId: string,
): WorkflowValidationTarget | undefined {
  return getDb()
    .prepare(
      `SELECT id, graph_json FROM workflow_runs
    WHERE workspace_id = ? AND EXISTS (
      SELECT 1 FROM json_each(node_runs_json) WHERE json_extract(value, '$.threadId') = ?
    ) ORDER BY created_at DESC LIMIT 1`,
    )
    .get(workspaceId, threadId) as WorkflowValidationTarget | undefined;
}

function validationRepo(data: Pick<ValidationSurfaceData, 'repoId' | 'workflowRunId'>) {
  const repo = getRepoRecord(data.repoId);
  if (!data.workflowRunId) return repo;
  const row = getDb()
    .prepare('SELECT graph_json, repo_ids_json FROM workflow_runs WHERE id = ?')
    .get(data.workflowRunId) as { graph_json: string; repo_ids_json: string } | undefined;
  if (!row || !(JSON.parse(row.repo_ids_json) as string[]).includes(repo.id))
    throw new Error('The workflow repository is no longer available.');
  const graph = JSON.parse(row.graph_json) as { executionPaths?: { id: string; path: string }[] };
  if (!graph.executionPaths) return repo;
  const execution = graph.executionPaths.find((path) => path.id === repo.id);
  if (!execution) throw new Error('The retained workflow checkout is unavailable.');
  return { ...repo, path: execution.path };
}

export function listValidationHistory(
  workspaceId: string,
  ref?: WorkItemReference,
): ValidationHistoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT id FROM agent_ui_intents WHERE workspace_id = ? AND kind = 'surface'
       AND json_extract(intent_json, '$.payload.surfaceKind') = 'validation'
       ${
         ref
           ? `AND json_extract(intent_json, '$.payload.data.source.workItemRef.id') = ?
         AND json_extract(intent_json, '$.payload.data.source.workItemRef.connectionId') = ?
         AND json_extract(intent_json, '$.payload.data.source.workItemRef.provider') = ?`
           : ''
       }
       ORDER BY updated_at DESC LIMIT 200`,
    )
    .all(...(ref ? [workspaceId, ref.id, ref.connectionId, ref.provider] : [workspaceId])) as {
    id: string;
  }[];
  return rows.flatMap(({ id }) => {
    const intent = getAgentUIIntent(id);
    if (!intent || intent.kind !== 'surface' || intent.payload.supersededBy) return [];
    const data = intent.payload.data as ValidationSurfaceData;
    const source = data.source.workItemRef;
    if (
      ref &&
      (!source ||
        source.id !== ref.id ||
        source.connectionId !== ref.connectionId ||
        source.provider !== ref.provider)
    )
      return [];
    return [
      {
        surfaceId: id,
        threadId: intent.scope.threadId,
        repoId: data.repoId,
        title: intent.payload.title,
        summary: intent.payload.digest.split('\n')[0]!,
        updatedAt: intent.updatedAt,
      },
    ];
  });
}

async function workItemSource(ref: WorkItemReference): Promise<ValidationSource> {
  const item = await getActiveProvider(ref.connectionId, true)?.getItem(ref.id);
  if (!item || item.provider !== ref.provider)
    throw new AgentToolError(
      'The linked work item is unavailable on this connection.',
      'unavailable',
    );
  return {
    kind: 'work-item',
    text: extractAcceptanceCriteria(item),
    workItemRef: ref,
    workItemTitle: item.title,
  };
}

export async function createValidationContext(
  ctx: AgentToolSessionContext,
  input: {
    repoId: string;
    workItemRef?: WorkItemReference;
    reviewId?: string;
  },
): Promise<{ contextId: string; data: ValidationSurfaceData; request: string }> {
  const repo = getRepoRecord(assertRepoInScope(ctx, input.repoId));
  const thread = getDb()
    .prepare('SELECT workspace_id, work_item_id, work_item_provider FROM chat_threads WHERE id = ?')
    .get(ctx.appThreadId) as
    | {
        workspace_id: string;
        work_item_id: string | null;
        work_item_provider: WorkItemReference['provider'] | null;
      }
    | undefined;
  if (!thread || thread.workspace_id !== ctx.workspaceId)
    throw new AgentToolError('Validation needs a thread in this workspace.', 'forbidden');
  const messages = getDb()
    .prepare(
      "SELECT content FROM chat_messages WHERE thread_id = ? AND role = 'user' ORDER BY rowid ASC",
    )
    .all(ctx.appThreadId) as { content: string }[];
  const request = [messages[0], ...messages.slice(1).slice(-12)]
    .filter(Boolean)
    .map((message) => message!.content.slice(0, 6000))
    .join('\n\n')
    .slice(0, 60000);
  const workflow = workflowForThread(ctx.workspaceId!, ctx.appThreadId!);
  const workflowGraph = workflow
    ? (JSON.parse(workflow.graph_json) as { workItemRef?: WorkItemReference })
    : undefined;
  let ref = workflowGraph?.workItemRef ?? input.workItemRef;
  if (
    workflowGraph?.workItemRef &&
    input.workItemRef &&
    hash(workflowGraph.workItemRef) !== hash(input.workItemRef)
  )
    throw new AgentToolError('The work item must match the current workflow run.', 'conflict');
  if (!input.reviewId && !ref && thread.work_item_id && thread.work_item_provider) {
    const settings = getSettings();
    const connections = settings.workItemConnections.filter(
      (connection) => connection.provider === thread.work_item_provider,
    );
    const connection =
      connections.find((connection) => connection.id === settings.activeWorkItemConnectionId) ??
      (connections.length === 1 ? connections[0] : undefined);
    if (!connection)
      throw new AgentToolError(
        'Choose the work-item connection with validation_context.workItemRef before defining its checks.',
        'invalid-params',
      );
    ref = {
      connectionId: connection.id,
      provider: thread.work_item_provider,
      id: thread.work_item_id,
    };
  }
  let source: ValidationSource =
    ref && !input.reviewId ? await workItemSource(ref) : { kind: 'prompt', text: request };
  const data: ValidationSurfaceData = {
    repoId: repo.id,
    repoName: repo.name,
    source,
    request,
    snapshot: captureReviewSnapshot(
      validationRepo({ repoId: repo.id, workflowRunId: workflow?.id }).path,
    ),
    criteriaVersion: '',
    criteria: [],
    freshness: 'current',
    ...(workflow ? { workflowRunId: workflow.id } : {}),
  };
  if (input.reviewId) {
    const saved = getDb()
      .prepare('SELECT workspace_id, repo_id FROM change_reviews WHERE id = ?')
      .get(input.reviewId) as { workspace_id: string; repo_id: string } | undefined;
    if (!saved || saved.workspace_id !== ctx.workspaceId || saved.repo_id !== repo.id)
      throw new AgentToolError(
        'Saved review is outside this workspace and repository.',
        'forbidden',
      );
    const review = getChangeReview(input.reviewId);
    if (review.workspaceId !== ctx.workspaceId || review.repoId !== repo.id)
      throw new AgentToolError(
        'Saved review is outside this workspace and repository.',
        'forbidden',
      );
    if (workflowGraph?.workItemRef && hash(workflowGraph.workItemRef) !== hash(review.workItemRef))
      throw new AgentToolError(
        'The saved review must match the current workflow work item.',
        'conflict',
      );
    source = review.workItemRef
      ? {
          kind: 'work-item',
          text: review.criteria.at(-1)?.sourceText ?? '',
          workItemRef: review.workItemRef,
          workItemTitle: review.workItem?.title,
        }
      : { kind: 'prompt', text: review.criteria.at(-1)?.sourceText ?? '' };
    if (review.workItemRef) {
      try {
        source = await workItemSource(review.workItemRef);
      } catch {
        data.freshness = 'unknown';
        data.freshnessDetail =
          'Showing saved criteria. Reconnect the work item before running new checks.';
      }
    }
    data.source = source;
    data.legacyReviewId = review.id;
    data.history = review.runs.slice(-50).map((run) => ({
      id: run.id,
      outcome: run.outcome,
      recordedAt: run.startedAt,
      summary: `Historical replay on ${run.candidate.head.slice(0, 8)}. A replay result does not establish acceptance of every criterion.`,
    }));
  }
  for (const [id, value] of contexts)
    if (Date.now() - value.createdAt > 10 * 60_000) contexts.delete(id);
  if (contexts.size >= 100) contexts.delete(contexts.keys().next().value!);
  const contextId = randomUUID();
  contexts.set(contextId, { sessionId: ctx.sessionId, createdAt: Date.now(), data, request });
  return { contextId, data, request };
}

export function requireValidation(
  ctx: AgentToolSessionContext,
  surfaceId: string,
): AgentUISurfaceIntent {
  const intent = requireSurfaceInScope(ctx, surfaceId);
  if (intent.payload.surfaceKind !== 'validation')
    throw new AgentToolError('This is not a validation plan.', 'invalid-params');
  assertRepoInScope(ctx, (intent.payload.data as ValidationSurfaceData).repoId);
  return intent;
}

export function publishValidation(
  ctx: AgentToolSessionContext,
  input: {
    contextId: string;
    title: string;
    criteria: ValidationCriterion[];
    surfaceId?: string;
    baseRevision?: number;
  },
): AgentUISurfaceIntent {
  const context = contexts.get(input.contextId);
  if (
    !context ||
    context.sessionId !== ctx.sessionId ||
    Date.now() - context.createdAt > 10 * 60_000
  )
    throw new AgentToolError(
      'Read validation_context again before publishing this plan.',
      'conflict',
    );
  assertRepoInScope(ctx, context.data.repoId);
  const repo = validationRepo(context.data);
  const snapshot = captureReviewSnapshot(repo.path);
  if (snapshot.tree !== context.data.snapshot.tree || snapshot.head !== context.data.snapshot.head)
    throw new AgentToolError(
      'Source changed while defining the checks. Read validation_context again.',
      'conflict',
    );
  if (
    !input.criteria.length ||
    new Set(input.criteria.map((criterion) => criterion.id)).size !== input.criteria.length
  )
    throw new AgentToolError('Use between 1 and 30 criteria with unique ids.', 'invalid-params');
  for (const criterion of input.criteria) {
    if (criterion.result)
      throw new AgentToolError(
        'New or revised checks start unchecked. Record evidence after execution.',
        'invalid-params',
      );
    if ((criterion.method === 'command') !== Boolean(criterion.command?.trim()))
      throw new AgentToolError(
        'Only command checks have a command, and each command check needs one.',
        'invalid-params',
      );
  }
  const data: ValidationSurfaceData = {
    ...context.data,
    criteria: input.criteria.map((criterion) => ({
      ...criterion,
      basis: context.data.source.text
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .includes(criterion.text.toLowerCase().replace(/\s+/g, ' '))
        ? context.data.source.kind === 'work-item'
          ? 'work-item'
          : 'request'
        : 'inferred',
    })),
    criteriaVersion: hash([context.data.source, input.criteria]),
  };
  let intent: AgentUISurfaceIntent;
  if (input.surfaceId) {
    const current = requireValidation(ctx, input.surfaceId);
    if ((current.payload.data as ValidationSurfaceData).repoId !== data.repoId)
      throw new AgentToolError('A revised plan must use the same repository.', 'forbidden');
    if (running.has(current.id))
      throw new AgentToolError('Stop the current validation before revising its plan.', 'conflict');
    if (!input.baseRevision)
      throw new AgentToolError('baseRevision is required when revising a plan.', 'invalid-params');
    intent = patchSurface(current.id, input.baseRevision, () => data, { title: input.title });
  } else {
    intent = publishSurface(ctx, { surfaceKind: 'validation', title: input.title, data });
  }
  contexts.delete(input.contextId);
  return intent;
}

export async function refreshValidation(surfaceId: string): Promise<AgentUISurfaceIntent> {
  const intent = getSurface(surfaceId);
  if (!intent || intent.payload.surfaceKind !== 'validation')
    throw new AgentToolError('Validation is unavailable.', 'not-found');
  const data = intent.payload.data as ValidationSurfaceData;
  let freshness: ValidationSurfaceData['freshness'] = 'current';
  let freshnessDetail: string | undefined;
  try {
    const snapshot = captureReviewSnapshot(validationRepo(data).path);
    if (snapshot.tree !== data.snapshot.tree || snapshot.head !== data.snapshot.head) {
      freshness = 'stale';
      freshnessDetail =
        'The source changed. Refine the plan against the current candidate before rerunning checks.';
    }
    if (
      data.source.workItemRef &&
      (await workItemSource(data.source.workItemRef)).text !== data.source.text
    ) {
      freshness = 'stale';
      freshnessDetail = 'The work item criteria changed. Refresh the plan in chat.';
    }
  } catch {
    freshness = 'unknown';
    freshnessDetail =
      'The source or work item could not be refreshed. Existing evidence remains historical.';
  }
  const latest = getSurface(surfaceId)?.payload.data as ValidationSurfaceData | undefined;
  if (
    !latest ||
    latest.criteriaVersion !== data.criteriaVersion ||
    latest.snapshot.tree !== data.snapshot.tree ||
    latest.snapshot.head !== data.snapshot.head
  )
    throw new AgentToolError('Validation changed while refreshing. Read it again.', 'conflict');
  return patchSurface<ValidationSurfaceData>(surfaceId, undefined, (current) => ({
    ...current,
    freshness,
    freshnessDetail,
    criteria: current.criteria.map((criterion) =>
      criterion.result?.status === 'running' && !running.has(surfaceId)
        ? {
            ...criterion,
            result: {
              ...criterion.result,
              status: 'blocked',
              summary: 'Execution was interrupted. Rerun this check.',
            },
          }
        : criterion,
    ),
  }));
}

export async function startValidation(
  ctx: AgentToolSessionContext,
  surfaceId: string,
  criterionIds?: string[],
  criteriaVersion?: string,
): Promise<AgentUISurfaceIntent> {
  const original = requireValidation(ctx, surfaceId).payload.data as ValidationSurfaceData;
  if (criteriaVersion !== undefined && original.criteriaVersion !== criteriaVersion)
    throw new AgentToolError(
      'The validation plan changed. Read the current plan before running it.',
      'conflict',
    );
  const mode = constrainPermissionMode(ctx.mode, getSettings().codexMode ?? 'on-request');
  if (mode === 'read-only')
    throw new AgentToolError('Command validation is unavailable in read-only mode.', 'forbidden');
  if (running.has(surfaceId))
    throw new AgentToolError('Validation is already running.', 'conflict');
  const controller = new AbortController();
  running.set(surfaceId, controller);
  try {
    const refreshed = await refreshValidation(surfaceId);
    const data = refreshed.payload.data as ValidationSurfaceData;
    if (data.freshness !== 'current') throw new AgentToolError(data.freshnessDetail!, 'conflict');
    if (criterionIds?.some((id) => !data.criteria.some((criterion) => criterion.id === id)))
      throw new AgentToolError('Unknown validation criterion.', 'invalid-params');
    const checks = data.criteria.filter(
      (criterion) =>
        criterion.method === 'command' && (!criterionIds || criterionIds.includes(criterion.id)),
    );
    if (!checks.length)
      throw new AgentToolError(
        'This selection has no command checks. Use the provider tools for browser or manual checks, then validation_record.',
        'invalid-params',
      );
    if (
      mode === 'on-request' &&
      !(await requestUserApproval(
        ctx,
        {
          title: 'Run validation checks',
          detail: checks.map((check) => `${check.text}\n${check.command}`).join('\n\n'),
          consequences: `Run in ${data.repoName} under this session's access. Results apply only to the captured source.`,
        },
        controller.signal,
      ))
    )
      throw new AgentToolError('Validation was not approved.', 'forbidden');
    const latest = requireValidation(ctx, surfaceId).payload.data as ValidationSurfaceData;
    if (latest.criteriaVersion !== data.criteriaVersion)
      throw new AgentToolError('The validation plan changed during approval.', 'conflict');
    const current = await refreshValidation(surfaceId);
    if ((current.payload.data as ValidationSurfaceData).freshness !== 'current')
      throw new AgentToolError('Source or criteria changed during approval.', 'conflict');
    controller.signal.throwIfAborted();
    const ids = new Set(checks.map((check) => check.id));
    const started = patchSurface<ValidationSurfaceData>(surfaceId, undefined, (current) => ({
      ...current,
      criteria: current.criteria.map((criterion) =>
        ids.has(criterion.id)
          ? {
              ...criterion,
              result: {
                status: 'running',
                summary: 'Waiting to run',
                evidence: '',
                provenance: 'runner-observed',
                recordedAt: new Date().toISOString(),
              },
            }
          : criterion,
      ),
    }));
    const completion = executeChecks(ctx, surfaceId, checks, mode, controller)
      .catch(() => undefined)
      .finally(() => {
        if (running.get(surfaceId) === controller) running.delete(surfaceId);
        completions.delete(surfaceId);
        const result = getSurface(surfaceId);
        if (result)
          void deliverSurfaceFeedback(
            surfaceId,
            `Validation finished. ${result.payload.digest}\nReport the observed results and remaining unchecked criteria. This is not human acceptance.`,
          ).catch(() => undefined);
      });
    completions.set(surfaceId, completion);
    return started;
  } catch (error) {
    running.delete(surfaceId);
    throw error;
  }
}

async function executeChecks(
  ctx: AgentToolSessionContext,
  surfaceId: string,
  checks: ValidationCriterion[],
  mode: AgentToolSessionContext['mode'],
  controller: AbortController,
): Promise<void> {
  try {
    for (const check of checks) {
      if (controller.signal.aborted) break;
      const current = await refreshValidation(surfaceId);
      const data = current.payload.data as ValidationSurfaceData;
      if (data.freshness !== 'current') break;
      const effectiveMode = constrainPermissionMode(
        constrainPermissionMode(mode, getAgentToolSessionContext(ctx.sessionId)?.mode ?? mode),
        getSettings().codexMode ?? 'on-request',
      );
      if (effectiveMode !== mode) break;
      const outcome = await runVerificationCommand({
        repositoryId: data.repoId,
        command: check.command!,
        cwd: validationRepo(data).path,
        target: { kind: 'integration', integrationId: surfaceId, runId: data.criteriaVersion },
        permissionMode: effectiveMode,
        approve: async () => true,
        isCancelled: () =>
          controller.signal.aborted ||
          constrainPermissionMode(
            constrainPermissionMode(mode, getAgentToolSessionContext(ctx.sessionId)?.mode ?? mode),
            getSettings().codexMode ?? 'on-request',
          ) !== mode,
      });
      const status =
        !outcome.approvalGranted ||
        controller.signal.aborted ||
        outcome.timedOut ||
        outcome.exitCode === null
          ? 'blocked'
          : outcome.exitCode === 0
            ? 'passed'
            : 'failed';
      patchSurface<ValidationSurfaceData>(surfaceId, undefined, (current) => ({
        ...current,
        criteria: current.criteria.map((criterion) =>
          criterion.id === check.id
            ? {
                ...criterion,
                result: {
                  status,
                  summary: controller.signal.aborted
                    ? 'Check stopped'
                    : outcome.timedOut
                      ? 'Check timed out'
                      : `Command exited ${outcome.exitCode ?? 'without a result'}`,
                  evidence: `${check.command}\n\n${outcome.logTail}`,
                  provenance: 'runner-observed',
                  recordedAt: new Date().toISOString(),
                },
              }
            : criterion,
        ),
      }));
    }
  } catch (error) {
    patchSurface<ValidationSurfaceData>(surfaceId, undefined, (current) => ({
      ...current,
      freshness: 'unknown',
      freshnessDetail: error instanceof Error ? error.message : 'Execution could not finish.',
    }));
  } finally {
    patchSurface<ValidationSurfaceData>(surfaceId, undefined, (current) => ({
      ...current,
      criteria: current.criteria.map((criterion) =>
        criterion.result?.status === 'running'
          ? {
              ...criterion,
              result: {
                ...criterion.result,
                status: 'blocked',
                summary: 'Check did not finish. Rerun it when ready.',
              },
            }
          : criterion,
      ),
    }));
    await refreshValidation(surfaceId);
  }
}

export async function recordValidation(
  ctx: AgentToolSessionContext,
  input: {
    surfaceId: string;
    baseRevision: number;
    criterionId: string;
    status: 'passed' | 'failed' | 'blocked' | 'unchecked';
    summary: string;
    evidence: string;
  },
): Promise<AgentUISurfaceIntent> {
  const intent = requireValidation(ctx, input.surfaceId);
  if (intent.revision !== input.baseRevision)
    throw new AgentToolError(
      'Read the current validation revision before recording evidence.',
      'conflict',
    );
  const criterion = (intent.payload.data as ValidationSurfaceData).criteria.find(
    (item) => item.id === input.criterionId,
  );
  if (!criterion || criterion.method === 'command')
    throw new AgentToolError(
      'Command results must come from validation_run. Choose a browser, manual or inspection criterion.',
      'invalid-params',
    );
  if ((input.status === 'passed' || input.status === 'failed') && !input.evidence.trim())
    throw new AgentToolError(
      'Attach observed evidence or leave the criterion unchecked.',
      'invalid-params',
    );
  const planVersion = (intent.payload.data as ValidationSurfaceData).criteriaVersion;
  const refreshed = await refreshValidation(input.surfaceId);
  if ((refreshed.payload.data as ValidationSurfaceData).criteriaVersion !== planVersion)
    throw new AgentToolError('The plan changed before evidence was recorded.', 'conflict');
  if ((refreshed.payload.data as ValidationSurfaceData).freshness !== 'current')
    throw new AgentToolError('Evidence does not match the current source or criteria.', 'conflict');
  return patchSurface<ValidationSurfaceData>(input.surfaceId, refreshed.revision, (current) => ({
    ...current,
    criteria: current.criteria.map((item) =>
      item.id === input.criterionId
        ? {
            ...item,
            result: {
              status: input.status,
              summary: input.summary,
              evidence: input.evidence,
              provenance: 'agent-reported',
              recordedAt: new Date().toISOString(),
            },
          }
        : item,
    ),
  }));
}

export function cancelValidation(surfaceId: string): void {
  running.get(surfaceId)?.abort();
}
export function cleanupValidations(): void {
  for (const controller of running.values()) controller.abort();
  contexts.clear();
}

/** A workflow cannot finish its validation step while its checks are still running. */
export async function finishThreadValidations(
  threadId: string,
  signal: AbortSignal,
  required = false,
): Promise<{ complete: boolean; summary: string } | null> {
  const surfaces = listAgentUISurfaces(threadId, { surfaceKind: 'validation' });
  if (!surfaces.length)
    return required
      ? { complete: false, summary: 'No validation evidence was published for this step.' }
      : null;
  signal.throwIfAborted();
  const abort = () => {
    for (const surface of surfaces) cancelValidation(surface.id);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await Promise.all(surfaces.map((surface) => completions.get(surface.id)));
    signal.throwIfAborted();
    const current = await Promise.all(surfaces.map((surface) => refreshValidation(surface.id)));
    return {
      complete: current.every((surface) => {
        const data = surface.payload.data as ValidationSurfaceData;
        return (
          data.freshness === 'current' &&
          data.criteria.length > 0 &&
          data.criteria.every((criterion) => criterion.result?.status === 'passed')
        );
      }),
      summary: current.map((surface) => surface.payload.digest).join('\n\n'),
    };
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
