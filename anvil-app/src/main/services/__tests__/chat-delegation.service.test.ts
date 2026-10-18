import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRun } from '../../../shared/types.js';
import type { ChatDelegationInput } from '../../../shared/chat-delegation.js';
import { AGENT_PROVIDERS } from '../../../shared/agent-providers.js';
import {
  callAgentTool,
  listAgentTools,
  registerAgentToolProvider,
  resetAgentToolProvidersForTests,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch.js';

const mocks = vi.hoisted(() => ({
  approval: vi.fn(),
  discover: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
  existing: vi.fn(),
  list: vi.fn(),
  source: vi.fn(),
  scope: vi.fn(),
  sessions: vi.fn(),
  feedback: vi.fn(),
  preflight: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  retry: vi.fn(),
  integrate: vi.fn(),
  dispatch: vi.fn(),
  refresh: vi.fn(),
  cancelDispatch: vi.fn(),
  validate: vi.fn(),
}));
vi.mock('../../db/database.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => ({ name: 'Repository' }) }) }),
}));
vi.mock('../../surfaces/core.js', () => ({ requestUserApproval: mocks.approval }));
vi.mock('../delegation-capabilities.service.js', () => ({
  discoverDelegationCapabilities: mocks.discover,
}));
vi.mock('../codex-session.service.js', () => ({
  getCodexSession: mocks.source,
  getAgentToolSessionContext: mocks.scope,
  listActiveCodexSessions: mocks.sessions,
  deliverStructuredAgentFeedback: mocks.feedback,
}));
vi.mock('../chat-persistence.service.js', () => ({
  getChatThread: (id: string) =>
    id === 'thread' ? { id, workspaceId: 'ws', temporary: false } : null,
}));
vi.mock('../chat-continuation.service.js', () => ({
  captureThreadContinuation: () => ({ context: 'Visible history' }),
  prependThreadContinuation: (context: string, message: string) => `${context}\n${message}`,
}));
vi.mock('../mesh-dispatch.service.js', () => ({
  cancelNodeDispatch: mocks.cancelDispatch,
  getWorkflowDispatch: mocks.dispatch,
  refreshDispatch: mocks.refresh,
}));
vi.mock('../workflow.service.js', () => ({
  startChatWorkflowRun: mocks.start,
  getWorkflowRun: mocks.get,
  getChatWorkflowRunByRequest: mocks.existing,
  listChatWorkflowRuns: mocks.list,
  assertChatDelegationSources: mocks.preflight,
  validateWorkflowGraph: mocks.validate,
  cancelWorkflowRun: mocks.cancel,
  resumeWorkflowRun: mocks.resume,
  retryWorkflowNode: mocks.retry,
  convergeWorkflowRun: mocks.integrate,
}));
import { delegationToolProvider } from '../../agent-tools/delegation-tools.js';
import {
  assertChatDelegationsFinished,
  describeChatDelegation,
  notifyChatDelegationResult,
} from '../chat-delegation.service.js';

