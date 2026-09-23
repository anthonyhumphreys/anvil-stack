import type { DojoTokenUsage } from '../../shared/dojo-types.js';
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
  CursorQuestion,
  ReasoningEffort,
} from '../../shared/types.js';

export type JsonRpcRequestId = string | number;

export interface CodexProtocolState {
  threadId: string | null;
  turnId: string | null;
  initialized: boolean;
  tokenUsageTotal?: DojoTokenUsage;
  acpCostUsd?: number;
  pendingFileChanges?: Map<string, Map<string, PendingFileChange>>;
  assistantPhases?: Map<string, ChatAssistantPhase>;
  /** Per-toolCallId tracking for ACP tool_call/tool_call_update lifecycles. */
  acpToolCalls?: Map<string, AcpToolCallState>;
  /** Display name for the connected agent (e.g. 'Cursor', 'Devin'). */
  agentLabel?: string;
}

interface PendingFileChange {
  filePath: string;
  diff: string;
}

interface AcpToolCallState {
  kind?: string;
  command?: string;
  lastExecSignature?: string;
  /** path → last emitted diff body, so repeated content snapshots don't re-emit. */
  emittedDiffs: Map<string, string>;
}

/**
 * Single emission point for provider-facing events. Stamps the connected
 * agent's display label (set on `CodexProtocolState.agentLabel` by the
 * session layer for ACP providers) so shared UI copy can name the agent.
 */
function emitEvent(
  state: CodexProtocolState,
  callbacks: CodexProtocolCallbacks,
  event: CodexEvent,
): void {
  const stamped: CodexEvent =
    state.agentLabel && event.agentLabel === undefined
      ? { ...event, agentLabel: state.agentLabel }
      : event;
  callbacks.onEvent?.(stamped);
}

export interface CodexProtocolCallbacks {
  onThreadReady?: () => void;
  onThreadError?: (message: string) => void;
  onTurnStarted?: () => void;
  onTurnCompleted?: (status: 'completed' | 'interrupted' | 'failed' | 'inProgress') => void;
  onTurnIdChanged?: (turnId: string | null) => void;
  onEvent?: (event: CodexEvent) => void;
  onServerRequestResolved?: (requestId: JsonRpcRequestId) => void;
  /**
   * Called for JSON-RPC error responses. Return true to mark the error as
   * handled (e.g. a provider auth retry) and suppress the default
   * thread-error/event propagation.
   */
  onRequestError?: (error: {
    requestId: JsonRpcRequestId;
    code?: number;
    message: string;
  }) => boolean | void;
  onLog?: (message: string) => void;
}

const MAX_RENDERED_DIFF_CHARS = 120_000;
const MAX_RENDERED_COMMAND_OUTPUT_CHARS = 120_000;
const guardedJsonRpcStdin = new WeakSet<object>();
const CLOSED_PIPE_ERROR_CODES = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]);

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
): boolean {
  return writeCodexJsonRpcLine(proc, {
    jsonrpc: '2.0',
    method,
    params,
    id: randomUUID(),
  });
}

export function sendCodexJsonRpcNotification(
  proc: ChildProcess,
  method: string,
  params: Record<string, unknown>,
): boolean {
  return writeCodexJsonRpcLine(proc, { method, params });
}

export function sendCodexJsonRpcResult(
  proc: ChildProcess,
  requestId: JsonRpcRequestId,
  result: Record<string, unknown>,
): boolean {
  return writeCodexJsonRpcLine(proc, {
    jsonrpc: '2.0',
    id: requestId,
    result,
  });
}

function writeCodexJsonRpcLine(proc: ChildProcess, payload: Record<string, unknown>): boolean {
  const stdin = proc.stdin;
  if (!stdin) return false;

  guardJsonRpcStdin(stdin);
  if (!stdin.writable || stdin.destroyed || stdin.writableEnded) return false;

  try {
    stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  } catch (error) {
    handleJsonRpcStdinError(error);
    return false;
  }
}

