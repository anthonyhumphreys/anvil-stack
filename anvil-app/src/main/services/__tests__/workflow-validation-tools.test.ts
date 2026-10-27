import { afterEach, describe, expect, it } from 'vitest';
import {
  callAgentTool,
  listAgentTools,
  registerAgentToolProvider,
  resetAgentToolProvidersForTests,
  textResult,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch.js';
import { openWorkflowValidationTools } from '../workflow-validation-tools.js';
import {
  resetAgentMcpRegistryForTests,
  resolveAgentMcpToken,
  setAgentMcpEndpoint,
} from '../agent-mcp/registry.js';

afterEach(() => {
  resetAgentMcpRegistryForTests();
  resetAgentToolProvidersForTests();
});
describe('workflow validation tools', () => {
  it('scopes tools, keeps tokens out of arguments, follows current access and revokes on close', async () => {
    setAgentMcpEndpoint({ url: 'http://127.0.0.1:4000/mcp', port: 4000 });
    let mode: AgentToolSessionContext['mode'] = 'workspace-auto';
    registerAgentToolProvider({
      id: 'test',
      tools: () =>
        ['validation_run', 'review_publish'].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' },
          mutation: true,
          feature: 'codereview',
        })),
      call: async () => textResult('ok'),
    });
    const access = await openWorkflowValidationTools('worker', () => ({
      sessionId: 'worker',
      appThreadId: 'thread',
      workspaceId: 'workspace',
      repoIds: ['repo'],
      provider: 'codex',
      mode,
      features: ['codereview'],
    }));
    const token = access.env.ANVIL_MCP_TOKEN!;
    expect(token).toBeTruthy();
    expect(access.args.join(' ')).not.toContain(token);
    let ctx = resolveAgentMcpToken(token)!.context;
    expect(ctx).toMatchObject({ appThreadId: 'thread', repoIds: ['repo'] });
    expect(listAgentTools(ctx).map((tool) => tool.name)).toEqual(['validation_run']);
    await expect(callAgentTool(ctx, 'review_publish', {})).rejects.toMatchObject({
      code: 'not-found',
    });
    mode = 'read-only';
    ctx = resolveAgentMcpToken(token)!.context;
    expect(listAgentTools(ctx)).toEqual([]);
    access.close();
    expect(resolveAgentMcpToken(token)).toBeUndefined();
  });
  it('adds no server when the local endpoint is unavailable', async () => {
    const access = await openWorkflowValidationTools('worker', () => undefined);
    expect(access.args).toEqual([]);
    expect(access.env).toEqual({});
    access.close();
  });
});
