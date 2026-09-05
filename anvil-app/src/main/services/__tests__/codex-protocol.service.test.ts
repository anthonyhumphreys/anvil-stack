import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { CodexEvent } from '../../../shared/types.js';
import {
  handleCodexServerLine,
  sendCodexJsonRpc,
  sendCodexJsonRpcNotification,
  sendCodexJsonRpcResult,
  type CodexProtocolState,
} from '../codex-protocol.service.js';

function createState(): CodexProtocolState {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    initialized: true,
  };
}

function collectEvents(state: CodexProtocolState, messages: unknown[]): CodexEvent[] {
  const events: CodexEvent[] = [];

  for (const message of messages) {
    handleCodexServerLine(state, JSON.stringify(message), {
      onEvent: (event) => events.push(event),
    });
  }

  return events;
}

describe('codex protocol service', () => {
  it('writes requests, notifications, and results as newline-delimited JSON-RPC', () => {
    const stdin = new PassThrough();
    const output: string[] = [];
    stdin.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    const proc = { stdin } as unknown as ChildProcess;

    expect(sendCodexJsonRpc(proc, 'turn/start', { threadId: 'thread-1' })).toBe(true);
    expect(sendCodexJsonRpcNotification(proc, 'initialized', {})).toBe(true);
    expect(sendCodexJsonRpcResult(proc, 42, { accepted: true })).toBe(true);

    const messages = output
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'turn/start',
      params: { threadId: 'thread-1' },
    });
    expect(messages[0].id).toEqual(expect.any(String));
    expect(messages[1]).toEqual({ method: 'initialized', params: {} });
    expect(messages[2]).toEqual({ jsonrpc: '2.0', id: 42, result: { accepted: true } });
    expect(stdin.listenerCount('error')).toBe(1);
  });

  it('rejects writes to a closed provider stream', () => {
    const stdin = new PassThrough();
    stdin.end();
    const proc = { stdin } as unknown as ChildProcess;

    expect(sendCodexJsonRpc(proc, 'turn/start', {})).toBe(false);
  });

  it('handles closed-pipe errors without raising an uncaught exception', () => {
    const stdin = new PassThrough();
    const proc = { stdin } as unknown as ChildProcess;
    sendCodexJsonRpc(proc, 'initialize', {});
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    expect(() => stdin.emit('error', error)).not.toThrow();
  });

  it('logs unexpected provider stream errors without raising an uncaught exception', () => {
    const stdin = new PassThrough();
    const proc = { stdin } as unknown as ChildProcess;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sendCodexJsonRpc(proc, 'initialize', {});
    const error = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });

    expect(() => stdin.emit('error', error)).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith('[Codex] JSON-RPC stdin error:', error);
    consoleError.mockRestore();
  });

  it('preserves agent message item boundaries and normalises phases', () => {
    const events = collectEvents(createState(), [
      {
        method: 'item/started',
        params: {
          item: { id: 'message-1', type: 'agentMessage', phase: 'commentary' },
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: { itemId: 'message-1', delta: 'Checking the tests.' },
      },
      {
        method: 'item/agentMessage/delta',
        params: { itemId: 'message-2', phase: 'final_answer', delta: 'All tests pass.' },
      },
    ]);

    expect(events).toEqual([
      {
        type: 'text',
        text: 'Checking the tests.',
        itemId: 'message-1',
        assistantPhase: 'progress',
      },
      {
        type: 'text',
        text: 'All tests pass.',
        itemId: 'message-2',
        assistantPhase: 'final',
      },
    ]);
  });

  it('keeps legacy agent message deltas compatible when metadata is absent', () => {
    const events = collectEvents(createState(), [
      {
        method: 'codex/event/agent_message_content_delta',
        params: { delta: 'Legacy output' },
      },
    ]);

    expect(events).toEqual([{ type: 'text', text: 'Legacy output' }]);
  });

  it('coalesces repeated file patch updates into one final file edit event', () => {
    const state = createState();
    const events = collectEvents(state, [
      {
        method: 'item/fileChange/patchUpdated',
        params: {
          itemId: 'edit-1',
          changes: [{ path: 'src/app.ts', diff: 'first patch' }],
        },
      },
      {
        method: 'item/fileChange/patchUpdated',
        params: {
          itemId: 'edit-1',
          changes: [{ path: 'src/app.ts', diff: 'second patch' }],
        },
      },
      {
        method: 'item/completed',
        params: {
          item: { id: 'edit-1', type: 'fileChange' },
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: 'file_edit',
        filePath: 'src/app.ts',
        diff: 'second patch',
      },
    ]);
  });

  it('flushes bounded pending file edits when a turn completes', () => {
    const state = createState();
    const longDiff = `diff --git a/big.ts b/big.ts\n${'+x\n'.repeat(80_000)}`;
    const events = collectEvents(state, [
      {
        method: 'item/fileChange/patchUpdated',
        params: {
          itemId: 'edit-1',
          changes: [{ path: 'big.ts', diff: longDiff }],
        },
      },
      {
        method: 'turn/completed',
        params: {},
      },
    ]);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: 'file_edit',
      filePath: 'big.ts',
    });
    expect(events[0].diff?.length).toBeLessThanOrEqual(120_000);
    expect(events[0].diff).toContain('truncated');
    expect(events[1]).toMatchObject({ type: 'turn_outcome', turnOutcome: 'completed' });
    expect(events[2]).toEqual({ type: 'status', status: 'complete' });
  });

  it('preserves a failed Codex turn instead of reporting successful completion', () => {
    const events = collectEvents(createState(), [
      {
        method: 'turn/completed',
        params: {
          turn: {
            id: 'turn-1',
            status: 'failed',
            error: { message: 'The command was rejected.' },
          },
        },
      },
    ]);

    expect(events).toEqual([
      { type: 'turn_outcome', turnOutcome: 'failed', protocolTurnId: 'turn-1' },
      {
        type: 'status',
        status: 'error',
        errorMessage: 'The command was rejected.',
      },
    ]);
  });

  it('uses the buffered patch when a completed file change only contains paths', () => {
    const state = createState();
    const events = collectEvents(state, [
      {
        method: 'item/fileChange/patchUpdated',
        params: {
          itemId: 'edit-1',
          changes: [{ path: 'src/app.ts', diff: 'latest buffered patch' }],
        },
      },
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'edit-1',
            type: 'fileChange',
            changes: [{ path: 'src/app.ts' }],
          },
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: 'file_edit',
        filePath: 'src/app.ts',
        diff: 'latest buffered patch',
      },
    ]);
  });

  it('bounds large aggregated command output before it reaches the renderer', () => {
    const events = collectEvents(createState(), [
      {
        method: 'item/completed',
        params: {
          item: {
            type: 'commandExecution',
            command: 'npm test',
            aggregatedOutput: 'log\n'.repeat(80_000),
            exitCode: 0,
          },
        },
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'command_exec',
      command: 'npm test',
      exitCode: 0,
    });
    expect(events[0].output?.length).toBeLessThanOrEqual(120_000);
    expect(events[0].output).toContain('truncated');
  });

  it('preserves numeric approval request ids from app-server', () => {
    const events = collectEvents(createState(), [
      {
        id: 61,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'cmd-1',
          command: 'npm test',
          cwd: '/repo',
          reason: 'Needs approval',
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: 'approval_request',
        approvalRequestId: 61,
        approvalKind: 'command',
        approvalReason: 'Needs approval',
        approvalCommand: 'npm test',
        approvalCwd: '/repo',
      },
    ]);
  });

  it('surfaces permission approvals, including JSON-RPC request id zero', () => {
    const events = collectEvents(createState(), [
      {
        id: 0,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-child',
          turnId: 'turn-1',
          itemId: 'permission-1',
          cwd: '/repo',
          reason: 'Needs network access',
          permissions: { network: { enabled: true } },
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: 'approval_request',
        approvalRequestId: 0,
        approvalKind: 'permissions',
        approvalReason: 'Needs network access',
        approvalCwd: '/repo',
        approvalPermissions: { network: { enabled: true } },
        protocolThreadId: 'thread-child',
      },
    ]);
  });

  it('maps user input and MCP elicitation requests into blocking chat events', () => {
    const events = collectEvents(createState(), [
      {
        id: 'question-1',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread-child',
          turnId: 'turn-1',
          itemId: 'input-1',
          autoResolutionMs: 60_000,
          questions: [
            {
              id: 'provider',
              header: 'Provider',
              question: 'Which provider?',
              isOther: true,
              isSecret: false,
              options: [{ label: 'Linear', description: 'Use the Linear connection.' }],
            },
          ],
        },
      },
      {
        id: 'elicitation-1',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'impeccable',
          mode: 'form',
          message: 'Choose the design direction.',
          requestedSchema: { type: 'object' },
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: 'input_request',
        inputRequestId: 'question-1',
        protocolThreadId: 'thread-child',
        inputRequest: {
          kind: 'user_input',
          autoResolutionMs: 60_000,
          questions: [
            {
              id: 'provider',
              header: 'Provider',
              question: 'Which provider?',
              isOther: true,
              isSecret: false,
              options: [{ label: 'Linear', description: 'Use the Linear connection.' }],
            },
          ],
        },
      },
      {
        type: 'input_request',
        inputRequestId: 'elicitation-1',
        protocolThreadId: 'thread-1',
        inputRequest: {
          kind: 'mcp_elicitation',
          message: 'Choose the design direction.',
          serverName: 'impeccable',
          mode: 'form',
          requestedSchema: { type: 'object' },
          url: undefined,
        },
      },
    ]);
  });

  it('surfaces subagent lifecycle, results, and waiting states', () => {
    const events = collectEvents(createState(), [
      {
        method: 'item/started',
        params: {
          item: {
            id: 'collab-1',
            type: 'collabAgentToolCall',
            tool: 'spawnAgent',
            status: 'inProgress',
            senderThreadId: 'thread-1',
            receiverThreadIds: ['thread-child'],
            prompt: 'Audit the chat UI.',
            model: 'gpt-5.4',
            reasoningEffort: 'high',
            agentsStates: {
              'thread-child': { status: 'running', message: null },
            },
          },
        },
      },
      {
        method: 'thread/status/changed',
        params: {
          threadId: 'thread-child',
          status: { type: 'active', activeFlags: ['waitingOnApproval'] },
        },
      },
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'collab-1',
            type: 'collabAgentToolCall',
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: 'thread-1',
            receiverThreadIds: ['thread-child'],
            prompt: 'Audit the chat UI.',
            model: 'gpt-5.4',
            reasoningEffort: 'high',
            agentsStates: {
              'thread-child': { status: 'completed', message: 'Found the missing event.' },
            },
          },
        },
      },
    ]);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: 'subagent_update',
      subagent: {
        id: 'collab-1',
        kind: 'tool_call',
        tool: 'spawnAgent',
        status: 'inProgress',
        receiverThreadIds: ['thread-child'],
        agents: [{ threadId: 'thread-child', status: 'running' }],
      },
    });
    expect(events[1]).toEqual({
      type: 'thread_status',
      protocolThreadId: 'thread-child',
      threadActiveFlags: ['waitingOnApproval'],
    });
    expect(events[2]).toMatchObject({
      type: 'subagent_update',
      subagent: {
        id: 'collab-1',
        status: 'completed',
        agents: [
          {
            threadId: 'thread-child',
            status: 'completed',
            message: 'Found the missing event.',
          },
        ],
      },
    });
  });

  it('surfaces server request resolution so stale blocking cards can be removed', () => {
    const events = collectEvents(createState(), [
      {
        method: 'serverRequest/resolved',
        params: { requestId: 0 },
      },
    ]);

    expect(events).toEqual([{ type: 'request_resolved', resolvedRequestId: 0 }]);
  });

  it('maps plan and goal notifications into structured chat events', () => {
    const events = collectEvents(createState(), [
      {
        method: 'turn/plan/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          explanation: 'Keep the blast radius civilised.',
          plan: [
            { step: 'Trace the protocol event', status: 'completed' },
            { step: 'Render the saved plan', status: 'inProgress' },
          ],
        },
      },
      {
        method: 'thread/goal/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          goal: {
            threadId: 'thread-1',
            objective: 'Ship plan mode support',
            status: 'active',
            tokenBudget: 5000,
            tokensUsed: 1200,
            timeUsedSeconds: 45,
            createdAt: 100,
            updatedAt: 200,
          },
        },
      },
      {
        method: 'thread/goal/cleared',
        params: { threadId: 'thread-1' },
      },
    ]);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: 'plan_update',
      plan: {
        explanation: 'Keep the blast radius civilised.',
        steps: [
          { step: 'Trace the protocol event', status: 'completed' },
          { step: 'Render the saved plan', status: 'in_progress' },
        ],
      },
    });
    expect(events[0].plan?.updatedAt).toEqual(expect.any(String));
    expect(events[1]).toEqual({
      type: 'goal_update',
      goal: {
        objective: 'Ship plan mode support',
        status: 'active',
        tokenBudget: 5000,
        tokensUsed: 1200,
        timeUsedSeconds: 45,
        createdAt: 100,
        updatedAt: 200,
      },
    });
    expect(events[2]).toEqual({ type: 'goal_cleared' });
  });

  it('normalises Cursor ACP session updates into chat events', () => {
    const events = collectEvents(createState(), [
      {
        method: 'session/update',
        params: {
          sessionId: 'cursor-session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: [{ type: 'text', text: 'Cursor response' }],
          },
        },
      },
      {
        method: 'session/update',
        params: {
          sessionId: 'cursor-session-1',
          update: {
            sessionUpdate: 'plan',
            entries: [
              { content: 'Inspect Cursor ACP output', status: 'in_progress' },
              { content: 'Report result', status: 'pending' },
            ],
          },
        },
      },
    ]);

    expect(events).toEqual([
      { type: 'text', text: 'Cursor response' },
      {
        type: 'plan_update',
        plan: {
          steps: [
            { id: 'cursor-plan-0', step: 'Inspect Cursor ACP output', status: 'in_progress' },
            { id: 'cursor-plan-1', step: 'Report result', status: 'pending' },
          ],
          updatedAt: expect.any(String),
        },
      },
    ]);
  });

  it('normalises Cursor ACP form elicitation into a structured input request', () => {
    const events = collectEvents(createState(), [
      {
        jsonrpc: '2.0',
        id: 17,
        method: 'elicitation/create',
        params: {
          sessionId: 'cursor-session-1',
          mode: 'form',
          message: 'Select the deployment target.',
          requestedSchema: {
            type: 'object',
            required: ['target'],
            properties: {
              target: { type: 'string', enum: ['preview', 'production'] },
            },
          },
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: 'input_request',
        inputRequestId: 17,
        protocolThreadId: 'cursor-session-1',
        inputRequest: {
          kind: 'mcp_elicitation',
          serverName: 'Cursor',
          message: 'Select the deployment target.',
          mode: 'form',
          requestedSchema: {
            type: 'object',
            required: ['target'],
            properties: {
              target: { type: 'string', enum: ['preview', 'production'] },
            },
          },
          url: undefined,
        },
      },
    ]);
  });

  it('marks Cursor ACP session/new results as thread ready', () => {
    const state: CodexProtocolState = { threadId: null, turnId: null, initialized: false };
    let ready = false;

    handleCodexServerLine(
      state,
      JSON.stringify({ jsonrpc: '2.0', id: 'session-new', result: { sessionId: 'cursor-1' } }),
      { onThreadReady: () => (ready = true) },
    );

    expect(ready).toBe(true);
    expect(state.threadId).toBe('cursor-1');
    expect(state.initialized).toBe(true);
  });
});

