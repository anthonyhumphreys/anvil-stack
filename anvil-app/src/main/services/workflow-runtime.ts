import { randomUUID } from 'node:crypto';
import { resolveCodexReasoningEffort } from '../../shared/codex-models';
import type { WorkflowNode, WorkflowRun, WorkflowRuntimeEvent } from '../../shared/types';
import {
  orchestrationConfig,
  parseDelegation,
  readyWorkflowNodes,
  specialistNode,
  type DelegatedTask,
} from '../../shared/workflow-orchestration';

export interface WorkflowRuntimeHooks {
  persist: (run: WorkflowRun) => void;
  execute: (
    run: WorkflowRun,
    node: WorkflowNode,
    signal: AbortSignal,
  ) => Promise<{ output: string; sessionId?: string; threadId?: string }>;
  signal: AbortSignal;
}

export function recordWorkflowEvent(
  run: WorkflowRun,
  type: WorkflowRuntimeEvent['type'],
  message: string,
  nodeId?: string,
): void {
  (run.events ??= []).push({
    id: randomUUID(),
    at: new Date().toISOString(),
    type,
    message,
    nodeId,
  });
}

export function expandWorkflowTeam(
  run: WorkflowRun,
  parent: WorkflowNode,
  tasks: DelegatedTask[],
): void {
  const config = orchestrationConfig(run.orchestration);
  const state = run.nodeRuns.find((item) => item.nodeId === parent.id)!;
  if ((parent.depth ?? 0) >= config.maxDepth) throw new Error('Maximum delegation depth reached.');
  if (run.nodes.length + tasks.length > config.maxNodes)
    throw new Error('Maximum workflow node count reached.');
  if ((state.delegationCount ?? 0) >= config.maxAttempts)
    throw new Error('Delegation round limit reached.');
  const profiles = tasks.map((task) => {
    const profile = config.profiles.find((candidate) => candidate.id === task.profileId);
    if (!profile || (parent.teamProfileIds?.length && !parent.teamProfileIds.includes(profile.id)))
      throw new Error(`Specialist ${task.profileId} is not allowed for this step.`);
    return profile;
  });
  const incoming = run.edges.filter((edge) => edge.target === parent.id);
  tasks.forEach((task, index) => {
    const id = randomUUID();
    const child: WorkflowNode = {
      ...specialistNode(profiles[index], id, task.name, task.prompt),
      parentNodeId: parent.id,
      depth: (parent.depth ?? 0) + 1,
      teamStrategy: parent.teamStrategy === 'autonomous' ? 'autonomous' : 'manual',
      teamProfileIds: parent.teamProfileIds,
      position: { x: parent.position.x - 330, y: parent.position.y + (index + 1) * 190 },
    };
    run.nodes.push(child);
    run.nodeRuns.push({ nodeId: id, status: 'queued', attempts: [] });
    for (const edge of incoming)
      run.edges.push({ id: randomUUID(), source: edge.source, target: id });
    run.edges.push({ id: randomUUID(), source: id, target: parent.id });
  });
  state.teamExpanded = true;
  state.delegationCount = (state.delegationCount ?? 0) + 1;
  state.status = 'queued';
  recordWorkflowEvent(
    run,
    'delegated',
    `${parent.name} delegated ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`,
    parent.id,
  );
}

export function workflowHandoff(run: WorkflowRun, node: WorkflowNode): string {
  const config = orchestrationConfig(run.orchestration);
  const upstreamIds = [
    ...new Set(run.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source)),
  ];
  const each = Math.max(1, Math.floor(config.handoffChars / Math.max(1, upstreamIds.length)));
  return upstreamIds
    .map((id) => {
      const state = run.nodeRuns.find((item) => item.nodeId === id);
      const source = run.nodes.find((item) => item.id === id);
      const output = state?.output ?? 'No handoff available.';
      return `### ${source?.name ?? id} [node ${id}; attempt ${state?.attempts?.at(-1)?.id ?? 'legacy'}]\n${output.slice(0, each)}${output.length > each ? '\n[Truncated; inspect the source thread for the full handoff.]' : ''}`;
    })
    .join('\n\n');
}

