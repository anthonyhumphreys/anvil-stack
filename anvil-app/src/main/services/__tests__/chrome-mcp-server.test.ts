import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = resolve(process.cwd(), 'scripts/chrome-mcp-server.mjs');

describe('Anvil Chrome MCP server', () => {
  it('answers newline-delimited MCP requests used by Codex', async () => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));

    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);

    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });

    expect(exitCode).toBe(0);
    const response = JSON.parse(Buffer.concat(stdout).toString()) as {
      result: { serverInfo: { name: string; version: string } };
    };
    expect(response.result.serverInfo).toEqual({ name: 'anvil-chrome', version: '0.1.0' });
  });
});
