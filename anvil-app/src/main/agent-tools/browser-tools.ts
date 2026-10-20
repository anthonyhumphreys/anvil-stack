// Embedded browser tools served by the local MCP endpoint (spec §6.3). Same
// tool surface as scripts/chrome-mcp-server.mjs, but the workspace check uses
// the session context resolved from the bearer token instead of the MCP
// process cwd, and commands go straight to this process's bridge (no loopback
// HTTP hop or discovery file).

import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { JsonSchema } from '../../shared/surfaces/types.js';
import { getDb } from '../db/database.js';
import {
  browserBridgeCommand,
  getBrowserScope,
  type BrowserBridgeResponse,
  type BrowserScopeSnapshot,
} from '../services/browser.service.js';
import {
  AgentToolError,
  textResult,
  type AgentToolCallResult,
  type AgentToolDefinition,
  type AgentToolProvider,
  type AgentToolSessionContext,
} from './dispatch.js';

export type { BrowserBridgeResponse, BrowserScopeSnapshot };

export type BrowserScope = { workspaceId?: string; repoPaths?: string[] } | null | undefined;

export interface BrowserToolDeps {
  /** The running bridge's scope and target generation; null when stopped. */
  getScope(): BrowserScopeSnapshot | null;
  /** Run a bridge command pinned to the target generation the scope check saw. */
  command(path: string, body: unknown, target: string): Promise<BrowserBridgeResponse>;
  repoPaths(repoIds: readonly string[]): string[];
}

const NO_BRIDGE = 'Anvil browser bridge not running. Open the Browser panel in Anvil first.';
const OUT_OF_SCOPE =
  'This browser belongs to another workspace. Open the Browser panel in this workspace first.';

const EMPTY_OBJECT: JsonSchema = { type: 'object', properties: {} };
const SELECTOR: JsonSchema = { type: 'string', description: 'CSS selector of the element' };

const TOOL_SPECS: Omit<AgentToolDefinition, 'feature' | 'requiresThread'>[] = [
  {
    name: 'browser_navigate',
    title: 'Navigate browser',
    description: 'Navigate the embedded Anvil browser to a URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The URL to navigate to' } },
      required: ['url'],
    },
    mutation: true,
  },
  {
    name: 'browser_screenshot',
    title: 'Browser screenshot',
    description:
      'Take a screenshot of the current page in the embedded Anvil browser. Returns a PNG image.',
    inputSchema: EMPTY_OBJECT,
  },
  {
    name: 'browser_evaluate',
    title: 'Evaluate JavaScript',
    description: 'Execute JavaScript in the embedded Anvil browser page and return the result',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate' },
      },
      required: ['expression'],
    },
    mutation: true,
  },
  {
    name: 'browser_get_html',
    title: 'Get page HTML',
    description: 'Get the HTML content of the current page in the embedded Anvil browser',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Optional CSS selector of a specific element. Defaults to the entire page.',
        },
      },
    },
  },
  {
    name: 'browser_get_text',
    title: 'Get page text',
    description: 'Get the visible text content of the current page in the embedded Anvil browser',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Optional CSS selector of a specific element. Defaults to document.body.',
        },
      },
    },
  },
  {
    name: 'browser_click',
    title: 'Click element',
    description: 'Click an element on the current page in the embedded Anvil browser',
    inputSchema: { type: 'object', properties: { selector: SELECTOR }, required: ['selector'] },
    mutation: true,
  },
  {
    name: 'browser_type',
    title: 'Type into element',
    description: 'Type text into an input element in the embedded Anvil browser',
    inputSchema: {
      type: 'object',
      properties: {
        selector: SELECTOR,
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['selector', 'text'],
    },
    mutation: true,
  },
  {
    name: 'browser_status',
    title: 'Browser status',
    description:
      'Get the current status of the embedded Anvil browser (attached URL, connection state)',
    inputSchema: EMPTY_OBJECT,
  },
];

export const BROWSER_TOOLS: AgentToolDefinition[] = TOOL_SPECS.map((tool) => ({
  ...tool,
  feature: 'browser',
  requiresThread: false,
}));

const TOOL_NAMES = new Set(BROWSER_TOOLS.map((tool) => tool.name));

const defaultDeps: BrowserToolDeps = {
  getScope: getBrowserScope,
  command: (path, body, target) => browserBridgeCommand(path, body, target),
  repoPaths(repoIds) {
    if (repoIds.length === 0) return [];
    const statement = getDb().prepare('SELECT path FROM repos WHERE id = ?');
    return repoIds.flatMap((id) => {
      const row = statement.get(id) as { path?: string } | undefined;
      return typeof row?.path === 'string' ? [row.path] : [];
    });
  },
};

