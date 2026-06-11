import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
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
let connectedUrl: string | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handleCdpRequest(req: IncomingMessage, res: ServerResponse): void {
  // CORS for local tools
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/status') {
    jsonResponse(res, 200, {
      attached: !!attachedWebContents,
      url: connectedUrl,
    });
    return;
  }

  if (req.method === 'POST' && url === '/cdp') {
    if (!attachedWebContents) {
      jsonResponse(res, 503, { error: 'No browser attached' });
      return;
    }

    readBody(req)
      .then((body) => {
        const { method, params } = JSON.parse(body);
        return attachedWebContents!.debugger.sendCommand(method, params);
      })
      .then((result) => jsonResponse(res, 200, { result }))
      .catch((err) => jsonResponse(res, 500, { error: err.message }));
    return;
  }

  if (req.method === 'POST' && url === '/screenshot') {
    if (!attachedWebContents) {
      jsonResponse(res, 503, { error: 'No browser attached' });
      return;
    }

    attachedWebContents
      .capturePage()
      .then((image) => {
        const base64 = image.toPNG().toString('base64');
        jsonResponse(res, 200, { data: base64, mimeType: 'image/png' });
      })
      .catch((err) => jsonResponse(res, 500, { error: err.message }));
    return;
  }

  if (req.method === 'POST' && url === '/evaluate') {
    if (!attachedWebContents) {
      jsonResponse(res, 503, { error: 'No browser attached' });
      return;
    }

    readBody(req)
      .then((body) => {
        const { expression } = JSON.parse(body);
        return attachedWebContents!.debugger.sendCommand('Runtime.evaluate', {
          expression,
          returnByValue: true,
        });
      })
      .then((result) => jsonResponse(res, 200, { result }))
      .catch((err) => jsonResponse(res, 500, { error: err.message }));
    return;
  }

  if (req.method === 'POST' && url === '/navigate') {
    if (!attachedWebContents) {
      jsonResponse(res, 503, { error: 'No browser attached' });
      return;
    }

    readBody(req)
      .then((body) => {
        const { url: targetUrl } = JSON.parse(body);
        return attachedWebContents!.debugger.sendCommand('Page.navigate', { url: targetUrl });
      })
      .then((result) => {
        connectedUrl = result.url ?? connectedUrl;
        jsonResponse(res, 200, { result });
      })
      .catch((err) => jsonResponse(res, 500, { error: err.message }));
    return;
  }

  jsonResponse(res, 404, { error: 'Not found' });
}

/** Start the CDP bridge HTTP server. Returns the port. */
export function startBridge(): Promise<number> {
  if (bridgeServer && bridgePort) return Promise.resolve(bridgePort);

  return new Promise((resolve, reject) => {
    const server = createServer(handleCdpRequest);
    server.listen(0, '127.0.0.1', () => {
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
        writeFileSync(BRIDGE_INFO_PATH, JSON.stringify({ port: bridgePort, pid: process.pid }));
      } catch (err) {
        console.warn('[Browser] Failed to write bridge info:', err);
      }

      console.log(`[Browser] CDP bridge started on port ${bridgePort}`);
      resolve(bridgePort);
    });

    server.on('error', reject);
  });
}

/** Stop the CDP bridge. */
export function stopBridge(): void {
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
    console.log('[Browser] CDP debugger attached');

    // Enable required CDP domains
    webContents.debugger.sendCommand('Page.enable').catch(() => {});
    webContents.debugger.sendCommand('DOM.enable').catch(() => {});
    webContents.debugger.sendCommand('Runtime.enable').catch(() => {});
    webContents.debugger.sendCommand('Network.enable').catch(() => {});

    webContents.on('destroyed', () => {
      if (attachedWebContents === webContents) {
        attachedWebContents = null;
        connectedUrl = null;
      }
    });
  } catch (err) {
    console.warn('[Browser] Failed to attach debugger:', err);
  }
}

/** Detach the CDP debugger. */
export function detachDebugger(): void {
  if (attachedWebContents) {
    try {
      attachedWebContents.debugger.detach();
    } catch {
      /* already detached */
    }
    attachedWebContents = null;
    connectedUrl = null;
  }
}

/** Update the tracked URL when the webview navigates. */
export function setConnectedUrl(url: string): void {
  connectedUrl = url;
}

/** Get bridge status. */
export function getBridgeStatus(): BrowserBridgeStatus {
  return {
    running: !!bridgeServer,
    port: bridgePort ?? undefined,
    connectedUrl: connectedUrl ?? undefined,
  };
}

/** Full cleanup on app quit. */
export function cleanupBrowser(): void {
  stopBridge();
  targets.clear();
  seenPorts.clear();
}