function guardJsonRpcStdin(stdin: NonNullable<ChildProcess['stdin']>): void {
  if (guardedJsonRpcStdin.has(stdin)) return;
  guardedJsonRpcStdin.add(stdin);
  stdin.on('error', handleJsonRpcStdinError);
}

function handleJsonRpcStdinError(error: unknown): void {
  if (isClosedPipeError(error)) return;
  console.error('[Codex] JSON-RPC stdin error:', error);
}

function isClosedPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return CLOSED_PIPE_ERROR_CODES.has(String(error.code));
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
      emitEvent(state, callbacks, { type: 'text', text: line });
    }
    return;
  }

  const method = msg.method as string | undefined;
  const requestId = isJsonRpcRequestId(msg.id) ? msg.id : undefined;

  if (!method && requestId !== undefined) {
    if (msg.error) {
      const err = msg.error as { message?: string; code?: number };
      const handled =
        callbacks.onRequestError?.({
          requestId,
          code: typeof err.code === 'number' ? err.code : undefined,
          message: err.message ?? '',
        }) === true;
      if (handled) return;
      if (!state.threadId) {
        callbacks.onThreadError?.(err.message ?? 'Agent request failed');
      }
      emitEvent(state, callbacks, {
        type: 'error',
        errorMessage: err.message ?? 'Unknown error',
      });
      return;
    }

    const result = msg.result as Record<string, unknown> | undefined;
    const thread = result?.thread as Record<string, unknown> | undefined;
    const threadId = (thread?.id ?? result?.threadId ?? result?.sessionId) as string | null;
    if (threadId && !state.threadId) {
      state.threadId = threadId;
      state.initialized = true;
      callbacks.onThreadReady?.();
    }
    if (typeof result?.stopReason === 'string' && result.stopReason) {
      const stopReason = result.stopReason;
      const outcome =
        stopReason === 'cancelled'
          ? 'interrupted'
          : stopReason === 'end_turn'
            ? 'completed'
            : 'failed';
      emitEvent(state, callbacks, { type: 'turn_outcome', turnOutcome: outcome });
      if (outcome === 'failed') {
        emitEvent(state, callbacks, {
          type: 'status',
          status: 'error',
          errorMessage: `${acpAgentLabel(state)} ended the turn early (${stopReason}).`,
        });
      } else {
        emitEvent(state, callbacks, { type: 'status', status: 'complete' });
      }
      callbacks.onTurnCompleted?.(outcome);
    }
    return;
  }

  switch (method) {
    case 'session/update': {
      const params = msg.params as Record<string, unknown>;
      const update = params?.update as Record<string, unknown> | undefined;
      const kind = update?.sessionUpdate;
      if (kind === 'usage_update') {
        const cost = isRecord(update?.cost) ? update.cost : null;
        const amount =
          cost?.currency === 'USD' &&
          typeof cost.amount === 'number' &&
          Number.isFinite(cost.amount) &&
          cost.amount >= 0
            ? cost.amount
            : undefined;
        const observedCostUsd =
          amount !== undefined && state.acpCostUsd !== undefined && amount >= state.acpCostUsd
            ? amount - state.acpCostUsd
            : undefined;
        if (amount !== undefined) state.acpCostUsd = amount;
        const used = update?.used;
        const size = update?.size;
        if (
          typeof used === 'number' &&
          Number.isSafeInteger(used) &&
          used >= 0 &&
          typeof size === 'number' &&
          Number.isSafeInteger(size) &&
          size > 0
        ) {
          emitEvent(state, callbacks, {
            type: 'usage_context',
            contextUsage: { used, size },
            observedCostUsd,
          });
        }
      } else if (kind === 'agent_message_chunk') {
        const text = extractAcpText(update?.content);
        if (text) emitEvent(state, callbacks, { type: 'text', text });
      } else if (kind === 'agent_thought_chunk') {
        const text = extractAcpText(update?.content);
        if (text) emitEvent(state, callbacks, { type: 'thinking', text });
      } else if (kind === 'plan') {
        const entries = Array.isArray(update?.entries) ? update.entries : [];
        emitEvent(state, callbacks, {
          type: 'plan_update',
          plan: {
            steps: entries.flatMap((entry, index) => {
              if (!isRecord(entry) || typeof entry.content !== 'string') return [];
              return [
                {
                  id: `acp-plan-${index}`,
                  step: entry.content,
                  status: parseAcpPlanStatus(entry.status),
                },
              ];
            }),
            updatedAt: new Date().toISOString(),
          },
        });
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        emitAcpToolCallUpdate(state, update, kind, callbacks);
      } else if (
        kind === 'config_option_update' ||
        kind === 'current_mode_update' ||
        kind === 'available_commands_update' ||
        kind === 'user_message_chunk' ||
        kind === 'session_info_update'
      ) {
        // Lifecycle/catalog notifications — nothing to render.
      }
      break;
    }

    case 'session/request_permission': {
      const params = msg.params as Record<string, unknown>;
      const toolCall = params?.toolCall as Record<string, unknown> | undefined;
      const metadata = isRecord(params?._meta) ? params._meta : undefined;
      const permissionMeta = isRecord(metadata?.permission) ? metadata.permission : undefined;
      const rawInput = isRecord(toolCall?.rawInput) ? toolCall.rawInput : undefined;
      const toolKind = typeof toolCall?.kind === 'string' ? toolCall.kind : undefined;
      // Keep approvalKind 'permissions': buildApprovalResponse only produces the
      // ACP `outcome.selected` reply for that kind — reclassifying it as
      // 'command' would send the Codex-style `{decision}` response instead.
      // Command/cwd detail rides along as approvalCommand/approvalCwd.
      emitEvent(state, callbacks, {
        type: 'approval_request',
        approvalRequestId: requestId,
        approvalKind: 'permissions',
        approvalReason:
          isRecord(permissionMeta) && typeof permissionMeta.description === 'string'
            ? permissionMeta.description
            : undefined,
        approvalCommand: extractAcpCommand(rawInput, toolCall?.title, toolKind),
        approvalCwd: typeof rawInput?.cwd === 'string' ? rawInput.cwd : undefined,
        toolName:
          typeof toolCall?.title === 'string'
            ? toolCall.title
            : (acpToolKindLabel(toolCall?.kind) ?? `${acpAgentLabel(state)} tool`),
        toolInput: rawInput,
        approvalPermissions: { options: Array.isArray(params?.options) ? params.options : [] },
        protocolThreadId: typeof params?.sessionId === 'string' ? params.sessionId : undefined,
      });
      break;
    }

    case 'cursor/ask_question': {
      const params = msg.params as Record<string, unknown>;
      const questions = parseCursorQuestions(params?.questions);
      emitEvent(state, callbacks, {
        type: 'input_request',
        inputRequestId: requestId,
        inputRequest: {
          kind: 'cursor_ask_question',
          title: typeof params?.title === 'string' ? params.title : undefined,
          questions,
        },
      });
      break;
    }

    case 'cursor/create_plan': {
      const params = msg.params as Record<string, unknown>;
      if (typeof params?.plan !== 'string') break;
      emitEvent(state, callbacks, {
        type: 'input_request',
        inputRequestId: requestId,
        inputRequest: {
          kind: 'cursor_create_plan',
          title: typeof params.title === 'string' ? params.title : undefined,
          plan: params.plan,
        },
      });
      break;
    }

    case 'elicitation/create': {
      const params = msg.params as Record<string, unknown>;
      emitEvent(state, callbacks, {
        type: 'input_request',
        inputRequestId: requestId,
        protocolThreadId: typeof params?.sessionId === 'string' ? params.sessionId : undefined,
        inputRequest: {
          kind: 'mcp_elicitation',
          serverName: acpAgentLabel(state),
          message: typeof params?.message === 'string' ? params.message : undefined,
          mode: params?.mode === 'form' || params?.mode === 'url' ? params.mode : undefined,
          requestedSchema: params?.requestedSchema,
          url: typeof params?.url === 'string' ? params.url : undefined,
        },
      });
      break;
    }

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
      emitEvent(state, callbacks, {
        type: 'thread_status',
        protocolThreadId: typeof params?.threadId === 'string' ? params.threadId : undefined,
        threadActiveFlags,
      });
      break;
    }

    case 'thread/tokenUsage/updated': {
      const params = msg.params as Record<string, unknown>;
      if (params?.threadId !== state.threadId) break;
      const tokenUsage = params?.tokenUsage as Record<string, unknown> | undefined;
      const total = readProtocolUsage(tokenUsage?.total);
      const last = readProtocolUsage(tokenUsage?.last);
      if (!total) break;
      const previous = state.tokenUsageTotal;
      state.tokenUsageTotal = total;
      // Restored thread totals establish a baseline; they are never new consumption.
      if (!state.turnId || params?.turnId !== state.turnId) break;
      const delta = previous
        ? {
            input: total.input - previous.input,
            cachedInput: total.cachedInput - previous.cachedInput,
            output: total.output - previous.output,
          }
        : last;
      if (!delta || !isValidUsage(delta) || delta.input + delta.output === 0) break;
      emitEvent(state, callbacks, {
        type: 'usage',
        usage: delta,
        usageId: `${state.threadId}:${state.turnId}:${total.input}:${total.cachedInput}:${total.output}`,
        protocolTurnId: state.turnId,
      });
      break;
    }

    case 'thread/compacted':
      emitEvent(state, callbacks, { type: 'context_compaction' });
      break;

    case 'turn/started': {
      const params = msg.params as Record<string, unknown>;
      const turn = params?.turn as Record<string, unknown> | undefined;
      state.turnId = (turn?.id ?? params?.turnId) as string | null;
      callbacks.onTurnIdChanged?.(state.turnId);
      emitEvent(state, callbacks, { type: 'status', status: 'thinking' });
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
      emitEvent(state, callbacks, {
        type: 'turn_outcome',
        turnOutcome: status,
        protocolTurnId: state.turnId ?? undefined,
      });
      state.turnId = null;
      callbacks.onTurnIdChanged?.(null);
      if (status === 'failed') {
        const error = turn?.error as Record<string, unknown> | undefined;
        emitEvent(state, callbacks, {
          type: 'status',
          status: 'error',
          errorMessage:
            typeof error?.message === 'string' ? error.message : 'Codex turn failed to complete.',
        });
      } else {
        emitEvent(state, callbacks, { type: 'status', status: 'complete' });
      }
      callbacks.onTurnCompleted?.(status);
      break;
    }

    case 'turn/plan/updated': {
      const params = msg.params as Record<string, unknown>;
      const plan = parsePlanSnapshot(params);
      emitEvent(state, callbacks, { type: 'plan_update', plan });
      break;
    }

    case 'thread/goal/updated': {
      const params = msg.params as Record<string, unknown>;
      const goal = parseGoalSnapshot(params?.goal);
      if (goal) emitEvent(state, callbacks, { type: 'goal_update', goal });
      break;
    }

    case 'thread/goal/cleared':
      emitEvent(state, callbacks, { type: 'goal_cleared' });
      break;

    case 'item/agentMessage/delta': {
      const params = msg.params as Record<string, unknown>;
      const delta = params?.delta as string;
      const itemId = getItemId(params);
      const assistantPhase = parseAssistantPhase(params?.phase) ?? getAssistantPhase(state, itemId);
      if (delta) emitEvent(state, callbacks, { type: 'text', text: delta, itemId, assistantPhase });
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
        emitEvent(state, callbacks, {
          type: 'command_exec',
          itemId: getItemId(params, item),
          command: (item?.command as string) ?? '',
          output: '',
        });
      } else if (itemType === 'fileChange') {
        recordFileChanges(state, buildItemKey(state, params, item), getChanges(item), 'replace');
      } else if (itemType === 'tool_call') {
        emitEvent(state, callbacks, {
          type: 'tool_call',
          toolName: (params?.toolName as string) ?? (item?.tool as string) ?? '',
          toolInput:
            (params?.input as Record<string, unknown>) ??
            (item?.arguments as Record<string, unknown>) ??
            {},
        });
      } else if (itemType === 'collabAgentToolCall' || itemType === 'subAgentActivity') {
        const subagent = parseSubagentUpdate(item);
        if (subagent) emitEvent(state, callbacks, { type: 'subagent_update', subagent });
      }
      break;
    }

    case 'item/completed': {
      const params = msg.params as Record<string, unknown>;
      const item = params?.item as Record<string, unknown> | undefined;
      const itemType = item?.type as string;
      if (itemType === 'commandExecution') {
        emitEvent(state, callbacks, {
          type: 'command_exec',
          itemId: getItemId(params, item),
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
        if (subagent) emitEvent(state, callbacks, { type: 'subagent_update', subagent });
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
      emitEvent(state, callbacks, {
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
      emitEvent(state, callbacks, {
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
      emitEvent(state, callbacks, {
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
      emitEvent(state, callbacks, {
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
      emitEvent(state, callbacks, {
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
        emitEvent(state, callbacks, { type: 'request_resolved', resolvedRequestId });
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
      emitEvent(state, callbacks, {
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
      if (delta) emitEvent(state, callbacks, { type: 'thinking', text: delta });
      break;
    }

    case 'error': {
      const params = msg.params as Record<string, unknown>;
      emitEvent(state, callbacks, {
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
      if (delta) emitEvent(state, callbacks, { type: 'text', text: delta, itemId, assistantPhase });
      break;
    }

    case 'codex/event/exec_command_output_delta': {
      const params = msg.params as Record<string, unknown>;
      const delta = params?.delta as string;
      if (delta) {
        emitEvent(state, callbacks, {
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

function extractAcpText(content: unknown): string {
  if (typeof content === 'string') return content;
  // A single ContentBlock, e.g. tool_call content[].content.
  if (isRecord(content) && content.type === 'text' && typeof content.text === 'string') {
    return content.text;
  }
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!isRecord(item)) return '';
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      return '';
    })
    .join('');
}

function acpAgentLabel(state: CodexProtocolState): string {
  return state.agentLabel ?? 'Agent';
}

function acpToolKindLabel(kind: unknown): string | undefined {
  if (typeof kind !== 'string') return undefined;
  switch (kind) {
    case 'read':
      return 'Read';
    case 'edit':
      return 'Edit';
    case 'delete':
      return 'Delete';
    case 'move':
      return 'Move';
    case 'execute':
      return 'Command';
    case 'fetch':
      return 'Fetch';
    case 'search':
      return 'Search';
    case 'think':
      return 'Think';
    case 'switch_mode':
      return 'Switch mode';
    case 'other':
      return undefined;
    default:
      return kind;
  }
}

/**
 * Flatten ACP tool-call `content` blocks, touched `locations`, and rawOutput
 * into a single display string so tool updates can show what the tool did.
 */
function extractAcpToolOutput(update: Record<string, unknown> | undefined): string | undefined {
  if (!update) return undefined;
  const parts: string[] = [];
  const seen = new Set<string>();

  const push = (text: string) => {
    const trimmed = text.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      parts.push(trimmed);
    }
  };

  const content = update.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === 'content') {
        push(extractAcpText(item.content));
      } else if (item.type === 'diff' && typeof item.path === 'string') {
        push(`Edited ${item.path}`);
      }
    }
  }

  const locations = update.locations;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      if (isRecord(location) && typeof location.path === 'string') {
        push(`Touched ${location.path}`);
      }
    }
  }

  if (typeof update.rawOutput === 'string') {
    push(update.rawOutput);
  }

  if (parts.length === 0) return undefined;
  return limitTail(parts.join('\n'), MAX_RENDERED_COMMAND_OUTPUT_CHARS);
}

/**
 * Normalise one ACP `tool_call`/`tool_call_update` session update into the
 * shared event contract:
 * - `kind: 'execute'` becomes `command_exec` (command, output, exit code)
 *   instead of a generic tool row, matching Codex `commandExecution` items.
 * - `content` blocks of `type: 'diff'` become real `file_edit` events so
 *   DiffViewer, "Review changes" and Agent Runs counts work for ACP agents.
 * - Everything else stays a `tool_call` event, merged downstream by itemId.
 */
function emitAcpToolCallUpdate(
  state: CodexProtocolState,
  update: Record<string, unknown> | undefined,
  updateKind: unknown,
  callbacks: CodexProtocolCallbacks,
): void {
  const toolCallId = typeof update?.toolCallId === 'string' ? update.toolCallId : undefined;
  const tracked = getAcpToolCallTracking(state, toolCallId);
  const kind =
    typeof update?.kind === 'string' ? update.kind : tracked?.kind;
  if (tracked && typeof update?.kind === 'string') tracked.kind = update.kind;

  const rawInput = isRecord(update?.rawInput) ? update.rawInput : undefined;
  const command = extractAcpCommand(rawInput, update?.title, kind);
  if (tracked && command) tracked.command = command;

  if (kind === 'execute') {
    const resolvedCommand = command ?? tracked?.command;
    const { output, exitCode } = extractAcpCommandResult(update);
    const toolStatus = acpToolStatus(update?.status);
    const signature = JSON.stringify([
      resolvedCommand ?? '',
      output ?? '',
      exitCode ?? null,
      toolStatus,
    ]);
    if (!tracked || tracked.lastExecSignature !== signature) {
      if (tracked) tracked.lastExecSignature = signature;
      emitEvent(state, callbacks, {
        type: 'command_exec',
        itemId: toolCallId,
        command: resolvedCommand ?? '',
        output: output ?? '',
        exitCode,
        toolStatus,
      });
    }
  } else {
    emitEvent(state, callbacks, {
      type: 'tool_call',
      itemId: toolCallId,
      toolStatus: acpToolStatus(update?.status),
      // Only the initial tool_call gets a generic fallback — updates must
      // leave toolName undefined so the renderer keeps the first title.
      toolName:
        (update?.title as string) ??
        acpToolKindLabel(update?.kind) ??
        (updateKind === 'tool_call' ? `${acpAgentLabel(state)} tool` : undefined),
      toolInput: rawInput ?? {},
      toolOutput: extractAcpToolOutput(update),
    });
  }

  for (const diff of extractAcpDiffBlocks(update)) {
    if (tracked) {
      if (tracked.emittedDiffs.get(diff.path) === diff.diff) continue;
      tracked.emittedDiffs.set(diff.path, diff.diff);
    }
    emitEvent(state, callbacks, {
      type: 'file_edit',
      itemId: toolCallId,
      filePath: diff.path,
      diff: diff.diff,
    });
  }
}

function getAcpToolCallTracking(
  state: CodexProtocolState,
  toolCallId: string | undefined,
): AcpToolCallState | null {
  if (!toolCallId) return null;
  if (!state.acpToolCalls) state.acpToolCalls = new Map<string, AcpToolCallState>();
  let tracked = state.acpToolCalls.get(toolCallId);
  if (!tracked) {
    tracked = { emittedDiffs: new Map<string, string>() };
    state.acpToolCalls.set(toolCallId, tracked);
  }
  return tracked;
}

function acpToolStatus(status: unknown): 'running' | 'completed' | 'failed' {
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  return 'running';
}

/**
 * Pull the shell command out of an ACP tool call's rawInput. Cursor titles
 * execute calls as the command wrapped in backticks, so a backticked title
 * is the fallback when rawInput doesn't carry it.
 */
function extractAcpCommand(
  rawInput: Record<string, unknown> | undefined,
  title: unknown,
  kind: string | undefined,
): string | undefined {
  const candidate = rawInput?.command ?? rawInput?.cmd ?? rawInput?.shell_command;
  if (typeof candidate === 'string' && candidate.trim()) return candidate;
  if (Array.isArray(candidate) && candidate.every((part) => typeof part === 'string')) {
    const joined = candidate.join(' ').trim();
    if (joined) return joined;
  }
  if (kind === 'execute' && typeof title === 'string') {
    const trimmed = title.trim();
    if (trimmed.length > 2 && trimmed.startsWith('`') && trimmed.endsWith('`')) {
      return trimmed.slice(1, -1);
    }
  }
  return undefined;
}

/**
 * Output and exit status for an ACP `execute` tool call. Content blocks of
 * `type: 'content'` carry rendered terminal text; structured `rawOutput`
 * may carry output/exit code fields. Nothing is fabricated — when the agent
 * doesn't report an exit code, `exitCode` stays undefined.
 */
function extractAcpCommandResult(update: Record<string, unknown> | undefined): {
  output?: string;
  exitCode?: number;
} {
  if (!update) return {};
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (text: string) => {
    const trimmed = text.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      parts.push(trimmed);
    }
  };

  const content = update.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (isRecord(item) && item.type === 'content') {
        push(extractAcpText(item.content));
      }
    }
  }

  let exitCode: number | undefined;
  const rawOutput = update.rawOutput;
  if (typeof rawOutput === 'string') {
    push(rawOutput);
  } else if (isRecord(rawOutput)) {
    for (const key of ['output', 'formattedOutput', 'formatted_output', 'stdout', 'stderr']) {
      const value = rawOutput[key];
      if (typeof value === 'string') push(value);
    }
    const code =
      rawOutput.exitCode ?? rawOutput.exit_code ?? rawOutput.exitStatus ?? rawOutput.code;
    if (typeof code === 'number' && Number.isInteger(code)) {
      exitCode = code;
    } else if (typeof code === 'string' && /^-?\d+$/.test(code.trim())) {
      exitCode = Number.parseInt(code.trim(), 10);
    }
  }

  return {
    output:
      parts.length > 0
        ? limitTail(parts.join('\n'), MAX_RENDERED_COMMAND_OUTPUT_CHARS)
        : undefined,
    exitCode,
  };
}

/**
 * Extract `type: 'diff'` content blocks and rebuild a unified diff from the
 * offered `oldText`/`newText` pair. When the agent only reports the path
 * (or provides no usable text), the diff is left empty — the renderer shows
 * its "no renderable patch" fallback.
 */
function extractAcpDiffBlocks(
  update: Record<string, unknown> | undefined,
): Array<{ path: string; diff: string }> {
  const content = update?.content;
  if (!Array.isArray(content)) return [];
  const diffs: Array<{ path: string; diff: string }> = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== 'diff' || typeof item.path !== 'string' || !item.path) {
      continue;
    }
    diffs.push({
      path: item.path,
      diff: limitMiddle(
        buildUnifiedDiffFromTexts(item.path, item.oldText, item.newText),
        MAX_RENDERED_DIFF_CHARS,
      ),
    });
  }
  return diffs;
}

/**
 * Rebuild a single-hunk unified diff from before/after file text using the
 * common prefix/suffix. Interleaved changes collapse into one larger hunk —
 * correct but less minimal than a full Myers diff.
 */
function buildUnifiedDiffFromTexts(
  filePath: string,
  oldText: unknown,
  newText: unknown,
): string {
  if (typeof newText !== 'string') return '';
  const isNewFile = oldText === null || oldText === undefined;
  const oldString = typeof oldText === 'string' ? oldText : '';
  if (!isNewFile && oldString === newText) return '';

  const oldLines = splitDiffLines(oldString);
  const newLines = splitDiffLines(newText);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const context = 3;
  const headContext = oldLines.slice(Math.max(0, prefix - context), prefix);
  const tailContext = oldLines.slice(
    oldLines.length - suffix,
    Math.min(oldLines.length, oldLines.length - suffix + context),
  );

  const oldCount = headContext.length + removed.length + tailContext.length;
  const newCount = headContext.length + added.length + tailContext.length;
  const oldStart = oldCount === 0 ? prefix - headContext.length : prefix - headContext.length + 1;
  const newStart = newCount === 0 ? prefix - headContext.length : prefix - headContext.length + 1;

  const lines = [
    isNewFile ? '--- /dev/null' : `--- a/${filePath}`,
    newLines.length === 0 ? '+++ /dev/null' : `+++ b/${filePath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...headContext.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...tailContext.map((line) => ` ${line}`),
  ];
  return lines.join('\n');
}

function splitDiffLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // A trailing newline is a line terminator, not an extra empty line.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function parseAcpPlanStatus(value: unknown): ChatPlanStepStatus {
  switch (value) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    default:
      return 'pending';
  }
}

function parseSubagentUpdate(
  item: Record<string, unknown> | undefined,
): CodexSubagentUpdate | null {
  if (!item || typeof item.id !== 'string') return null;

  if (item.type === 'subAgentActivity') {
    const activityKind = parseSubagentActivityKind(item.kind);
    const agentThreadId = typeof item.agentThreadId === 'string' ? item.agentThreadId : undefined;
    if (!activityKind || !agentThreadId) return null;
    let status: CodexSubagentStatus;
    if (activityKind === 'completed') status = 'completed';
    else if (activityKind === 'errored') status = 'errored';
    else if (activityKind === 'interrupted') status = 'interrupted';
    else status = 'running';
    return {
      id: item.id,
      kind: 'activity',
      receiverThreadIds: [agentThreadId],
      agents: [
        {
          threadId: agentThreadId,
          status,
          message: typeof item.message === 'string' ? item.message : undefined,
        },
      ],
      activityKind,
      agentThreadId,
      agentPath: typeof item.agentPath === 'string' ? item.agentPath : undefined,
      prompt: typeof item.prompt === 'string' ? item.prompt : undefined,
      model: typeof item.model === 'string' ? item.model : undefined,
      reasoningEffort: parseReasoningEffort(item.reasoningEffort),
      senderThreadId: typeof item.senderThreadId === 'string' ? item.senderThreadId : undefined,
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
    case 'completed':
    case 'errored':
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

function parseCursorQuestions(value: unknown): CursorQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    if (typeof candidate.id !== 'string' || typeof candidate.prompt !== 'string') return [];
    const options = Array.isArray(candidate.options)
      ? candidate.options.flatMap((option) => {
          if (
            !isRecord(option) ||
            typeof option.id !== 'string' ||
            typeof option.label !== 'string'
          ) {
            return [];
          }
          return [{ id: option.id, label: option.label }];
        })
      : [];
    return [
      {
        id: candidate.id,
        prompt: candidate.prompt,
        options,
        allowMultiple: candidate.allowMultiple === true,
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

    emitEvent(state, callbacks, {
      type: 'file_edit',
      filePath: resolvedFilePath,
      diff: limitMiddle(resolvedDiff, MAX_RENDERED_DIFF_CHARS),
    });
    emittedKeys.add(key);
  }

  for (const [key, change] of pendingByFile ?? []) {
    if (emittedKeys.has(key)) continue;
    emitEvent(state, callbacks, {
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
    emitEvent(state, callbacks, {
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

function isValidUsage(value: DojoTokenUsage): boolean {
  return (
    [value.input, value.cachedInput, value.output].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) && value.cachedInput <= value.input
  );
}
function readProtocolUsage(value: unknown): DojoTokenUsage | null {
  if (!isRecord(value)) return null;
  const usage = {
    input: value.inputTokens as number,
    cachedInput: value.cachedInputTokens as number,
    output: value.outputTokens as number,
  };
  return isValidUsage(usage) ? usage : null;
}
