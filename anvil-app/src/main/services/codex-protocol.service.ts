import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  ChatGoalSnapshot,
  ChatAssistantPhase,
  ChatPlanSnapshot,
  ChatPlanStepStatus,
  CodexEvent,
  CodexSubagentActivityKind,
  CodexSubagentState,
  CodexSubagentStatus,
  CodexSubagentTool,
  CodexSubagentToolStatus,
  CodexSubagentUpdate,
  CodexUserInputQuestion,
  ReasoningEffort,
} from '../../shared/types.js';

export type JsonRpcRequestId = string | number;

export interface CodexProtocolState {
  threadId: string | null;
  turnId: string | null;
  initialized: boolean;
  pendingFileChanges?: Map<string, Map<string, PendingFileChange>>;
  assistantPhases?: Map<string, ChatAssistantPhase>;
}

interface PendingFileChange {
  filePath: string;
  diff: string;
}

export interface CodexProtocolCallbacks {
  onThreadReady?: () => void;
  onThreadError?: (message: string) => void;
  onTurnStarted?: () => void;
  onTurnCompleted?: (status: 'completed' | 'interrupted' | 'failed' | 'inProgress') => void;
  onTurnIdChanged?: (turnId: string | null) => void;
  onEvent?: (event: CodexEvent) => void;
  onServerRequestResolved?: (requestId: JsonRpcRequestId) => void;
  onLog?: (message: string) => void;
}

const MAX_RENDERED_DIFF_CHARS = 120_000;
const MAX_RENDERED_COMMAND_OUTPUT_CHARS = 120_000;

/** Find the longest common parent directory of a set of absolute paths. */
export function commonParentDir(paths: string[]): string {
  if (paths.length === 1) return paths[0];
  const parts = paths.map((p) => p.split('/'));
  const common: string[] = [];
  for (let i = 0; i < parts[0].length; i++) {
    const seg = parts[0][i];
    if (parts.every((p) => p[i] === seg)) common.push(seg);
    else break;
  }
  const result = common.join('/');
  return result || '/';
}

export function sendCodexJsonRpc(
  proc: ChildProcess,
  method: string,
  params: Record<string, unknown>,
): void {
  const message = JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
    id: randomUUID(),
  });
  proc.stdin?.write(message + '\n');
}

export function sendCodexJsonRpcNotification(
  proc: ChildProcess,
  method: string,
  params: Record<string, unknown>,
): void {
  proc.stdin?.write(
    JSON.stringify({
      method,
      params,
    }) + '\n',
  );
}