/** One scheduler owns a run object. All external commands mutate that same object. */
export async function runWorkflowRuntime(
  run: WorkflowRun,
  hooks: WorkflowRuntimeHooks,
): Promise<void> {
  if (hooks.signal.aborted || run.status === 'cancelled') {
    run.status = 'cancelled';
    run.completedAt = new Date().toISOString();
    for (const state of run.nodeRuns)
      if (['queued', 'running', 'waiting'].includes(state.status)) state.status = 'cancelled';
    hooks.persist(run);
    return;
  }
  const config = orchestrationConfig(run.orchestration);
  const running = new Map<string, Promise<void>>();
  const controller = new AbortController();
  const abort = () => controller.abort();
  hooks.signal.addEventListener('abort', abort, { once: true });
  if (hooks.signal.aborted) abort();
  run.status = 'running';
  run.startedAt ??= new Date().toISOString();
  run.deadlineAt ??= new Date(Date.now() + config.timeoutMinutes * 60000).toISOString();
  const timeout = setTimeout(
    () => {
      run.status = 'failed';
      run.error = 'Workflow wall-clock limit reached.';
      recordWorkflowEvent(run, 'failed', run.error);
      controller.abort();
      hooks.persist(run);
    },
    Math.max(0, Date.parse(run.deadlineAt) - Date.now()),
  );
  recordWorkflowEvent(run, 'run', 'Scheduler started.');
  hooks.persist(run);

  const execute = async (node: WorkflowNode) => {
    const state = run.nodeRuns.find((item) => item.nodeId === node.id)!;
    try {
      if (node.kind === 'human') {
        state.status = 'waiting';
        recordWorkflowEvent(
          run,
          'decision',
          `${node.name} is waiting for a human decision.`,
          node.id,
        );
        return;
      }
      if (
        !state.teamExpanded &&
        ['map-reduce', 'review', 'debate'].includes(node.teamStrategy ?? '')
      ) {
        const profiles = config.profiles.filter((profile) =>
          node.teamProfileIds?.includes(profile.id),
        );
        if (!profiles.length) throw new Error('Choose at least one specialist for this team.');
        expandWorkflowTeam(
          run,
          node,
          profiles.map((profile, index) => ({
            profileId: profile.id,
            name: `${node.name} / ${profile.name}`,
            prompt: `${node.prompt}\n\nYour role: ${profile.name}. Capabilities: ${profile.capabilities.join(', ')}.\n${node.teamStrategy === 'map-reduce' ? `Own share ${index + 1} of ${profiles.length}; focus on your capabilities and clearly state your scope.` : node.teamStrategy === 'debate' ? 'Develop an independent alternative. Explain assumptions, supporting evidence, and weaknesses.' : 'Review independently. Report concrete findings with evidence and distinguish observed results from assumptions.'}`,
          })),
        );
        return;
      }
      if ((state.attempts?.length ?? 0) >= config.maxAttempts)
        throw new Error('Maximum attempts reached for this step.');
      const attempt = {
        id: randomUUID(),
        startedAt: new Date().toISOString(),
        status: 'running' as const,
        provider: node.provider ?? 'codex',
        model: node.model,
        reasoningEffort:
          node.provider === 'cursor'
            ? node.reasoningEffort
            : resolveCodexReasoningEffort(node.model, node.reasoningEffort),
      };
      (state.attempts ??= []).push(attempt);
      state.status = 'running';
      state.startedAt = attempt.startedAt;
      state.completedAt = undefined;
      state.error = undefined;
      recordWorkflowEvent(
        run,
        'dispatch',
        `${node.name}: ${attempt.provider} / ${node.model} / ${node.reasoningEffort}`,
        node.id,
      );
      hooks.persist(run);
      try {
        const result = await hooks.execute(run, node, controller.signal);
        const current = state.attempts.at(-1)!;
        if (controller.signal.aborted || run.status === 'cancelled') {
          current.status = 'cancelled';
          current.completedAt = new Date().toISOString();
          state.status = 'cancelled';
          return;
        }
        Object.assign(current, result, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
        state.output = result.output;
        state.sessionId = result.sessionId;
        state.threadId = result.threadId ?? state.threadId;
        const tasks = node.teamStrategy === 'autonomous' ? parseDelegation(result.output) : null;
        if (tasks) {
          if (state.attempts.length >= config.maxAttempts)
            throw new Error('Delegation needs a remaining attempt for synthesis.');
          expandWorkflowTeam(run, node, tasks);
        } else {
          state.status = 'completed';
          recordWorkflowEvent(run, 'completed', `${node.name} completed.`, node.id);
        }
      } catch (error) {
        const current = state.attempts.at(-1)!;
        current.status = controller.signal.aborted ? 'cancelled' : 'failed';
        current.error = error instanceof Error ? error.message : String(error);
        current.completedAt = new Date().toISOString();
        throw error;
      }
    } catch (error) {
      state.status = controller.signal.aborted ? 'cancelled' : 'failed';
      state.error = error instanceof Error ? error.message : String(error);
      recordWorkflowEvent(run, 'failed', `${node.name}: ${state.error}`, node.id);
    } finally {
      if (state.status !== 'queued' && state.status !== 'waiting')
        state.completedAt = new Date().toISOString();
      hooks.persist(run);
    }
  };

  try {
    while (true) {
      if (run.status === 'running' && !controller.signal.aborted) {
        for (const node of readyWorkflowNodes(run)) {
          if (running.size >= config.maxConcurrency) break;
          const job = execute(node);
          running.set(node.id, job);
          void job.then(
            () => running.delete(node.id),
            () => running.delete(node.id),
          );
        }
      }
      if (running.size) {
        await Promise.race(running.values());
        continue;
      }
      if (run.status !== 'running' || controller.signal.aborted) break;
      if (readyWorkflowNodes(run).length) continue;
      // Propagate failed dependencies without skipping work held behind human decisions.
      let changed = true;
      while (changed) {
        changed = false;
        for (const state of run.nodeRuns.filter((item) => item.status === 'queued')) {
          if (
            run.edges.some(
              (edge) =>
                edge.target === state.nodeId &&
                ['failed', 'skipped', 'cancelled', 'interrupted'].includes(
                  run.nodeRuns.find((item) => item.nodeId === edge.source)?.status ?? '',
                ),
            )
          ) {
            state.status = 'skipped';
            state.error = 'An upstream step did not complete.';
            changed = true;
          }
        }
      }
      if (run.nodeRuns.some((state) => state.status === 'waiting')) {
        run.status = 'paused';
        recordWorkflowEvent(run, 'run', 'Waiting for a human decision.');
      } else if (run.nodeRuns.some((state) => state.status !== 'completed')) {
        run.status = 'failed';
        run.error = 'Some steps failed or remain blocked. Inspect the run before retrying.';
      } else {
        run.status = 'completed';
        run.error = undefined;
      }
      break;
    }
  } finally {
    clearTimeout(timeout);
    hooks.signal.removeEventListener('abort', abort);
    if (controller.signal.aborted) {
      if (run.status === 'running' || run.status === 'paused') run.status = 'cancelled';
      for (const state of run.nodeRuns)
        if (['queued', 'running', 'waiting'].includes(state.status)) state.status = 'cancelled';
    }
    if (['completed', 'failed', 'cancelled'].includes(run.status))
      run.completedAt = new Date().toISOString();
    recordWorkflowEvent(run, 'run', `Run ${run.status}.`);
    hooks.persist(run);
  }
}