function realpathOrSelf(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(realpathOrSelf(root), realpathOrSelf(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isBrowserInSessionScope(
  ctx: AgentToolSessionContext,
  scope: BrowserScope,
  sessionRepoPaths: readonly string[],
): boolean {
  if (!scope) return false;
  if (ctx.workspaceId && scope.workspaceId === ctx.workspaceId) return true;
  const roots = scope.repoPaths ?? [];
  return sessionRepoPaths.some((path) => roots.some((root) => isWithin(root, path)));
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value) {
    throw new AgentToolError(`${key} is required.`, 'invalid-params');
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string')
    throw new AgentToolError(`${key} must be a string.`, 'invalid-params');
  return value;
}

function errorResult(message: string): AgentToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function evaluatedValue(result: BrowserBridgeResponse): unknown {
  const outer = result.result as { result?: { value?: unknown } } | undefined;
  return outer?.result?.value;
}

function truncate(value: unknown, fallback: string, limit: number): string {
  const text = typeof value === 'string' ? value : fallback;
  return text.length > limit ? `${text.slice(0, limit)}\n... (truncated)` : text;
}

export function createBrowserToolProvider(deps: BrowserToolDeps = defaultDeps): AgentToolProvider {
  async function bridge(
    ctx: AgentToolSessionContext,
    path: string,
    body?: unknown,
  ): Promise<BrowserBridgeResponse> {
    const bridgeState = deps.getScope();
    if (!bridgeState) throw new AgentToolError(NO_BRIDGE, 'unavailable');
    if (!isBrowserInSessionScope(ctx, bridgeState.scope, deps.repoPaths(ctx.repoIds))) {
      throw new AgentToolError(OUT_OF_SCOPE, 'forbidden');
    }
    return deps.command(path, body, bridgeState.target);
  }

  async function evaluate(ctx: AgentToolSessionContext, expression: string) {
    return bridge(ctx, '/evaluate', { expression });
  }

  return {
    id: 'browser',
    tools: () => BROWSER_TOOLS,
    async call(ctx, name, args) {
      if (!TOOL_NAMES.has(name)) return undefined;
      switch (name) {
        case 'browser_navigate': {
          const url = requireString(args, 'url');
          const result = await bridge(ctx, '/navigate', { url });
          return result.error ? errorResult(result.error) : textResult(`Navigated to ${url}`);
        }
        case 'browser_screenshot': {
          const result = await bridge(ctx, '/screenshot', {});
          if (result.error) return errorResult(result.error);
          if (typeof result.data !== 'string') return errorResult('No screenshot returned');
          return {
            content: [
              {
                type: 'image',
                data: result.data,
                mimeType: typeof result.mimeType === 'string' ? result.mimeType : 'image/png',
              },
            ],
          };
        }
        case 'browser_evaluate': {
          const result = await evaluate(ctx, requireString(args, 'expression'));
          if (result.error) return errorResult(result.error);
          const value = evaluatedValue(result);
          return textResult(value !== undefined ? JSON.stringify(value, null, 2) : 'undefined');
        }
        case 'browser_get_html': {
          const selector = optionalString(args, 'selector');
          const expression = selector
            ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML ?? 'Element not found'`
            : 'document.documentElement.outerHTML';
          const result = await evaluate(ctx, expression);
          if (result.error) return errorResult(result.error);
          return textResult(truncate(evaluatedValue(result), 'No HTML returned', 50_000));
        }
        case 'browser_get_text': {
          const selector = JSON.stringify(optionalString(args, 'selector') ?? 'body');
          const result = await evaluate(
            ctx,
            `(document.querySelector(${selector})?.innerText ?? 'Element not found')`,
          );
          if (result.error) return errorResult(result.error);
          return textResult(truncate(evaluatedValue(result), 'No text returned', 30_000));
        }
        case 'browser_click': {
          const selector = JSON.stringify(requireString(args, 'selector'));
          const result = await evaluate(
            ctx,
            `(() => { const el = document.querySelector(${selector}); if (!el) return 'Element not found: ' + ${selector}; el.click(); return 'Clicked: ' + ${selector}; })()`,
          );
          if (result.error) return errorResult(result.error);
          const value = evaluatedValue(result);
          return textResult(typeof value === 'string' ? value : 'Click executed');
        }
        case 'browser_type': {
          const selector = JSON.stringify(requireString(args, 'selector'));
          const text = args.text;
          if (typeof text !== 'string')
            throw new AgentToolError('text is required.', 'invalid-params');
          const result = await evaluate(
            ctx,
            `(() => { const el = document.querySelector(${selector}); if (!el) return 'Element not found: ' + ${selector}; el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'Typed into: ' + ${selector}; })()`,
          );
          if (result.error) return errorResult(result.error);
          const value = evaluatedValue(result);
          return textResult(typeof value === 'string' ? value : 'Type executed');
        }
        default: {
          const result = await bridge(ctx, '/status');
          if (result.error) return errorResult(result.error);
          const url = typeof result.url === 'string' ? result.url : 'none';
          return textResult(`Browser attached: ${result.attached === true}\nCurrent URL: ${url}`);
        }
      }
    },
  };
}

export const browserToolProvider = createBrowserToolProvider();