export function handleCodexServerLine(
  state: CodexProtocolState,
  line: string,
  callbacks: CodexProtocolCallbacks,
): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    if (line.length > 0) {
      callbacks.onEvent?.({ type: 'text', text: line });
    }
    return;
  }

  const method = msg.method as string | undefined;
  const requestId = isJsonRpcRequestId(msg.id) ? msg.id : undefined;

  if (!method && requestId !== undefined) {
    if (msg.error) {
      const err = msg.error as { message?: string };
      if (!state.threadId) {
        callbacks.onThreadError?.(err.message ?? 'Codex app-server request failed');
      }
      callbacks.onEvent?.({
        type: 'error',
        errorMessage: err.message ?? 'Unknown error',
      });
      return;
    }

    const result = msg.result as Record<string, unknown> | undefined;
    const thread = result?.thread as Record<string, unknown> | undefined;
    const threadId = (thread?.id ?? result?.threadId) as string | null;
    if (threadId && !state.threadId) {
      state.threadId = threadId;
      callbacks.onThreadReady?.();
    }
    return;
  }

  switch (method) {
    case 'thread/started': {
      const params = msg.params as Record<string, unknown>;
      const thread = params?.thread as Record<string, unknown> | undefined;
      const threadId = (thread?.id ?? params?.threadId) as string | null;
      if (threadId) {
        state.threadId = threadId;
      }
      state.initialized = true;
      callbacks.onLog?.(`thread/started: ${state.threadId ?? 'unknown-thread'}`);
      callbacks.onThreadReady?.();
      break;
    }

    case 'thread/status/changed': {
      const params = msg.params as Record<string, unknown>;
      const status = params?.status as Record<string, unknown> | undefined;
      const rawFlags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
      const threadActiveFlags = rawFlags.filter(
        (flag): flag is 'waitingOnApproval' | 'waitingOnUserInput' =>
          flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
      );
      callbacks.onEvent?.({
        type: 'thread_status',
        protocolThreadId: typeof params?.threadId === 'string' ? params.threadId : undefined,
        threadActiveFlags,
      });
      break;
    }

    case 'turn/started': {
      const params = msg.params as Record<string, unknown>;
      const turn = params?.turn as Record<string, unknown> | undefined;
      state.turnId = (turn?.id ?? params?.turnId) as string | null;
      callbacks.onTurnIdChanged?.(state.turnId);
      callbacks.onEvent?.({ type: 'status', status: 'thinking' });
      callbacks.onTurnStarted?.();
      break;
    }

    case 'turn/completed': {
      const params = msg.params as Record<string, unknown>;
      const turn = params?.turn as Record<string, unknown> | undefined;
      const rawStatus = turn?.status;
      const status =
        rawStatus === 'interrupted' || rawStatus === 'failed' || rawStatus === 'inProgress'
          ? rawStatus
          : 'completed';
      flushAllPendingFileChanges(state, callbacks);
      state.turnId = null;
      callbacks.onTurnIdChanged?.(null);
      if (status === 'failed') {
        const error = turn?.error as Record<string, unknown> | undefined;
        callbacks.onEvent?.({
          type: 'status',
          status: 'error',
          errorMessage:
            typeof error?.message === 'string' ? error.message : 'Codex turn failed to complete.',
        });
      } else {
        callbacks.onEvent?.({ type: 'status', status: 'complete' });
      }
      callbacks.onTurnCompleted?.(status);
      break;
    }

    case 'turn/plan/updated': {
      const params = msg.params as Record<string, unknown>;
      const plan = parsePlanSnapshot(params);
      callbacks.onEvent?.({ type: 'plan_update', plan });
      break;
    }

    case 'thread/goal/updated': {
      const params = msg.params as Record<string, unknown>;
      const goal = parseGoalSnapshot(params?.goal);
      if (goal) callbacks.onEvent?.({ type: 'goal_update', goal });
      break;
    }

    case 'thread/goal/cleared':
      callbacks.onEvent?.({ type: 'goal_cleared' });
      break;

    case 'item/agentMessage/delta': {
      const params = msg.params as Record<string, unknown>;
      const delta = params?.delta as string;
      const itemId = getItemId(params);
      const assistantPhase = parseAssistantPhase(params?.phase) ?? getAssistantPhase(state, itemId);
      if (delta) callbacks.onEvent?.({ type: 'text', text: delta, itemId, assistantPhase });
      break;
    }

    case 'item/started': {
      const params = msg.params as Record<string, unknown>;
      const item = params?.item as Record<string, unknown> | undefined;
      const itemType = (item?.type ?? params?.type) as string;
      if (itemType === 'agentMessage') {
        const itemId = getItemId(params, item);
        const assistantPhase = parseAssistantPhase(item?.phase ?? params?.phase);
        if (itemId && assistantPhase) {
          getAssistantPhaseMap(state).set(itemId, assistantPhase);
        }
      } else if (itemType === 'commandExecution') {
        callbacks.onEvent?.({
          type: 'command_exec',
          command: (item?.command as string) ?? '',
          output: '',
        });
      } else if (itemType === 'fileChange') {
        recordFileChanges(state, buildItemKey(state, params, item), getChanges(item), 'replace');
      } else if (itemType === 'tool_call') {
        callbacks.onEvent?.({
          type: 'tool_call',
          toolName: (params?.toolName as string) ?? (item?.tool as string) ?? '',
          toolInput:
            (params?.input as Record<string, unknown>) ??
            (item?.arguments as Record<string, unknown>) ??
            {},
        });
      } else if (itemType === 'collabAgentToolCall' || itemType === 'subAgentActivity') {
        const subagent = parseSubagentUpdate(item);
        if (subagent) callbacks.onEvent?.({ type: 'subagent_update', subagent });
      }
      break;
    }

    case 'item/completed': {
      const params = msg.params as Record<string, unknown>;
      const item = params?.item as Record<string, unknown> | undefined;
      const itemType = item?.type as string;
      if (itemType === 'commandExecution') {
        callbacks.onEvent?.({
          type: 'command_exec',
          command: (item?.command as string) ?? '',
          output: limitTail(
            (item?.aggregatedOutput as string) ?? '',
            MAX_RENDERED_COMMAND_OUTPUT_CHARS,
          ),
          exitCode: (item?.exitCode as number) ?? undefined,
        });
      } else if (itemType === 'fileChange') {
        const itemKey = buildItemKey(state, params, item);
        emitCompletedFileChanges(state, itemKey, getChanges(item), callbacks);
      } else if (itemType === 'collabAgentToolCall' || itemType === 'subAgentActivity') {
        const subagent = parseSubagentUpdate(item);
        if (subagent) callbacks.onEvent?.({ type: 'subagent_update', subagent });
      }
      break;
    }

    case 'item/fileChange/patchUpdated': {
      const params = msg.params as Record<string, unknown>;
      recordFileChanges(state, buildItemKey(state, params), getChanges(params), 'replace');
      break;
    }

    case 'item/fileChange/requestApproval': {
      const params = msg.params as Record<string, unknown>;
      callbacks.onEvent?.({
        type: 'approval_request',
        approvalRequestId: requestId,
        approvalKind: 'file_change',
        approvalReason: (params?.reason as string) ?? undefined,
        approvalGrantRoot: (params?.grantRoot as string) ?? undefined,
      });
      break;
    }

    case 'item/commandExecution/requestApproval': {
      const params = msg.params as Record<string, unknown>;
      callbacks.onEvent?.({
        type: 'approval_request',
        approvalRequestId: requestId,
        approvalKind: 'command',
        approvalReason: (params?.reason as string) ?? undefined,
        approvalCommand: (params?.command as string) ?? undefined,
        approvalCwd: (params?.cwd as string) ?? undefined,
      });
      break;
    }

    case 'item/permissions/requestApproval': {
      const params = msg.params as Record<string, unknown>;
      callbacks.onEvent?.({
        type: 'approval_request',
        approvalRequestId: requestId,
        approvalKind: 'permissions',
        approvalReason: typeof params?.reason === 'string' ? params.reason : undefined,
        approvalCwd: typeof params?.cwd === 'string' ? params.cwd : undefined,
        approvalPermissions: isRecord(params?.permissions) ? params.permissions : {},
        protocolThreadId: typeof params?.threadId === 'string' ? params.threadId : undefined,
      });
      break;
    }

    case 'item/tool/requestUserInput': {
      const params = msg.params as Record<string, unknown>;
      callbacks.onEvent?.({
        type: 'input_request',
        inputRequestId: requestId,
        protocolThreadId: typeof params?.threadId === 'string' ? params.threadId : undefined,
        inputRequest: {
          kind: 'user_input',
          questions: parseUserInputQuestions(params?.questions),
          autoResolutionMs:
            typeof params?.autoResolutionMs === 'number' ? params.autoResolutionMs : undefined,
        },
      });
      break;
    }

    case 'mcpServer/elicitation/request': {
      const params = msg.params as Record<string, unknown>;
      const mode = parseElicitationMode(params?.mode);
      callbacks.onEvent?.({
        type: 'input_request',
        inputRequestId: requestId,
        protocolThreadId: typeof params?.threadId === 'string' ? params.threadId : undefined,
        inputRequest: {
          kind: 'mcp_elicitation',
          message: typeof params?.message === 'string' ? params.message : undefined,
          serverName: typeof params?.serverName === 'string' ? params.serverName : undefined,
          mode,
          requestedSchema: params?.requestedSchema,
          url: typeof params?.url === 'string' ? params.url : undefined,
        },
      });
      break;
    }

    case 'serverRequest/resolved': {
      const params = msg.params as Record<string, unknown>;
      const resolvedRequestId = params?.requestId;
      if (isJsonRpcRequestId(resolvedRequestId)) {
        callbacks.onEvent?.({ type: 'request_resolved', resolvedRequestId });
        callbacks.onServerRequestResolved?.(resolvedRequestId);
      }
      break;
    }

    case 'item/fileChange/outputDelta': {
      const params = msg.params as Record<string, unknown>;
      const delta = (params?.delta as string) ?? '';
      if (delta) {
        recordFileChanges(
          state,
          buildItemKey(state, params),
          [{ path: (params?.path as string) ?? '', diff: delta }],
          'append',
        );
      }
      break;
    }

    case 'item/commandExecution/outputDelta': {
      const params = msg.params as Record<string, unknown>;
      callbacks.onEvent?.({
        type: 'command_exec',
        command: '',
        output: limitTail((params?.delta as string) ?? '', MAX_RENDERED_COMMAND_OUTPUT_CHARS),
      });
      break;
    }

    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta': {
      const params = msg.params as Record<string, unknown>;
      const delta = params?.delta as string;
      if (delta) callbacks.onEvent?.({ type: 'thinking', text: delta });
      break;
    }

    case 'error': {
      const params = msg.params as Record<string, unknown>;
      callbacks.onEvent?.({
        type: 'error',
        errorMessage: (params?.message as string) ?? 'Unknown error',
      });
      break;
    }

    case 'codex/event/agent_message_content_delta': {
      const params = msg.params as Record<string, unknown>;
      const delta = params?.delta as string;
      const itemId = getItemId(params);
      const assistantPhase = parseAssistantPhase(params?.phase) ?? getAssistantPhase(state, itemId);
      if (delta) callbacks.onEvent?.({ type: 'text', text: delta, itemId, assistantPhase });
      break;
    }

    case 'codex/event/exec_command_output_delta': {
      const params = msg.params as Record<string, unknown>;
      const delta = params?.delta as string;
      if (delta) {
        callbacks.onEvent?.({
          type: 'command_exec',
          command: '',
          output: limitTail(delta, MAX_RENDERED_COMMAND_OUTPUT_CHARS),
        });
      }
      break;
    }

    default:
      callbacks.onLog?.(method ?? 'unknown');
      break;
  }
}

