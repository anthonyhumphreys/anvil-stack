#!/usr/bin/env node

/**
 * Anvil Chrome MCP Server
 *
 * A minimal MCP (Model Context Protocol) server that bridges Codex/Claude to
 * Anvil's embedded browser via the CDP HTTP bridge.
 *
 * Transport: stdio (JSON-RPC 2.0)
 * Bridge: HTTP to localhost:<port> read from ~/.anvil/browser-bridge.json
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { request } from 'node:http';

// ---------------------------------------------------------------------------
// Bridge connection
// ---------------------------------------------------------------------------

const BRIDGE_INFO_PATHS = [
  join(homedir(), '.anvil', 'browser-bridge.json'),
  join(homedir(), '.devhub', 'browser-bridge.json'),
];

function getBridgePort() {
  for (const bridgeInfoPath of BRIDGE_INFO_PATHS) {
    try {
      const info = JSON.parse(readFileSync(bridgeInfoPath, 'utf-8'));
      return info.port;
    } catch {
      // Try the next path.
    }
  }
  return null;
}

function bridgeRequest(path, body = null) {
  const port = getBridgePort();
  if (!port) return Promise.reject(new Error('Anvil browser bridge not running. Open the Browser panel in Anvil first.'));

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: body ? 'POST' : 'GET',
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        timeout: 30_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            resolve({ error: 'Invalid response from bridge' });
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Bridge request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// MCP Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Navigate the embedded Anvil browser to a URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page in the embedded Anvil browser. Returns a base64-encoded PNG image.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript in the embedded Anvil browser page and return the result',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_get_html',
    description: 'Get the full HTML content of the current page in the embedded Anvil browser',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector to get HTML of a specific element. Defaults to the entire page.' },
      },
    },
  },
  {
    name: 'browser_get_text',
    description: 'Get the visible text content of the current page in the embedded Anvil browser',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector to get text of a specific element. Defaults to document.body.' },
      },
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element on the current page in the embedded Anvil browser',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into a focused or selected input element in the embedded Anvil browser',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input element' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_status',
    description: 'Get the current status of the embedded Anvil browser (attached URL, connection state)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleToolCall(name, args) {
  switch (name) {
    case 'browser_navigate': {
      const result = await bridgeRequest('/navigate', { url: args.url });
      if (result.error) return { isError: true, content: [{ type: 'text', text: result.error }] };
      return { content: [{ type: 'text', text: `Navigated to ${args.url}` }] };
    }

    case 'browser_screenshot': {
      const result = await bridgeRequest('/screenshot');
      if (result.error) return { isError: true, content: [{ type: 'text', text: result.error }] };
      return {
        content: [
          { type: 'image', data: result.data, mimeType: result.mimeType },
        ],
      };
    }

    case 'browser_evaluate': {
      const result = await bridgeRequest('/evaluate', { expression: args.expression });
      if (result.error) return { isError: true, content: [{ type: 'text', text: result.error }] };
      const value = result.result?.result?.value;
      return {
        content: [{ type: 'text', text: value !== undefined ? JSON.stringify(value, null, 2) : 'undefined' }],
      };
    }

    case 'browser_get_html': {
      const selector = args.selector || 'document.documentElement';
      const expression = args.selector
        ? `document.querySelector(${JSON.stringify(args.selector)})?.outerHTML ?? 'Element not found'`
        : `document.documentElement.outerHTML`;
      const result = await bridgeRequest('/evaluate', { expression });
      if (result.error) return { isError: true, content: [{ type: 'text', text: result.error }] };
      const html = result.result?.result?.value ?? 'No HTML returned';
      // Truncate if massive
      const truncated = html.length > 50_000 ? html.slice(0, 50_000) + '\n... (truncated)' : html;
      return { content: [{ type: 'text', text: truncated }] };
    }

    case 'browser_get_text': {
      const selector = args.selector ? JSON.stringify(args.selector) : '"body"';
      const expression = `(document.querySelector(${selector})?.innerText ?? 'Element not found')`;
      const result = await bridgeRequest('/evaluate', { expression });
      if (result.error) return { isError: true, content: [{ type: 'text', text: result.error }] };
      const text = result.result?.result?.value ?? 'No text returned';
      const truncated = text.length > 30_000 ? text.slice(0, 30_000) + '\n... (truncated)' : text;
      return { content: [{ type: 'text', text: truncated }] };
    }

    case 'browser_click': {
      const expression = `(() => {
        const el = document.querySelector(${JSON.stringify(args.selector)});
        if (!el) return 'Element not found: ${args.selector}';
        el.click();
        return 'Clicked: ${args.selector}';
      })()`;
      const result = await bridgeRequest('/evaluate', { expression });
      if (result.error) return { isError: true, content: [{ type: 'text', text: result.error }] };
      return { content: [{ type: 'text', text: result.result?.result?.value ?? 'Click executed' }] };
    }

    case 'browser_type': {
      const expression = `(() => {
        const el = document.querySelector(${JSON.stringify(args.selector)});
        if (!el) return 'Element not found: ${args.selector}';
        el.focus();
        el.value = ${JSON.stringify(args.text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'Typed into: ${args.selector}';
      })()`;
      const result = await bridgeRequest('/evaluate', { expression });
      if (result.error) return { isError: true, content: [{ type: 'text', text: result.error }] };
      return { content: [{ type: 'text', text: result.result?.result?.value ?? 'Type executed' }] };
    }

    case 'browser_status': {
      const result = await bridgeRequest('/status');
      if (result.error) return { isError: true, content: [{ type: 'text', text: result.error }] };
      return {
        content: [{
          type: 'text',
          text: `Browser attached: ${result.attached}\nCurrent URL: ${result.url ?? 'none'}`,
        }],
      };
    }

    default:
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
}

// ---------------------------------------------------------------------------
// MCP stdio transport — JSON-RPC 2.0
// ---------------------------------------------------------------------------

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'anvil-chrome',
            version: '0.1.0',
          },
        },
      });
      break;

    case 'notifications/initialized':
      // No response needed
      break;

    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      });
      break;

    case 'tools/call':
      handleToolCall(params.name, params.arguments ?? {})
        .then((result) => {
          send({ jsonrpc: '2.0', id, result });
        })
        .catch((err) => {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: err.message }],
            },
          });
        });
      break;

    default:
      if (id) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }
  }
}

// ---------------------------------------------------------------------------
// Message framing — handle Content-Length header framing
// ---------------------------------------------------------------------------

let buffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;

  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // Try to parse as raw JSON (some transports skip framing)
      try {
        const msg = JSON.parse(buffer);
        buffer = '';
        handleMessage(msg);
      } catch {
        buffer = '';
      }
      break;
    }

    const contentLength = parseInt(match[1], 10);
    const messageStart = headerEnd + 4;
    if (buffer.length < messageStart + contentLength) break;

    const messageStr = buffer.slice(messageStart, messageStart + contentLength);
    buffer = buffer.slice(messageStart + contentLength);

    try {
      handleMessage(JSON.parse(messageStr));
    } catch (err) {
      process.stderr.write(`[chrome-mcp] Parse error: ${err.message}\n`);
    }
  }
});

// Also handle newline-delimited JSON (fallback)
const rl = createInterface({ input: process.stdin, terminal: false });
// The 'data' handler above takes priority; rl is a safety net for simpler transports.

process.stderr.write('[chrome-mcp] Anvil Chrome MCP server started\n');