describe('provider-neutral execution evidence', () => {
  it('does not charge restored usage and deduplicates cumulative token notifications', () => {
    const state = createState();
    state.turnId = null;
    const usage = (input: number, output: number, turnId = 'turn-1') => ({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId,
        tokenUsage: {
          total: { inputTokens: input, cachedInputTokens: 20, outputTokens: output },
          last: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
        },
      },
    });
    const events = collectEvents(state, [
      usage(100, 50),
      { method: 'turn/started', params: { turn: { id: 'turn-1' } } },
      usage(110, 55),
      usage(110, 55),
      { ...usage(999, 999), params: { ...usage(999, 999).params, threadId: 'other-thread' } },
      usage(120, 60),
    ]);
    expect(events.filter((e) => e.type === 'usage').map((e) => e.usage)).toEqual([
      { input: 10, cachedInput: 0, output: 5 },
      { input: 10, cachedInput: 0, output: 5 },
    ]);
  });
  it('preserves interrupted outcomes for app-server and ACP', () => {
    const app = collectEvents(createState(), [
      { method: 'turn/completed', params: { turn: { id: 't', status: 'interrupted' } } },
    ]);
    const acp = collectEvents(createState(), [{ id: 1, result: { stopReason: 'cancelled' } }]);
    for (const events of [app, acp])
      expect(events.find((e) => e.type === 'turn_outcome')?.turnOutcome).toBe('interrupted');
  });
  it('does not label ACP token limits or refusals as completed execution', () => {
    for (const stopReason of ['max_tokens', 'max_turn_requests', 'refusal'])
      expect(
        collectEvents(createState(), [{ id: 1, result: { stopReason } }]).find(
          (e) => e.type === 'turn_outcome',
        )?.turnOutcome,
      ).toBe('failed');
  });
  it('normalizes ACP context and observed cost differences without inventing token usage', () => {
    const update = (amount: number) => ({
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'usage_update',
          used: 100,
          size: 1000,
          cost: { currency: 'USD', amount },
        },
      },
    });
    const events = collectEvents(createState(), [update(4), update(4.5), update(4.5)]);
    expect(events[0]).toMatchObject({
      type: 'usage_context',
      contextUsage: { used: 100, size: 1000 },
    });
    expect(events[0].observedCostUsd).toBeUndefined();
    expect(events[1].observedCostUsd).toBe(0.5);
    expect(events[2].observedCostUsd).toBe(0);
  });
});