function getItemId(
  params: Record<string, unknown>,
  item?: Record<string, unknown>,
): string | undefined {
  const rawId = params.itemId ?? params.item_id ?? item?.id;
  return typeof rawId === 'string' && rawId.length > 0 ? rawId : undefined;
}

function parseSubagentUpdate(
  item: Record<string, unknown> | undefined,
): CodexSubagentUpdate | null {
  if (!item || typeof item.id !== 'string') return null;

  if (item.type === 'subAgentActivity') {
    const activityKind = parseSubagentActivityKind(item.kind);
    const agentThreadId = typeof item.agentThreadId === 'string' ? item.agentThreadId : undefined;
    if (!activityKind || !agentThreadId) return null;
    const status: CodexSubagentStatus = activityKind === 'interrupted' ? 'interrupted' : 'running';
    return {
      id: item.id,
      kind: 'activity',
      receiverThreadIds: [agentThreadId],
      agents: [{ threadId: agentThreadId, status }],
      activityKind,
      agentThreadId,
      agentPath: typeof item.agentPath === 'string' ? item.agentPath : undefined,
    };
  }

  if (item.type !== 'collabAgentToolCall') return null;
  const tool = parseSubagentTool(item.tool);
  const status = parseSubagentToolStatus(item.status);
  if (!tool || !status) return null;

  const receiverThreadIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((threadId): threadId is string => typeof threadId === 'string')
    : [];
  const rawAgentStates = isRecord(item.agentsStates) ? item.agentsStates : {};
  const agents: CodexSubagentState[] = Object.entries(rawAgentStates).flatMap(
    ([threadId, value]) => {
      if (!isRecord(value)) return [];
      const agentStatus = parseSubagentStatus(value.status);
      if (!agentStatus) return [];
      return [
        {
          threadId,
          status: agentStatus,
          message: typeof value.message === 'string' ? value.message : undefined,
        },
      ];
    },
  );

  return {
    id: item.id,
    kind: 'tool_call',
    tool,
    status,
    senderThreadId: typeof item.senderThreadId === 'string' ? item.senderThreadId : undefined,
    receiverThreadIds,
    prompt: typeof item.prompt === 'string' ? item.prompt : undefined,
    model: typeof item.model === 'string' ? item.model : undefined,
    reasoningEffort: parseReasoningEffort(item.reasoningEffort),
    agents,
  };
}

