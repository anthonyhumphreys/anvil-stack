import { createHash } from 'node:crypto';
import type {
  ChatDelegationAction,
  ChatDelegationInput,
  ChatDelegationRun,
} from '../../shared/chat-delegation.js';
import type { WorkflowEdge, WorkflowNode, WorkflowRun } from '../../shared/types.js';
import { DEFAULT_ORCHESTRATION } from '../../shared/workflow-orchestration.js';
import { constrainPermissionMode } from '../../../cloud/contract/permissions.js';
import { AgentToolError, type AgentToolSessionContext } from '../agent-tools/dispatch.js';
import { getDb } from '../db/database.js';
import { requestUserApproval } from '../surfaces/core.js';
import { discoverDelegationCapabilities } from './delegation-capabilities.service.js';
import {
  captureThreadContinuation,
  prependThreadContinuation,
} from './chat-continuation.service.js';
import {
  deliverStructuredAgentFeedback,
  getAgentToolSessionContext,
  getCodexSession,
  listActiveCodexSessions,
} from './codex-session.service.js';
import { hasPendingAgentQuestion } from './agent-question.service.js';
import { getChatThread } from './chat-persistence.service.js';
import {
  assertChatDelegationSources,
  cancelWorkflowRun,
  convergeWorkflowRun,
  getWorkflowRun,
  getChatWorkflowRunByRequest,
  listChatWorkflowRuns,
  resumeWorkflowRun,
  retryWorkflowNode,
  startChatWorkflowRun,
  validateWorkflowGraph,
} from './workflow.service.js';
import {
  cancelNodeDispatch,
  getWorkflowDispatch,
  refreshDispatch,
} from './mesh-dispatch.service.js';

type ProposalResult =
  | ChatDelegationRun
  | { status: 'cancelled' }
  | { status: 'awaiting-approval'; requestId: string; title: string };
interface PreparedProposal {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  names: Record<string, string>;
  detail: string;
}
const pending = new Map<
  string,
  { threadId: string; fingerprint: string; reply: Promise<ProposalResult> }
>();

export function describeChatDelegation(run: WorkflowRun): ChatDelegationRun {
  if (!run.chatOrigin) throw new Error('This run is not a chat delegation.');
  const budget = Math.floor(24000 / Math.max(1, run.nodeRuns.length));
  return {
    id: run.id,
    title: run.templateName,
    reason: run.chatOrigin.reason,
    status: run.status,
    createdAt: run.createdAt,
    cancellationPending:
      run.status === 'cancelled' &&
      run.nodeRuns.some(
        (task) =>
          task.remote &&
          !['completed', 'failed', 'cancelled'].includes(
            getWorkflowDispatch(task.remote.dispatchId)?.state ?? task.remote.state,
          ),
      ),
    ...(run.error ? { error: run.error } : {}),
    tasks: run.nodeRuns.map((state) => {
      const node = run.nodes.find((n) => n.id === state.nodeId)!;
      return {
        id: node.id,
        name: node.name,
        provider: node.provider ?? 'codex',
        model: node.model,
        destination: run.chatOrigin!.destinations[node.id] ?? 'Unknown destination',
        mode: node.permissionMode ?? 'read-only',
        status: state.status,
        output: state.output?.slice(0, budget),
        outputTruncated: (state.output?.length ?? 0) > budget,
        error: state.error,
        threadId: state.threadId,
        remoteState: state.remote?.state,
      };
    }),
    hasRemoteChanges: run.nodes.some(
      (node) => node.target && node.target.kind !== 'local' && node.permissionMode !== 'read-only',
    ),
    integrationState: run.convergence?.state,
  };
}

export async function listChatDelegations(threadId: string): Promise<ChatDelegationRun[]> {
  const runs = listChatWorkflowRuns(threadId);
  for (const run of runs) {
    if (run.status !== 'cancelled') continue;
    for (const task of run.nodeRuns) {
      if (
        task.remote &&
        !['completed', 'failed', 'cancelled'].includes(
          getWorkflowDispatch(task.remote.dispatchId)?.state ?? task.remote.state,
        )
      ) {
        // A cancelled scheduler must never replay a durable request without
        // recording cancellation intent first, including older paused runs.
        if (!getWorkflowDispatch(task.remote.dispatchId)?.cancelRequested)
          await cancelNodeDispatch(task.remote.dispatchId).catch(() => undefined);
        if (getWorkflowDispatch(task.remote.dispatchId)?.cancelRequested)
          await refreshDispatch(task.remote.dispatchId).catch(() => undefined);
      }
    }
  }
  return runs
    .map((run) => {
      const view = describeChatDelegation(run);
      return {
        ...view,
        tasks: view.tasks.map((task) => ({
          ...task,
          output: undefined,
          outputTruncated: Boolean(task.output) || task.outputTruncated,
        })),
      };
    })
    .filter(
      (run, index) =>
        index < 20 ||
        ['queued', 'running', 'paused'].includes(run.status) ||
        run.cancellationPending,
    );
}

