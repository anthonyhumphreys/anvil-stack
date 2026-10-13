#!/usr/bin/env node

// Anvil MCP stdio shim: forwards newline-delimited JSON-RPC from stdin to the
// local Anvil MCP endpoint (Streamable HTTP) and writes each JSON response to
// stdout on its own line. Used by ACP agents that only support stdio MCP
// servers. Configuration comes from the environment: ANVIL_MCP_URL and
// ANVIL_MCP_TOKEN. Dependency-free; runs under `ELECTRON_RUN_AS_NODE=1`.

import { request } from 'node:http';

const endpoint = process.env.ANVIL_MCP_URL;
const token = process.env.ANVIL_MCP_TOKEN;

if (!endpoint || !token) {
  process.stderr.write('[anvil-mcp-shim] ANVIL_MCP_URL and ANVIL_MCP_TOKEN are required\n');
  process.exit(1);
}

const url = new URL(endpoint);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
  process.stderr.write('[anvil-mcp-shim] ANVIL_MCP_URL must be a loopback http URL\n');
  process.exit(1);
}

let sessionId;
let chain = Promise.resolve();
let pending = 0;
let stdinEnded = false;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorFor(message, text) {
  const items = Array.isArray(message) ? message : [message];
  for (const item of items) {
    if (item && typeof item === 'object' && 'method' in item && item.id !== undefined) {
      write({ jsonrpc: '2.0', id: item.id, error: { code: -32000, message: text } });
    }
  }
}

function post(body) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(body),
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const header = res.headers['mcp-session-id'];
          if (typeof header === 'string' && header) sessionId = header;
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function forward(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  try {
    const { status, text } = await post(line);
    if (status === 202 || !text.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      errorFor(message, `Anvil MCP endpoint returned HTTP ${status}`);
      return;
    }
    if (status >= 400 && (!parsed || typeof parsed !== 'object' || parsed.id === null)) {
      errorFor(message, parsed?.error?.message ?? `Anvil MCP endpoint returned HTTP ${status}`);
      return;
    }
    if (Array.isArray(parsed)) for (const item of parsed) write(item);
    else write(parsed);
  } catch (error) {
    errorFor(message, `Anvil MCP endpoint unreachable: ${error.message}`);
  }
}

function maybeExit() {
  if (stdinEnded && pending === 0) process.stdout.write('', () => process.exit(0));
}

function enqueue(line) {
  pending += 1;
  const run = () =>
    forward(line).finally(() => {
      pending -= 1;
      maybeExit();
    });
  // Serialise until initialize has issued a session id; then calls run concurrently.
  if (sessionId) void run();
  else chain = chain.then(run);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) enqueue(line);
  }
});
process.stdin.on('end', () => {
  const rest = buffer.trim();
  buffer = '';
  if (rest) enqueue(rest);
  stdinEnded = true;
  maybeExit();
});
