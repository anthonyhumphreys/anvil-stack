import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRun, WorkflowTemplate } from '../../shared/types.js';
import {
  callAgentTool,
  listAgentTools,
  registerAgentToolProvider,
  resetAgentToolProvidersForTests,
  type AgentToolSessionContext,
} from './dispatch.js';
const mocks = vi.hoisted(() => ({
  approval: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
  template: vi.fn(),
  list: vi.fn(),
  wait: vi.fn(),
  feedback: vi.fn(),
  live: vi.fn(),
}));
vi.mock('../surfaces/core.js', () => ({ requestUserApproval: mocks.approval }));
vi.mock('../services/codex-session.service.js', () => ({
  deliverStructuredAgentFeedback: mocks.feedback,
  getCodexSession: mocks.live,
}));
vi.mock('../services/chat-continuation.service.js', () => ({
  captureThreadContinuation: () => ({ context: 'Saved conversation' }),
  prependThreadContinuation: (context: string, prompt: string) => `${context}\n${prompt}`,
}));
vi.mock('../services/workflow.service.js', () => ({
  getWorkflowRun: mocks.get,
  getWorkflowTemplate: mocks.template,
  listWorkflowTemplates: mocks.list,
  startWorkflowRun: mocks.start,
  waitForWorkflowRun: mocks.wait,
}));
import { workflowToolProvider } from './workflow-tools.js';
const ctx: AgentToolSessionContext = {
  sessionId: 'session',
  appThreadId: 'thread',
  workspaceId: 'ws',
  repoIds: ['repo'],
  provider: 'codex',
  mode: 'on-request',
  features: ['workflows'],
};
let template: WorkflowTemplate;
let run: WorkflowRun;
beforeEach(() => {
  vi.resetAllMocks();
  resetAgentToolProvidersForTests();
  registerAgentToolProvider(workflowToolProvider);
  template = {
    id: 'template',
    name: 'Fleet review',
    description: 'Review work',
    nodes: [
      {
        id: 'step',
        name: 'Review',
        prompt: 'Inspect',
        personaId: 'coder',
        provider: 'codex',
        model: 'gpt-6.1-sol',
        reasoningEffort: 'medium',
        executionStrategy: 'focused',
        position: { x: 0, y: 0 },
        target: { kind: 'device', enrollmentId: 'fleet-worker' },
      },
    ],
    edges: [],
    createdAt: 'now',
    updatedAt: 'now',
  };
  run = {
    id: 'run',
    templateId: template.id,
    templateName: template.name,
    workspaceId: 'ws',
    repoIds: ['repo'],
    nodes: template.nodes,
    edges: [],
    kickoff: 'Inspect',
    status: 'running',
    supervisorThreadId: 'supervisor',
    nodeRuns: [{ nodeId: 'step', status: 'running' }],
    createdAt: 'now',
  };
  mocks.template.mockImplementation(() => template);
  mocks.list.mockImplementation(() => [template]);
  mocks.get.mockImplementation(() => run);
  mocks.approval.mockResolvedValue(true);
  mocks.start.mockImplementation(() => run);
  mocks.wait.mockImplementation(() => new Promise(() => undefined));
  mocks.live.mockReturnValue({ id: 'session' });
});
describe('chat workflow tools', () => {
  it('lists approved destinations without launching work', async () => {
    const result = await callAgentTool(ctx, 'workflow_list', {});
    expect(JSON.stringify(result.structuredContent)).toContain('fleet-worker');
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('starts only after approval, retaining repository scope, context and access ceiling', async () => {
    const result = await callAgentTool(ctx, 'workflow_start', {
      templateId: 'template',
      instruction: 'Review the change',
    });
    expect(mocks.approval).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        repoIds: ['repo'],
        workspaceId: 'ws',
        permissionCeiling: 'on-request',
        kickoff: 'Saved conversation\nReview the change',
      }),
    );
    expect(result.structuredContent).toMatchObject({ runId: 'run', status: 'running' });
  });
  it('does not launch a declined or cancelled request', async () => {
    mocks.approval.mockResolvedValue(false);
    expect(
      (
        await callAgentTool(ctx, 'workflow_start', {
          templateId: 'template',
          instruction: 'Review',
        })
      ).structuredContent,
    ).toEqual({ status: 'cancelled' });
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('rechecks the exact workflow after approval', async () => {
    mocks.approval.mockImplementation(async () => {
      template.nodes[0].prompt = 'Different work';
      return true;
    });
    await expect(
      callAgentTool(ctx, 'workflow_start', { templateId: 'template', instruction: 'Review' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('does not start after the coordinating session stops', async () => {
    mocks.live.mockReturnValue(null);
    expect(
      (
        await callAgentTool(ctx, 'workflow_start', {
          templateId: 'template',
          instruction: 'Review',
        })
      ).structuredContent,
    ).toEqual({ status: 'cancelled' });
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('keeps runs isolated by workspace and repository', async () => {
    run.workspaceId = 'other';
    await expect(callAgentTool(ctx, 'workflow_read', { runId: 'run' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    run.workspaceId = 'ws';
    run.repoIds = ['other-repo'];
    await expect(callAgentTool(ctx, 'workflow_read', { runId: 'run' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('hides launch in read-only mode and requires selected repositories', async () => {
    expect(listAgentTools({ ...ctx, mode: 'read-only' }).map((t) => t.name)).not.toContain(
      'workflow_start',
    );
    await expect(
      callAgentTool({ ...ctx, repoIds: [] }, 'workflow_start', {
        templateId: 'template',
        instruction: 'Review',
      }),
    ).rejects.toThrow('Select a repository');
  });
  it('bounds agent reports and lets an aborted read return without cancelling the run', async () => {
    run.nodeRuns[0].output = 'x'.repeat(50000);
    const aborted = new AbortController();
    aborted.abort();
    const result = await callAgentTool(
      ctx,
      'workflow_read',
      { runId: 'run', waitSeconds: 30 },
      aborted.signal,
    );
    expect(JSON.stringify(result).length).toBeLessThan(50000);
    expect(result.structuredContent).toMatchObject({
      status: 'running',
      steps: [{ outputTruncated: true }],
    });
  });
  it('keeps the total report budget bounded for a full workflow graph', async () => {
    run.nodeRuns = Array.from({ length: 256 }, (_, index) => ({
      nodeId: `node-${index}`,
      status: 'completed',
      output: 'x'.repeat(5000),
    }));
    const result = await callAgentTool(ctx, 'workflow_read', { runId: 'run' });
    const steps = result.structuredContent!.steps as Array<{ output: string }>;
    expect(steps.reduce((total, step) => total + step.output.length, 0)).toBeLessThanOrEqual(24000);
  });
});