export async function assertChatDelegationsFinished(threadId: string): Promise<void> {
  const runs = await listChatDelegations(threadId);
  if (
    runs.some(
      (run) => ['queued', 'running', 'paused'].includes(run.status) || run.cancellationPending,
    )
  )
    throw new Error(
      'Stop the delegated work and wait for its workers to finish before deleting this chat.',
    );
}

export function requireChatDelegation(threadId: string, runId: string): WorkflowRun {
  const run = getWorkflowRun(runId);
  const thread = getChatThread(threadId);
  if (
    !run ||
    run.chatOrigin?.threadId !== threadId ||
    !thread ||
    run.workspaceId !== thread.workspaceId
  )
    throw new AgentToolError('Delegated work is outside this chat.', 'forbidden');
  return run;
}

export async function stopChatDelegation(
  threadId: string,
  runId: string,
): Promise<ChatDelegationRun> {
  requireChatDelegation(threadId, runId);
  const run = await cancelWorkflowRun(runId);
  if (!run) throw new AgentToolError('Delegated work not found.', 'not-found');
  // A paused run has no live abort listener. Cancel its durable dispatches too.
  await Promise.allSettled(
    run.nodeRuns.flatMap((task) =>
      task.remote &&
      !['completed', 'failed', 'cancelled'].includes(
        getWorkflowDispatch(task.remote.dispatchId)?.state ?? task.remote.state,
      )
        ? [cancelNodeDispatch(task.remote.dispatchId)]
        : [],
    ),
  );
  return describeChatDelegation(run);
}

export async function actOnChatDelegation(
  threadId: string,
  runId: string,
  action: ChatDelegationAction,
  nodeId?: string,
): Promise<ChatDelegationRun> {
  requireChatDelegation(threadId, runId);
  let run =
    action === 'resume'
      ? resumeWorkflowRun(runId)
      : action === 'retry' && nodeId
        ? retryWorkflowNode(runId, nodeId)
        : action === 'integrate'
          ? await convergeWorkflowRun(runId)
          : null;
  if (!run)
    throw new AgentToolError('Choose a supported delegation action and task.', 'invalid-params');
  if (action === 'retry' && !run.nodeRuns.some((task) => task.status === 'interrupted'))
    run = resumeWorkflowRun(runId);
  return describeChatDelegation(run);
}

function fingerprint(input: ChatDelegationInput, ctx: AgentToolSessionContext): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        workspaceId: ctx.workspaceId,
        repoIds: [...ctx.repoIds].sort(),
        title: input.title,
        reason: input.reason,
        tasks: input.tasks.map((t) => ({
          id: t.id,
          name: t.name,
          instruction: t.instruction,
          destinationId: t.destinationId,
          provider: t.provider,
          model: t.model,
          reasoningEffort: t.reasoningEffort,
          access: t.access ?? 'read-only',
          dependsOn: t.dependsOn ?? [],
        })),
      }),
    )
    .digest('hex');
}

