import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { shell } from 'electron';

// ---------------------------------------------------------------------------
// Availability cache
// ---------------------------------------------------------------------------

let availabilityCache: boolean | null = null;

export function resetAvailabilityCache(): void {
  availabilityCache = null;
}

/**
 * Check whether the draw.io MCP tool server is available via npx.
 * Uses `execFile` (not `exec`) to avoid shell injection.
 * Result is cached after the first call.
 */
export async function checkDrawioAvailability(): Promise<boolean> {
  if (availabilityCache !== null) return availabilityCache;

  return new Promise<boolean>((resolve) => {
    execFile('npx', ['--yes', '@drawio/mcp', '--version'], { timeout: 30_000 }, (err) => {
      availabilityCache = err === null;
      resolve(availabilityCache);
    });
  });
}

// ---------------------------------------------------------------------------
// MCP subprocess lifecycle
// ---------------------------------------------------------------------------

let mcpProcess: ChildProcess | null = null;

/**
 * Open the given draw.io XML in the draw.io desktop application via MCP.
 * Falls back to opening `https://app.diagrams.net/#R{base64}` in the browser
 * when the MCP tool server is not available.
 */
export async function openInDrawio(xml: string): Promise<void> {
  const available = await checkDrawioAvailability();

  if (!available) {
    // Fallback: open in the web editor
    const base64 = Buffer.from(xml, 'utf-8').toString('base64');
    await shell.openExternal(`https://app.diagrams.net/#R${base64}`);
    return;
  }

  // Kill any previous MCP process before spawning a new one
  cleanupDrawioMcp();

  mcpProcess = spawn('npx', ['@drawio/mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });

  // Send a JSON-RPC tool call via stdin
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'open_diagram',
      arguments: { xml },
    },
  });

  mcpProcess.stdin?.write(request + '\n');
  mcpProcess.stdin?.end();

  // Clean up once the process exits
  mcpProcess.on('exit', () => {
    mcpProcess = null;
  });
}

/**
 * Kill any running draw.io MCP subprocess.
 * Should be called during app shutdown.
 */
export function cleanupDrawioMcp(): void {
  if (mcpProcess) {
    mcpProcess.kill();
    mcpProcess = null;
  }
}
