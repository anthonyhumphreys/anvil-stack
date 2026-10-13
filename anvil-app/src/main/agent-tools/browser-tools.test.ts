import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../db/database.js', () => ({ getDb: vi.fn() }));

import {
  BROWSER_TOOLS,
  createBrowserToolProvider,
  isBrowserInSessionScope,
  type BrowserBridgeInfo,
  type BrowserToolDeps,
} from './browser-tools';
import {
  callAgentTool,
  listAgentTools,
  registerAgentToolProvider,
  type AgentToolSessionContext,
} from './dispatch';

const ctx: AgentToolSessionContext = {
  sessionId: 's1',
  workspaceId: 'ws-1',
  repoIds: ['r1'],
  provider: 'codex',
  mode: 'on-request',
  features: ['browser'],
};

const info: BrowserBridgeInfo = {
  port: 1,
  token: 't',
  target: 'gen',
  scope: { workspaceId: 'ws-1', repoPaths: ['/work/ws-1'] },
};

function setup(overrides: Partial<BrowserToolDeps> = {}) {
  const request = vi.fn<BrowserToolDeps['request']>(async () => ({}));
  const deps: BrowserToolDeps = {
    readBridgeInfo: () => info,
    request,
    repoPaths: () => [],
    ...overrides,
  };
  return { provider: createBrowserToolProvider(deps), request };
}

describe('browser agent tools', () => {
  it('exposes the chrome-mcp-server tool set behind the browser feature', () => {
    expect(BROWSER_TOOLS.map((tool) => tool.name)).toEqual([
      'browser_navigate',
      'browser_screenshot',
      'browser_evaluate',
      'browser_get_html',
      'browser_get_text',
      'browser_click',
      'browser_type',
      'browser_status',
    ]);
    expect(BROWSER_TOOLS.every((tool) => tool.feature === 'browser')).toBe(true);
    expect(BROWSER_TOOLS.every((tool) => tool.requiresThread === false)).toBe(true);
  });

  it('is filtered by role and hides state-changing tools in read-only sessions', () => {
    const unregister = registerAgentToolProvider(setup().provider);
    expect(listAgentTools({ ...ctx, features: ['chat'] })).toEqual([]);
    expect(listAgentTools({ ...ctx, mode: 'read-only' }).map((tool) => tool.name)).toEqual([
      'browser_screenshot',
      'browser_get_html',
      'browser_get_text',
      'browser_status',
    ]);
    unregister();
  });

  it('navigates through the bridge with the pinned target', async () => {
    const { provider, request } = setup();
    request.mockResolvedValueOnce({ result: {} });
    const result = await provider.call(ctx, 'browser_navigate', { url: 'http://localhost:5173' });
    expect(request).toHaveBeenCalledWith(info, '/navigate', { url: 'http://localhost:5173' });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Navigated to http://localhost:5173' }],
    });
  });

  it('returns screenshots as image content and bridge errors as isError results', async () => {
    const { provider, request } = setup();
    request.mockResolvedValueOnce({ data: 'AAA', mimeType: 'image/png' });
    expect(await provider.call(ctx, 'browser_screenshot', {})).toEqual({
      content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }],
    });
    request.mockResolvedValueOnce({ error: 'No browser attached' });
    expect(await provider.call(ctx, 'browser_status', {})).toEqual({
      content: [{ type: 'text', text: 'No browser attached' }],
      isError: true,
    });
  });

  it('evaluates expressions and escapes selectors safely', async () => {
    const { provider, request } = setup();
    request.mockResolvedValue({ result: { result: { value: 'Clicked: a' } } });
    await provider.call(ctx, 'browser_click', { selector: "a'); alert(1); ('" });
    const expression = (request.mock.calls[0][2] as { expression: string }).expression;
    expect(expression).toContain(JSON.stringify("a'); alert(1); ('"));
    expect(expression).not.toContain("'Element not found: a'");

    request.mockResolvedValueOnce({ result: { result: { value: { ok: true } } } });
    expect(await provider.call(ctx, 'browser_evaluate', { expression: '({ok:true})' })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }],
    });
    request.mockResolvedValueOnce({ result: { result: { value: 'x'.repeat(30_010) } } });
    const text = await provider.call(ctx, 'browser_get_text', {});
    expect((text?.content[0] as { text: string }).text).toMatch(/\(truncated\)$/);
  });

  it('rejects missing arguments and ignores tools it does not own', async () => {
    const { provider } = setup();
    await expect(provider.call(ctx, 'browser_type', { selector: '#q' })).rejects.toMatchObject({
      code: 'invalid-params',
    });
    expect(await provider.call(ctx, 'review_publish', {})).toBeUndefined();
  });

  it('refuses when the bridge is not running or belongs to another workspace', async () => {
    const stopped = setup({ readBridgeInfo: () => null });
    await expect(stopped.provider.call(ctx, 'browser_status', {})).rejects.toMatchObject({
      code: 'unavailable',
    });
    const other = setup();
    await expect(
      other.provider.call({ ...ctx, workspaceId: 'ws-2' }, 'browser_status', {}),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(other.request).not.toHaveBeenCalled();
  });

  it('accepts repo sessions whose repositories sit inside the browser scope', () => {
    const repoCtx = { ...ctx, workspaceId: undefined };
    expect(isBrowserInSessionScope(repoCtx, info.scope, ['/work/ws-1/app'])).toBe(true);
    expect(isBrowserInSessionScope(repoCtx, info.scope, ['/work/elsewhere'])).toBe(false);
    expect(isBrowserInSessionScope(ctx, null, [])).toBe(false);
  });

  it('routes through dispatch with the session context', async () => {
    const { provider, request } = setup();
    const unregister = registerAgentToolProvider(provider);
    request.mockResolvedValueOnce({ attached: true, url: 'http://localhost:3000/' });
    expect(await callAgentTool(ctx, 'browser_status', {})).toEqual({
      content: [
        { type: 'text', text: 'Browser attached: true\nCurrent URL: http://localhost:3000/' },
      ],
    });
    unregister();
  });
});