export async function proposeChatDelegation(
  ctx: AgentToolSessionContext,
  input: ChatDelegationInput,
  signal?: AbortSignal,
): Promise<ProposalResult> {
  if (!input.title.trim() || !input.reason.trim())
    throw new AgentToolError(
      'Include a title and a concrete reason to delegate.',
      'invalid-params',
    );
  if (
    !/^[a-zA-Z0-9_-]+$/.test(input.requestId) ||
    !input.tasks.length ||
    input.tasks.length > 8 ||
    input.tasks.some((task) => !/^[a-zA-Z0-9_-]+$/.test(task.id))
  )
    throw new AgentToolError('Use 1–8 tasks and simple unique request/task IDs.', 'invalid-params');
  if (!ctx.appThreadId || !ctx.workspaceId || !ctx.repoIds.length)
    throw new AgentToolError(
      'Select a repository in a saved workspace chat before delegating.',
      'unavailable',
    );
  const thread = getChatThread(ctx.appThreadId);
  if (!thread || thread.temporary || thread.workspaceId !== ctx.workspaceId)
    throw new AgentToolError('Delegation needs a saved chat in this workspace.', 'forbidden');
  const digest = fingerprint(input, ctx);
  const existing = getChatWorkflowRunByRequest(ctx.appThreadId, input.requestId);
  if (existing) {
    if (existing.chatOrigin?.fingerprint !== digest)
      throw new AgentToolError(
        'This request ID already belongs to different delegated work.',
        'conflict',
      );
    return describeChatDelegation(existing);
  }
  const key = JSON.stringify([ctx.appThreadId, input.requestId]);
  const active = pending.get(key);
  if (active) {
    if (active.fingerprint !== digest)
      throw new AgentToolError('This request ID has a different pending proposal.', 'conflict');
    return active.reply;
  }
  if ([...pending.values()].some((proposal) => proposal.threadId === ctx.appThreadId))
    throw new AgentToolError(
      'Answer the current delegation proposal before proposing more work.',
      'conflict',
    );
  const reply = (async (): Promise<ProposalResult> => {
    try {
      const prepared = await prepareProposal(ctx, input, signal);
      if (!prepared) {
        pending.delete(key);
        return { status: 'cancelled' };
      }
      if (hasPendingAgentQuestion(ctx.sessionId))
        throw new AgentToolError('Answer the current question first.', 'conflict');
      // Approval belongs to the chat, not the lifetime of an MCP request. ACP
      // clients may time out tools long before a person has finished reading.
      void approveAndStart(ctx, input, digest, prepared)
        .then(async (result) => {
          await notifyCoordinator(ctx, {
            type: 'anvil.delegation.decision',
            requestId: input.requestId,
            ...result,
          }).catch((error) =>
            console.warn(
              '[Delegation] Live decision notice unavailable:',
              error instanceof Error ? error.message : String(error),
            ),
          );
        })
        .catch(async (error) => {
          console.warn(
            '[Delegation] Proposal could not start:',
            error instanceof Error ? error.message : String(error),
          );
          await notifyCoordinator(ctx, {
            type: 'anvil.delegation.decision',
            requestId: input.requestId,
            status: 'failed',
            error: error instanceof Error ? error.message : 'Could not start delegated work.',
          }).catch(() => undefined);
        })
        .finally(() => pending.delete(key));
      return { status: 'awaiting-approval', requestId: input.requestId, title: input.title };
    } catch (error) {
      pending.delete(key);
      throw error;
    }
  })();
  pending.set(key, { threadId: ctx.appThreadId, fingerprint: digest, reply });
  return reply;
}

async function prepareProposal(
  ctx: AgentToolSessionContext,
  input: ChatDelegationInput,
  signal?: AbortSignal,
): Promise<PreparedProposal | null> {
  const capabilities = await discoverDelegationCapabilities(ctx);
  const source = getCodexSession(ctx.sessionId);
  if (!source || signal?.aborted) return null;
  const names: Record<string, string> = {};
  const nodes: WorkflowNode[] = input.tasks.map((task, index) => {
    const destination = capabilities.destinations.find((d) => d.id === task.destinationId);
    const provider = task.provider ?? ctx.provider;
    const config = capabilities.providers.find((p) => p.id === provider);
    if (!destination || !destination.providers.includes(provider) || !config)
      throw new AgentToolError(
        `The destination cannot run ${provider} for ${task.name}. Discover capabilities again or choose another destination.`,
        'unavailable',
      );
    const model = task.model ?? config.defaultModel;
    if (!model || !config.models.some((m) => m.id === model))
      throw new AgentToolError(`Choose a discovered model for ${task.name}.`, 'invalid-params');
    names[task.id] = destination.label;
    return {
      id: task.id,
      name: task.name,
      prompt: task.instruction,
      personaId: source.personaId,
      provider,
      model,
      reasoningEffort: task.reasoningEffort ?? 'medium',
      executionStrategy: 'focused',
      teamStrategy: 'manual',
      position: { x: index * 300, y: 0 },
      target: structuredClone(destination.target),
      permissionMode: task.access === 'inherit' ? ctx.mode : 'read-only',
    };
  });
  const edges = input.tasks.flatMap((task) =>
    (task.dependsOn ?? []).map((id) => ({ id: `${id}:${task.id}`, source: id, target: task.id })),
  );
  validateWorkflowGraph(nodes, edges);
  if (nodes.some((node) => node.target && node.target.kind !== 'local'))
    assertChatDelegationSources(ctx.workspaceId!, ctx.repoIds);
  const repositoryNames = ctx.repoIds.map(
    (id) =>
      (
        getDb().prepare('SELECT name FROM repos WHERE id = ?').get(id) as
          { name: string } | undefined
      )?.name ?? id,
  );
  const detail = [
    input.reason,
    `Repositories: ${repositoryNames.join(', ')}`,
    ...nodes.map(
      (node) =>
        `${node.name}\n${names[node.id]} · ${node.provider} · ${node.model} · ${node.permissionMode === 'read-only' ? 'Read only' : 'Within this chat’s access'}\n${node.prompt}`,
    ),
    ...(nodes.some((node) => node.target?.kind !== 'local')
      ? [
          'Remote tasks use committed snapshots. Dependencies pass reports, not code changes. Returned code needs explicit integration.',
        ]
      : nodes.some((node) => node.permissionMode !== 'read-only')
        ? ['These tasks share your local checkout and will run one at a time.']
        : []),
  ].join('\n\n');
  return { nodes, edges, names, detail };
}