const ctx: AgentToolSessionContext = {
  sessionId: 'session',
  appThreadId: 'thread',
  workspaceId: 'ws',
  repoIds: ['repo'],
  provider: 'codex',
  mode: 'on-request',
  features: ['chat'],
};
const proposal = (): ChatDelegationInput & Record<string, unknown> => ({
  requestId: 'review-1',
  title: 'Independent review',
  reason: 'A second provider can review the proposed changes independently.',
  tasks: [
    {
      id: 'review',
      name: 'Review',
      instruction: 'Inspect the code and report concerns. Do not edit files.',
      destinationId: 'local',
      provider: 'cursor',
      model: 'auto',
    },
  ],
});
let run: WorkflowRun;
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  vi.resetAllMocks();
  resetAgentToolProvidersForTests();
  registerAgentToolProvider(delegationToolProvider);
  mocks.source.mockReturnValue({ id: 'session', appThreadId: 'thread', personaId: 'architect' });
  mocks.scope.mockReturnValue(ctx);
  mocks.sessions.mockReturnValue([]);
  mocks.cancelDispatch.mockResolvedValue({ state: 'cancel-requested' });
  mocks.discover.mockResolvedValue({
    providers: AGENT_PROVIDERS.map((id) => ({
      id,
      defaultModel: 'auto',
      models: [{ id: 'auto', label: 'Auto' }],
    })),
    destinations: [
      { id: 'local', label: 'This device', target: { kind: 'local' }, providers: AGENT_PROVIDERS },
      {
        id: 'device:worker',
        label: 'Build machine',
        target: { kind: 'device', enrollmentId: 'worker' },
        providers: ['codex', 'openai', 'azure'],
      },
    ],
  });
  mocks.list.mockReturnValue([]);
  mocks.existing.mockReturnValue(null);
  mocks.approval.mockResolvedValue(true);
  mocks.start.mockImplementation((input) => {
    run = {
      id: 'run',
      templateId: 'chat:run',
      templateName: input.definition.name,
      workspaceId: input.workspaceId,
      repoIds: input.repoIds,
      nodes: input.definition.nodes,
      edges: input.definition.edges,
      orchestration: input.definition.orchestration,
      kickoff: input.kickoff,
      status: 'running',
      supervisorThreadId: input.origin.threadId,
      nodeRuns: input.definition.nodes.map((node: { id: string }) => ({
        nodeId: node.id,
        status: 'running',
      })),
      createdAt: 'now',
      chatOrigin: input.origin,
    };
    return run;
  });
  mocks.get.mockImplementation(() => run);
  mocks.cancel.mockImplementation(() => ({ ...run, status: 'cancelled' }));
});

