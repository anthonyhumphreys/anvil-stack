import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { type WebContents } from 'electron';

import type { DevServerTarget, BrowserBridgeStatus } from '../../shared/types.js';
import { getLegacyHiddenDirPath, getPrimaryHiddenDirPath } from '../utils/app-paths.js';

// ---------------------------------------------------------------------------
// Port Detection — scans terminal output for localhost URLs
// ---------------------------------------------------------------------------

const PORT_PATTERNS = [
  // Vite: "Local: http://localhost:5173/"
  /Local:\s+https?:\/\/localhost:(\d+)/,
  // Next.js: "ready on http://localhost:3000"
  /ready on https?:\/\/localhost:(\d+)/,
  // Generic: "http://localhost:XXXX"
  /https?:\/\/localhost:(\d+)/,
  // Generic: "http://127.0.0.1:XXXX"
  /https?:\/\/127\.0\.0\.1:(\d+)/,
  // Generic: "listening on port XXXX"
  /listening on port\s+(\d+)/i,
  // Generic: "started on port XXXX"
  /started (?:server )?on port\s+(\d+)/i,
  // CRA: "On Your Network: http://192.168.x.x:3000"
  /On Your Network:\s+https?:\/\/[\d.]+:(\d+)/,
];

// Ports that are definitely NOT dev servers
const IGNORED_PORTS = new Set([22, 80, 443, 5432, 3306, 6379, 27017, 9229]);

const targets = new Map<string, DevServerTarget>();
const seenPorts = new Set<number>();

/** Feed terminal output data to the port scanner. */
export function scanTerminalData(terminalId: string, data: string): void {
  for (const pattern of PORT_PATTERNS) {
    const match = data.match(pattern);
    if (!match) continue;

    const port = parseInt(match[1], 10);
    if (isNaN(port) || port < 1024 || port > 65535) continue;
    if (IGNORED_PORTS.has(port)) continue;
    if (seenPorts.has(port)) continue;

    seenPorts.add(port);

    const url = `http://localhost:${port}`;
    const target: DevServerTarget = {
      id: randomUUID(),
      url,
      port,
      label: `localhost:${port}`,
      terminalId,
      detectedAt: new Date().toISOString(),
    };

    targets.set(target.id, target);
    console.log(`[Browser] Detected dev server: ${url} (terminal: ${terminalId})`);
    break; // One detection per chunk is enough
  }
}

/** Remove targets associated with a terminal that exited. */
export function removeTerminalTargets(terminalId: string): void {
  for (const [id, target] of targets) {
    if (target.terminalId === terminalId) {
      seenPorts.delete(target.port);
      targets.delete(id);
    }
  }
}

/** Get all currently detected dev server targets. */
export function listTargets(): DevServerTarget[] {
  return [...targets.values()].sort(
    (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime(),
  );
}

/** Add a manual target (user-entered URL). */
export function addManualTarget(url: string): DevServerTarget {
  const parsed = new URL(url);
  const port = parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);

  const target: DevServerTarget = {
    id: randomUUID(),
    url: parsed.origin,
    port,
    label: parsed.host,
    detectedAt: new Date().toISOString(),
  };

  targets.set(target.id, target);
  return target;
}

// ---------------------------------------------------------------------------
// CDP Bridge — HTTP server that proxies CDP commands to a webContents debugger
// ---------------------------------------------------------------------------

const BRIDGE_INFO_DIR = getPrimaryHiddenDirPath();
const BRIDGE_INFO_PATH = join(BRIDGE_INFO_DIR, 'browser-bridge.json');
const LEGACY_BRIDGE_INFO_PATH = join(getLegacyHiddenDirPath(), 'browser-bridge.json');

let bridgeServer: Server | null = null;
let bridgePort: number | null = null;
let attachedWebContents: WebContents | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('aborted', () => reject(new Error('Request aborted')));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