function parseSubagentTool(value: unknown): CodexSubagentTool | undefined {
  switch (value) {
    case 'spawnAgent':
    case 'sendInput':
    case 'resumeAgent':
    case 'wait':
    case 'closeAgent':
      return value;
    default:
      return undefined;
  }
}

function parseSubagentToolStatus(value: unknown): CodexSubagentToolStatus | undefined {
  switch (value) {
    case 'inProgress':
    case 'completed':
    case 'failed':
      return value;
    default:
      return undefined;
  }
}

function parseSubagentStatus(value: unknown): CodexSubagentStatus | undefined {
  switch (value) {
    case 'pendingInit':
    case 'running':
    case 'interrupted':
    case 'completed':
    case 'errored':
    case 'shutdown':
    case 'notFound':
      return value;
    default:
      return undefined;
  }
}

function parseSubagentActivityKind(value: unknown): CodexSubagentActivityKind | undefined {
  switch (value) {
    case 'started':
    case 'interacted':
    case 'interrupted':
      return value;
    default:
      return undefined;
  }
}

function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  switch (value) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
    case 'ultra':
      return value;
    default:
      return undefined;
  }
}

function parseUserInputQuestions(value: unknown): CodexUserInputQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.header !== 'string' ||
      typeof candidate.question !== 'string'
    ) {
      return [];
    }
    const options = Array.isArray(candidate.options)
      ? candidate.options.flatMap((option) => {
          if (!isRecord(option) || typeof option.label !== 'string') return [];
          return [
            {
              label: option.label,
              description: typeof option.description === 'string' ? option.description : '',
            },
          ];
        })
      : undefined;
    return [
      {
        id: candidate.id,
        header: candidate.header,
        question: candidate.question,
        isOther: candidate.isOther === true,
        isSecret: candidate.isSecret === true,
        options,
      },
    ];
  });
}