describe('chat-native delegation', () => {
  it('launches an ad hoc bounded run only after approval, retaining the source chat and scope', async () => {
    const input = proposal();
    mocks.approval.mockImplementation(async () => {
      expect(mocks.start).not.toHaveBeenCalled();
      return true;
    });
    await callAgentTool(ctx, 'delegation_propose', input);
    expect(mocks.approval).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ detail: expect.stringContaining(input.tasks[0].instruction) }),
      undefined,
      { keepAcrossTurns: true },
    );
    const started = mocks.start.mock.calls[0][0];
    expect(started).toMatchObject({
      workspaceId: 'ws',
      repoIds: ['repo'],
      permissionCeiling: 'on-request',
      kickoff: `Visible history\n${input.reason}`,
      origin: { threadId: 'thread', requestId: input.requestId },
      definition: {
        nodes: [
          {
            provider: 'cursor',
            personaId: 'architect',
            permissionMode: 'read-only',
            target: { kind: 'local' },
          },
        ],
        orchestration: {
          maxNodes: 8,
          maxDepth: 0,
          maxConcurrency: 2,
          maxAttempts: 2,
          timeoutMinutes: 30,
        },
      },
    });
    expect(started).not.toHaveProperty('templateId');
  });
  it.each(AGENT_PROVIDERS)('offers the same tools and approval path to %s', async (provider) => {
    const input = proposal();
    input.tasks[0].provider = provider;
    const session = { ...ctx, provider, mode: 'read-only' as const };
    mocks.scope.mockReturnValue(session);
    input.tasks[0].access = 'inherit';
    expect(listAgentTools(session).map((tool) => tool.name)).toContain('delegation_propose');
    await callAgentTool(session, 'delegation_propose', input);
    expect(mocks.start.mock.calls[0][0].definition.nodes[0].permissionMode).toBe('read-only');
  });
  it('honours a reduced access ceiling at approval time', async () => {
    const input = proposal();
    input.tasks[0].access = 'inherit';
    mocks.scope.mockReturnValue({ ...ctx, mode: 'read-only' });
    await callAgentTool(ctx, 'delegation_propose', input);
    expect(mocks.start.mock.calls[0][0].permissionCeiling).toBe('read-only');
  });
  it('does not launch declined, aborted or stopped proposals', async () => {
    mocks.approval.mockResolvedValue(false);
    expect((await callAgentTool(ctx, 'delegation_propose', proposal())).structuredContent).toEqual({
      status: 'awaiting-approval',
      requestId: 'review-1',
      title: 'Independent review',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const controller = new AbortController();
    controller.abort();
    expect(
      (await callAgentTool(ctx, 'delegation_propose', proposal(), controller.signal))
        .structuredContent,
    ).toEqual({ status: 'cancelled' });
    mocks.approval.mockResolvedValue(true);
    mocks.source.mockReturnValueOnce({ appThreadId: 'thread' }).mockReturnValueOnce(null);
    await callAgentTool(ctx, 'delegation_propose', proposal());
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('coalesces in-flight retries and reuses the durable run after a lost response', async () => {
    let approve!: (value: boolean) => void;
    mocks.approval.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          approve = resolve;
        }),
    );
    const transport = new AbortController();
    const first = callAgentTool(ctx, 'delegation_propose', proposal(), transport.signal);
    await vi.waitFor(() => expect(mocks.approval).toHaveBeenCalledOnce());
    const second = callAgentTool(ctx, 'delegation_propose', proposal());
    expect((await first).structuredContent).toMatchObject({ status: 'awaiting-approval' });
    transport.abort();
    expect(mocks.start).not.toHaveBeenCalled();
    await expect(
      callAgentTool(ctx, 'delegation_propose', { ...proposal(), title: 'Changed work' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    approve(true);
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.approval).toHaveBeenCalledOnce();
    mocks.existing.mockReturnValue(run);
    await callAgentTool(ctx, 'delegation_propose', proposal());
    expect(mocks.start).toHaveBeenCalledOnce();
    await expect(
      callAgentTool(ctx, 'delegation_propose', { ...proposal(), reason: 'Different purpose' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('preflights remote source snapshots before asking for approval', async () => {
    const input = proposal();
    Object.assign(input.tasks[0], { provider: 'codex', destinationId: 'device:worker' });
    mocks.preflight.mockImplementation(() => {
      throw new Error('Commit local changes');
    });
    await expect(callAgentTool(ctx, 'delegation_propose', input)).rejects.toThrow(
      'Commit local changes',
    );
    expect(mocks.approval).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('rejects invented targets, models and unsupported remote providers', async () => {
    for (const task of [
      { destinationId: 'invented' },
      { model: 'invented' },
      { destinationId: 'device:worker', provider: 'cursor' },
    ]) {
      const input = proposal();
      Object.assign(input.tasks[0], task);
      await expect(callAgentTool(ctx, 'delegation_propose', input)).rejects.toThrow();
    }
    expect(mocks.approval).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('requires a saved scoped chat and stops if its repository selection changes during approval', async () => {
    await expect(
      callAgentTool({ ...ctx, repoIds: [] }, 'delegation_propose', proposal()),
    ).rejects.toThrow('Select a repository');
    await expect(
      callAgentTool({ ...ctx, appThreadId: 'other' }, 'delegation_propose', proposal()),
    ).rejects.toMatchObject({ code: 'forbidden' });
    mocks.scope.mockReturnValue({ ...ctx, repoIds: ['different'] });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await callAgentTool(ctx, 'delegation_propose', proposal());
    await new Promise((resolve) => setImmediate(resolve));
    warning.mockRestore();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('rejects empty, excessive or malformed task IDs before approval', async () => {
    for (const tasks of [
      [],
      Array.from({ length: 9 }, () => proposal().tasks[0]),
      [{ ...proposal().tasks[0], id: '../invalid' }],
    ]) {
      await expect(
        callAgentTool(ctx, 'delegation_propose', { ...proposal(), tasks }),
      ).rejects.toThrow();
    }
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('isolates reports and cancellation by source chat, workspace and repository', async () => {
    await callAgentTool(ctx, 'delegation_propose', proposal());
    run.repoIds = ['other'];
    mocks.list.mockReturnValue([run]);
    expect((await callAgentTool(ctx, 'delegation_read', {})).structuredContent).toEqual({
      runs: [],
    });
    await expect(callAgentTool(ctx, 'delegation_read', { runId: 'run' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(callAgentTool(ctx, 'delegation_stop', { runId: 'run' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    run.repoIds = ['repo'];
    run.workspaceId = 'other';
    await expect(callAgentTool(ctx, 'delegation_read', { runId: 'run' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('bounds reports and never equates requested remote cancellation with a stopped worker', async () => {
    await callAgentTool(ctx, 'delegation_propose', proposal());
    run.nodeRuns[0].output = 'x'.repeat(50000);
    expect(describeChatDelegation(run).tasks[0]).toMatchObject({ outputTruncated: true });
    expect(describeChatDelegation(run).tasks[0].output!.length).toBe(24000);
    run.status = 'cancelled';
    run.nodeRuns[0].remote = { dispatchId: 'dispatch', state: 'running' } as NonNullable<
      (typeof run.nodeRuns)[0]['remote']
    >;
    mocks.list.mockReturnValue([run]);
    mocks.refresh.mockRejectedValue(new Error('Offline'));
    expect(describeChatDelegation(run).cancellationPending).toBe(true);
    await expect(assertChatDelegationsFinished('thread')).rejects.toThrow('wait for its workers');
    mocks.dispatch.mockReturnValue({ state: 'cancelled' });
    await expect(assertChatDelegationsFinished('thread')).resolves.toBeUndefined();
  });
  it('cancels durable remote dispatches even when the scheduler is paused', async () => {
    await callAgentTool(ctx, 'delegation_propose', proposal());
    run.status = 'paused';
    run.nodeRuns[0].remote = { dispatchId: 'dispatch', state: 'awaiting-approval' } as NonNullable<
      (typeof run.nodeRuns)[0]['remote']
    >;
    await callAgentTool(ctx, 'delegation_stop', { runId: run.id });
    expect(mocks.cancelDispatch).toHaveBeenCalledWith('dispatch');
  });
  it('records cancellation before reconciling an older cancelled remote run', async () => {
    await callAgentTool(ctx, 'delegation_propose', proposal());
    run.status = 'cancelled';
    run.nodeRuns[0].remote = { dispatchId: 'dispatch', state: 'running' } as NonNullable<
      (typeof run.nodeRuns)[0]['remote']
    >;
    mocks.list.mockReturnValue([run]);
    mocks.dispatch.mockReturnValue({ state: 'running', cancelRequested: false });
    mocks.cancelDispatch.mockImplementation(async () => {
      mocks.dispatch.mockReturnValue({ state: 'running', cancelRequested: true });
    });
    mocks.refresh.mockImplementation(async () => {
      expect(mocks.dispatch().cancelRequested).toBe(true);
    });
    await expect(assertChatDelegationsFinished('thread')).rejects.toThrow('wait for its workers');
    expect(mocks.refresh).toHaveBeenCalledWith('dispatch');
  });
  it('returns results to the current provider coordinator, respecting its current scope', async () => {
    await callAgentTool(ctx, 'delegation_propose', proposal());
    mocks.sessions.mockReturnValue([
      { id: 'new-cursor-session', appThreadId: 'thread', workspaceId: 'ws' },
    ]);
    await notifyChatDelegationResult(run);
    expect(mocks.feedback).toHaveBeenCalledWith(
      'new-cursor-session',
      expect.stringContaining('anvil.delegation.result'),
    );
    mocks.feedback.mockClear();
    mocks.scope.mockReturnValue({ ...ctx, repoIds: [] });
    await notifyChatDelegationResult(run);
    expect(mocks.feedback).not.toHaveBeenCalled();
  });
  it('keeps a launched run truthful when the live decision notice cannot be delivered', async () => {
    mocks.sessions.mockReturnValue([{ id: 'session', appThreadId: 'thread', workspaceId: 'ws' }]);
    mocks.feedback.mockRejectedValue(new Error('Provider disconnected'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await callAgentTool(ctx, 'delegation_propose', proposal());
      await new Promise((resolve) => setImmediate(resolve));
      expect(mocks.start).toHaveBeenCalledOnce();
      expect(mocks.feedback).toHaveBeenCalledOnce();
      expect(JSON.parse(mocks.feedback.mock.calls[0][1])).toMatchObject({ status: 'running' });
    } finally {
      warning.mockRestore();
    }
  });
});