async function approveAndStart(
  ctx: AgentToolSessionContext,
  input: ChatDelegationInput,
  digest: string,
  prepared: PreparedProposal,
): Promise<ChatDelegationRun | { status: 'cancelled' }> {
  const { nodes, edges, names, detail } = prepared;
  const approved = await requestUserApproval(
    ctx,
    {
      title: `Delegate ${nodes.length === 1 ? 'this task' : `${nodes.length} tasks`}?`,
      detail,
      consequences:
        'Only these tasks and destinations will start. You can stop them in this chat.' +
        (nodes.some(
          (node) =>
            node.target?.kind === 'existing-environment' ||
            node.target?.kind === 'provisioned-environment',
        )
          ? ' Cloud environments may use your configured resources for up to 30 minutes.'
          : ''),
    },
    undefined,
    { keepAcrossTurns: true },
  );
  const live = getCodexSession(ctx.sessionId);
  if (!approved || !live || live.appThreadId !== ctx.appThreadId) return { status: 'cancelled' };
  const liveScope = getAgentToolSessionContext(ctx.sessionId);
  if (
    !liveScope ||
    liveScope.workspaceId !== ctx.workspaceId ||
    JSON.stringify([...liveScope.repoIds].sort()) !== JSON.stringify([...ctx.repoIds].sort())
  )
    throw new AgentToolError(
      'The chat’s repository scope changed. Propose the work again with the current selection.',
      'conflict',
    );
  if (
    listChatWorkflowRuns(ctx.appThreadId!).filter((run) =>
      ['running', 'queued', 'paused'].includes(run.status),
    ).length >= 4
  )
    throw new AgentToolError(
      'This chat already has four active delegations. Wait for one to finish.',
      'unavailable',
    );
  const run = startChatWorkflowRun({
    workspaceId: ctx.workspaceId!,
    repoIds: [...ctx.repoIds],
    permissionCeiling: constrainPermissionMode(ctx.mode, liveScope.mode),
    kickoff: prependThreadContinuation(
      captureThreadContinuation(ctx.appThreadId!).context,
      input.reason,
    ),
    origin: {
      threadId: ctx.appThreadId!,
      requestId: input.requestId,
      fingerprint: digest,
      reason: input.reason,
      destinations: names,
    },
    definition: {
      name: input.title,
      nodes,
      edges,
      orchestration: {
        ...DEFAULT_ORCHESTRATION,
        profiles: [],
        maxConcurrency: nodes.every((node) => node.permissionMode === 'read-only') ? 2 : 1,
        maxNodes: 8,
        maxDepth: 0,
        maxAttempts: 2,
        timeoutMinutes: 30,
      },
    },
  });
  return describeChatDelegation(run);
}

async function notifyCoordinator(
  ctx: Pick<AgentToolSessionContext, 'appThreadId' | 'workspaceId' | 'repoIds'>,
  payload: Record<string, unknown>,
): Promise<void> {
  const coordinator = listActiveCodexSessions().find(
    (session) =>
      session.appThreadId === ctx.appThreadId &&
      session.workspaceId === ctx.workspaceId &&
      ctx.repoIds.every((id) => getAgentToolSessionContext(session.id)?.repoIds.includes(id)),
  );
  if (coordinator) await deliverStructuredAgentFeedback(coordinator.id, JSON.stringify(payload));
}

/** Called after every scheduler attempt, including retry and restart recovery. */
export async function notifyChatDelegationResult(run: WorkflowRun): Promise<void> {
  if (!run.chatOrigin) return;
  await notifyCoordinator(
    { appThreadId: run.chatOrigin.threadId, workspaceId: run.workspaceId, repoIds: run.repoIds },
    { type: 'anvil.delegation.result', ...describeChatDelegation(run) },
  );
}