let bridgeToken = '';
let targetGeneration = randomUUID();
let targetScope: { workspaceId: string; repoPaths: string[] } | null = null;
export function setBrowserScope(scope: { workspaceId: string; repoPaths: string[] }): void {
  if (JSON.stringify(scope) !== JSON.stringify(targetScope)) {
    targetScope = scope;
    invalidateTarget();
  }
}
function writeDiscovery(): void {
  if (!bridgePort || !bridgeToken) return;
  mkdirSync(BRIDGE_INFO_DIR, { recursive: true });
  writeFileSync(
    BRIDGE_INFO_PATH,
    JSON.stringify({
      port: bridgePort,
      pid: process.pid,
      token: bridgeToken,
      target: targetGeneration,
      scope: targetScope,
    }),
    { mode: 0o600 },
  );
  chmodSync(BRIDGE_INFO_PATH, 0o600);
}
function invalidateTarget(): void {
  targetGeneration = randomUUID();
  writeDiscovery();
}
export async function handleCdpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${bridgeToken}`);
  if (!bridgeToken || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    jsonResponse(res, 401, { error: 'Browser session authentication required' });
    return;
  }
  if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
    jsonResponse(res, 403, { error: 'Browser-origin requests are not allowed' });
    return;
  }
  if (req.headers['x-anvil-target'] !== targetGeneration) {
    jsonResponse(res, 409, { error: 'Browser target changed. Reconnect the browser MCP session.' });
    return;
  }
  const target = attachedWebContents;
  const generation = targetGeneration;
  const token = bridgeToken;
  const assertCurrent = () => {
    if (
      generation !== targetGeneration ||
      token !== bridgeToken ||
      target !== attachedWebContents ||
      target?.isDestroyed()
    )
      throw new Error('Browser target changed during request');
  };
  try {
    if (req.method === 'GET' && req.url === '/status') {
      assertCurrent();
      jsonResponse(res, 200, { attached: !!target, url: target?.getURL() ?? null });
      return;
    }
    if (!target) {
      jsonResponse(res, 503, { error: 'No browser attached' });
      return;
    }
    if (
      req.method !== 'POST' ||
      !['/cdp', '/evaluate', '/navigate', '/screenshot'].includes(req.url ?? '')
    ) {
      jsonResponse(res, 404, { error: 'Not found' });
      return;
    }
    if (req.url === '/screenshot') {
      const capture = await target.capturePage();
      assertCurrent();
      jsonResponse(res, 200, { data: capture.toPNG().toString('base64'), mimeType: 'image/png' });
      return;
    }
    const body = JSON.parse(await readBody(req));
    assertCurrent();
    let method: string;
    let params: Record<string, unknown>;
    if (req.url === '/cdp') {
      if (typeof body.method !== 'string' || !body.method.trim())
        throw new Error('A CDP method is required');
      if (
        !/^(Page|Runtime|DOM|CSS|Network|Accessibility|Input|Emulation|Performance|Log)\.[A-Za-z]+$/.test(
          body.method,
        )
      )
        throw new Error('Only page-scoped CDP commands are supported');
      method = body.method;
      params = body.params ?? {};
    } else if (req.url === '/evaluate') {
      if (typeof body.expression !== 'string') throw new Error('An expression is required');
      method = 'Runtime.evaluate';
      params = { expression: body.expression, returnByValue: true };
    } else {
      const url = new URL(body.url);
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('Only HTTP and HTTPS navigation is supported');
      method = 'Page.navigate';
      params = { url: url.href };
    }
    const result = await target.debugger.sendCommand(method, params);
    assertCurrent();
    jsonResponse(res, 200, { result });
  } catch (error) {
    jsonResponse(res, 409, { error: error instanceof Error ? error.message : String(error) });
  }
}

let bridgeStartup: Promise<number> | null = null;
let bridgeLifecycle = 0;

/** Start the CDP bridge HTTP server. Returns the port. */
export function startBridge(): Promise<number> {
  if (bridgeServer && bridgePort) return Promise.resolve(bridgePort);

  if (bridgeStartup) return bridgeStartup;
  const lifecycle = ++bridgeLifecycle;
  const startup = new Promise<number>((resolve, reject) => {
    bridgeToken = randomBytes(32).toString('hex');
    const server = createServer((req, res) => {
      void handleCdpRequest(req, res);
    });
    server.requestTimeout = 30_000;
    bridgeServer = server;
    server.listen(0, '127.0.0.1', () => {
      if (lifecycle !== bridgeLifecycle) {
        server.close();
        reject(new Error('Browser bridge startup cancelled'));
        return;
      }
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind bridge server'));
        return;
      }

      bridgeServer = server;
      bridgePort = addr.port;

      // Write bridge info so external MCP server can find it
      try {
        mkdirSync(BRIDGE_INFO_DIR, { recursive: true });
        writeDiscovery();
      } catch (err) {
        console.warn('[Browser] Failed to write bridge info:', err);
      }

      console.log(`[Browser] CDP bridge started on port ${bridgePort}`);
      resolve(bridgePort);
    });

    server.on('error', reject);
  });
  bridgeStartup = startup;
  void startup.then(
    () => {
      if (bridgeStartup === startup) bridgeStartup = null;
    },
    () => {
      if (bridgeStartup === startup) {
        bridgeStartup = null;
        bridgeServer?.close();
        bridgeServer = null;
        bridgeToken = '';
      }
    },
  );
  return startup;
}

/** Stop the CDP bridge. */
export function stopBridge(): void {
  bridgeLifecycle++;
  bridgeStartup = null;
  bridgeToken = '';
  invalidateTarget();
  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = null;
    bridgePort = null;
  }

  try {
    unlinkSync(BRIDGE_INFO_PATH);
  } catch {
    /* ignore */
  }

  try {
    unlinkSync(LEGACY_BRIDGE_INFO_PATH);
  } catch {
    /* ignore */
  }

  detachDebugger();
}

/** Attach the CDP debugger to a webContents (the embedded webview). */
export function attachDebugger(webContents: WebContents): void {
  if (attachedWebContents === webContents) return;

  detachDebugger();

  try {
    webContents.debugger.attach('1.3');
    attachedWebContents = webContents;
    invalidateTarget();
    console.log('[Browser] CDP debugger attached');

    // Enable required CDP domains
    webContents.debugger.sendCommand('Page.enable').catch(() => {});
    webContents.debugger.sendCommand('DOM.enable').catch(() => {});
    webContents.debugger.sendCommand('Runtime.enable').catch(() => {});
    webContents.debugger.sendCommand('Network.enable').catch(() => {});

    webContents.on('destroyed', () => {
      if (attachedWebContents === webContents) {
        attachedWebContents = null;
        invalidateTarget();
      }
    });
  } catch (err) {
    console.warn('[Browser] Failed to attach debugger:', err);
  }
}

/** Detach the CDP debugger. */
export function detachDebugger(): void {
  invalidateTarget();
  if (attachedWebContents) {
    try {
      attachedWebContents.debugger.detach();
    } catch {
      /* already detached */
    }
    attachedWebContents = null;
  }
}

/** Get bridge status. */
export function getBridgeStatus(): BrowserBridgeStatus {
  return {
    running: !!bridgeServer,
    port: bridgePort ?? undefined,
    connectedUrl:
      attachedWebContents && !attachedWebContents.isDestroyed()
        ? attachedWebContents.getURL()
        : undefined,
  };
}

/** Full cleanup on app quit. */
export function cleanupBrowser(): void {
  stopBridge();
  targets.clear();
  seenPorts.clear();
}