function parseElicitationMode(value: unknown): 'form' | 'openai/form' | 'url' | undefined {
  return value === 'form' || value === 'openai/form' || value === 'url' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAssistantPhase(value: unknown): ChatAssistantPhase | undefined {
  if (value === 'commentary' || value === 'progress') return 'progress';
  if (value === 'final_answer' || value === 'finalAnswer' || value === 'final') return 'final';
  return undefined;
}

function getAssistantPhaseMap(state: CodexProtocolState): Map<string, ChatAssistantPhase> {
  if (!state.assistantPhases) state.assistantPhases = new Map();
  return state.assistantPhases;
}

function getAssistantPhase(
  state: CodexProtocolState,
  itemId: string | undefined,
): ChatAssistantPhase | undefined {
  return itemId ? state.assistantPhases?.get(itemId) : undefined;
}

function isJsonRpcRequestId(value: unknown): value is JsonRpcRequestId {
  return typeof value === 'string' || typeof value === 'number';
}

function getChanges(source?: Record<string, unknown>): Array<Record<string, unknown>> {
  const changes = source?.changes;
  return Array.isArray(changes)
    ? changes.filter(
        (change): change is Record<string, unknown> => !!change && typeof change === 'object',
      )
    : [];
}

function buildItemKey(
  state: CodexProtocolState,
  params: Record<string, unknown>,
  item?: Record<string, unknown>,
): string {
  const rawId = params.itemId ?? params.item_id ?? params.id ?? item?.id;
  return typeof rawId === 'string' && rawId.length > 0
    ? rawId
    : `${state.turnId ?? 'turn'}:file-change`;
}

function recordFileChanges(
  state: CodexProtocolState,
  itemKey: string,
  changes: Array<Record<string, unknown>>,
  mode: 'append' | 'replace',
): void {
  if (changes.length === 0) return;

  const pendingByItem = getPendingFileChangeMap(state);
  let pendingByFile = pendingByItem.get(itemKey);
  if (!pendingByFile) {
    pendingByFile = new Map<string, PendingFileChange>();
    pendingByItem.set(itemKey, pendingByFile);
  }

  for (const change of changes) {
    const filePath = getChangeFilePath(change);
    const diff = getChangeDiff(change);
    if (!filePath && !diff) continue;

    const key = filePath || '(unknown file)';
    const existing = pendingByFile.get(key);
    pendingByFile.set(key, {
      filePath: key,
      diff: limitMiddle(
        mode === 'append' && existing ? existing.diff + diff : diff,
        MAX_RENDERED_DIFF_CHARS,
      ),
    });
  }
}

function emitCompletedFileChanges(
  state: CodexProtocolState,
  itemKey: string,
  changes: Array<Record<string, unknown>>,
  callbacks: CodexProtocolCallbacks,
): void {
  const pendingByFile = state.pendingFileChanges?.get(itemKey);
  const emittedKeys = new Set<string>();

  for (const change of changes) {
    const filePath = getChangeFilePath(change);
    const diff = getChangeDiff(change);
    const key = filePath || '(unknown file)';
    const pending = pendingByFile?.get(key);
    const resolvedDiff = diff || pending?.diff || '';
    const resolvedFilePath = filePath || pending?.filePath || key;

    if (!resolvedFilePath && !resolvedDiff) continue;

    callbacks.onEvent?.({
      type: 'file_edit',
      filePath: resolvedFilePath,
      diff: limitMiddle(resolvedDiff, MAX_RENDERED_DIFF_CHARS),
    });
    emittedKeys.add(key);
  }

  for (const [key, change] of pendingByFile ?? []) {
    if (emittedKeys.has(key)) continue;
    callbacks.onEvent?.({
      type: 'file_edit',
      filePath: change.filePath,
      diff: change.diff,
    });
  }

  clearPendingFileChanges(state, itemKey);
}

function flushPendingFileChanges(
  state: CodexProtocolState,
  itemKey: string,
  callbacks: CodexProtocolCallbacks,
): void {
  const pendingByFile = state.pendingFileChanges?.get(itemKey);
  if (!pendingByFile) return;

  for (const change of pendingByFile.values()) {
    callbacks.onEvent?.({
      type: 'file_edit',
      filePath: change.filePath,
      diff: change.diff,
    });
  }
  clearPendingFileChanges(state, itemKey);
}

function flushAllPendingFileChanges(
  state: CodexProtocolState,
  callbacks: CodexProtocolCallbacks,
): void {
  const keys = [...(state.pendingFileChanges?.keys() ?? [])];
  for (const key of keys) {
    flushPendingFileChanges(state, key, callbacks);
  }
}

function clearPendingFileChanges(state: CodexProtocolState, itemKey: string): void {
  state.pendingFileChanges?.delete(itemKey);
}

function getPendingFileChangeMap(
  state: CodexProtocolState,
): Map<string, Map<string, PendingFileChange>> {
  if (!state.pendingFileChanges) {
    state.pendingFileChanges = new Map<string, Map<string, PendingFileChange>>();
  }
  return state.pendingFileChanges;
}

function getChangeFilePath(change: Record<string, unknown>): string {
  const filePath = change.filePath ?? change.path;
  return typeof filePath === 'string' ? filePath : '';
}

function getChangeDiff(change: Record<string, unknown>): string {
  const diff = change.unifiedDiff ?? change.diff ?? change.delta;
  return typeof diff === 'string' ? diff : '';
}

function parsePlanSnapshot(params: Record<string, unknown>): ChatPlanSnapshot {
  const steps = Array.isArray(params.plan)
    ? params.plan
        .map((step): ChatPlanSnapshot['steps'][number] | null => {
          if (!step || typeof step !== 'object') return null;
          const candidate = step as Record<string, unknown>;
          const stepText = candidate.step;
          if (typeof stepText !== 'string' || !stepText.trim()) return null;
          return {
            step: stepText,
            status: normalisePlanStepStatus(candidate.status),
          };
        })
        .filter((step): step is ChatPlanSnapshot['steps'][number] => Boolean(step))
    : [];

  return {
    explanation: typeof params.explanation === 'string' ? params.explanation : undefined,
    steps,
    updatedAt: new Date().toISOString(),
  };
}

function normalisePlanStepStatus(status: unknown): ChatPlanStepStatus {
  switch (status) {
    case 'inProgress':
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'pending':
    default:
      return 'pending';
  }
}

function parseGoalSnapshot(value: unknown): ChatGoalSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const goal = value as Record<string, unknown>;
  const objective = goal.objective;
  if (typeof objective !== 'string' || !objective.trim()) return null;

  return {
    objective,
    status: normaliseGoalStatus(goal.status),
    tokenBudget: typeof goal.tokenBudget === 'number' ? goal.tokenBudget : null,
    tokensUsed: typeof goal.tokensUsed === 'number' ? goal.tokensUsed : 0,
    timeUsedSeconds: typeof goal.timeUsedSeconds === 'number' ? goal.timeUsedSeconds : 0,
    createdAt: typeof goal.createdAt === 'number' ? goal.createdAt : Date.now(),
    updatedAt: typeof goal.updatedAt === 'number' ? goal.updatedAt : Date.now(),
  };
}

function normaliseGoalStatus(status: unknown): ChatGoalSnapshot['status'] {
  switch (status) {
    case 'paused':
    case 'budgetLimited':
    case 'complete':
      return status;
    case 'completed':
      return 'complete';
    case 'active':
    default:
      return 'active';
  }
}

function limitMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const marker = `\n... truncated ${text.length - maxChars} chars ...\n`;
  const available = Math.max(maxChars - marker.length, 0);
  const headLength = Math.ceil(available * 0.65);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength)}${marker}${tailLength > 0 ? text.slice(-tailLength) : ''}`;
}

function limitTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const marker = `\n... truncated ${text.length - maxChars} chars ...\n`;
  const available = Math.max(maxChars - marker.length, 0);
  return `${marker}${text.slice(-available)}`;
}
