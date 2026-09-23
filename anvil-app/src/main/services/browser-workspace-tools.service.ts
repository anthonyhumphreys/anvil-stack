import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import type {
  DevServerTarget,
  TerminalAttachResult,
  TerminalSessionSummary,
} from '../../shared/types.js';
import { listTargets } from './browser.service.js';
import { getWorkspace } from './workspace.service.js';
import {
  attachTerminal,
  closeTerminal,
  createTerminal,
  listTerminals,
  resizeTerminal,
  type TerminalCreateOptions,
  getTerminalSpawnEnv,
  writeToTerminal,
} from './terminal.service.js';

/** The browser workspace runtime context is deliberately not an account key. */
export interface BrowserWorkspaceRuntimeContext {
  grantId: string;
  workspaceId: string;
  repoIds: readonly string[];
  scopes: readonly string[];
  /** Epoch milliseconds. The relay must not send an ISO string here. */
  expiresAt: number;
}

interface BrowserWorkspaceRequestBase {
  context: BrowserWorkspaceRuntimeContext;
  /** The repository must appear in context.repoIds. */
  repoId: string;
}

export type BrowserWorkspaceTerminalRequest =
  | ({ type: 'terminal.create' } & BrowserWorkspaceRequestBase)
  | ({
      type: 'terminal.read';
      terminalId: string;
      afterSequence?: number;
    } & BrowserWorkspaceRequestBase)
  | ({ type: 'terminal.write'; terminalId: string; data: string } & BrowserWorkspaceRequestBase)
  | ({
      type: 'terminal.resize';
      terminalId: string;
      cols: number;
      rows: number;
    } & BrowserWorkspaceRequestBase)
  | ({ type: 'terminal.close'; terminalId: string } & BrowserWorkspaceRequestBase);

type BrowserWorkspaceOwnedTerminalRequest = Exclude<
  BrowserWorkspaceTerminalRequest,
  { type: 'terminal.create' }
>;

export type BrowserWorkspacePreviewRequest = {
  type: 'preview.screenshot';
  context: BrowserWorkspaceRuntimeContext;
  repoId: string;
  /** A refresh asks the authenticated Desktop renderer for a new frame. */
  refresh?: boolean;
};

export type BrowserWorkspaceToolRequest =
  | BrowserWorkspaceTerminalRequest
  | BrowserWorkspacePreviewRequest;

export type BrowserWorkspaceToolResult =
  | { type: 'terminal.created'; terminal: TerminalSessionSummary }
  | { type: 'terminal.read'; terminal: BrowserWorkspaceTerminalReadResult }
  | { type: 'terminal.written'; terminalId: string; acceptedChars: number }
  | { type: 'terminal.resized'; terminalId: string; cols: number; rows: number }
  | { type: 'terminal.closed'; terminalId: string }
  | {
      type: 'preview.screenshot.result';
      status: 'available';
      mimeType: 'image/png';
      data: string;
      capturedAt: number;
    }
  | {
      type: 'preview.screenshot.result';
      status: 'unavailable';
      reason:
        | 'repo-dev-server-not-found'
        | 'desktop-preview-capture-not-configured'
        | 'desktop-preview-blocked';
    };

export const BROWSER_TERMINAL_MAX_COUNT_PER_GRANT = 4;
export const BROWSER_TERMINAL_MAX_COUNT_TOTAL = 32;
export const BROWSER_TERMINAL_MAX_INPUT_CHARS = 16_384;
// Keep the relay payload below a 256 KiB encrypted-envelope ceiling after
// base64 expansion and framing overhead.
export const BROWSER_TERMINAL_MAX_READ_BYTES = 128_000;
/** Compatibility name for callers that express terminal limits in chars. */
export const BROWSER_TERMINAL_MAX_READ_CHARS = BROWSER_TERMINAL_MAX_READ_BYTES;
export const BROWSER_TERMINAL_MAX_READ_CHUNKS = 2_048;
// The relay's result plaintext ceiling includes the terminal summary, chunk
// metadata, JSON escaping, and the surrounding tool result. Leave a small
// allowance for the encrypted command wrapper owned by the relay.
export const BROWSER_TERMINAL_MAX_READ_SERIALIZED_BYTES = 256 * 1024;
const BROWSER_TERMINAL_READ_WRAPPER_RESERVE_BYTES = 4 * 1024;
const BROWSER_TERMINAL_READ_PAYLOAD_BYTES =
  BROWSER_TERMINAL_MAX_READ_SERIALIZED_BYTES - BROWSER_TERMINAL_READ_WRAPPER_RESERVE_BYTES;
export const BROWSER_TERMINAL_MAX_COLUMNS = 400;
export const BROWSER_TERMINAL_MAX_ROWS = 200;
// Screenshot bytes are also returned inline, so leave room for base64 and
// envelope framing inside the same bounded relay payload.
export const BROWSER_PREVIEW_MAX_IMAGE_BYTES = 180_000;
export const BROWSER_PREVIEW_LOAD_TIMEOUT_MS = 10_000;

export interface BrowserWorkspaceTerminalAdapter {
  create(
    workspaceId: string,
    repoId: string,
    cwd: string,
    options?: TerminalCreateOptions,
  ): TerminalSessionSummary;
  read(terminalId: string, afterSequence?: number): TerminalAttachResult;
  write(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
}

export interface BrowserWorkspaceTerminalReadResult extends TerminalAttachResult {
  /** True when the result omits older output because a relay bound was hit. */
  truncated: boolean;
  /** Sequence of the first omitted chunk, when `truncated` is true. */
  droppedBeforeSequence?: number;
}

export interface BrowserWorkspacePreviewCapture {
  /** Base64-encoded PNG bytes. HTML, URLs, and arbitrary response bodies are not accepted. */
  data: string;
  capturedAt?: number;
}

export type BrowserWorkspacePreviewCaptureResult =
  | BrowserWorkspacePreviewCapture
  | {
      unavailable:
        | 'repo-dev-server-not-found'
        | 'desktop-preview-capture-not-configured'
        | 'desktop-preview-blocked';
    };

interface PreviewWindow {
  webContents: PreviewWebContents;
  loadURL(url: string): Promise<void>;
  /** Electron's destroy bypasses an untrusted page's beforeunload handler. */
  destroy?(): void;
  close(): void;
}

interface PreviewWebContents {
  session: PreviewSession;
  once(event: string, listener: (...args: unknown[]) => void): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  capturePage(): Promise<{ toPNG(): Buffer }>;
}

interface PreviewSession {
  /** Avoid inheriting the Desktop browser's authenticated proxy configuration. */
  setProxy?(config: { mode: 'direct' }): Promise<void>;
  /** The preview is not a browser: every permission request is refused. */
  setPermissionRequestHandler?(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler?(
    handler: (
      webContents: unknown,
      permission: string,
      requestingOrigin: string,
      details: unknown,
    ) => boolean,
  ): void;
  setDevicePermissionHandler?(handler: (details: unknown) => boolean): void;
  /** Callback receives the granted streams; `{video:false, audio:false}` denies. */
  setDisplayMediaRequestHandler?(
    handler: (request: unknown, callback: (streams: Record<string, unknown>) => void) => void,
  ): void;
  /** Fail closed on TLS: certificate chains are never trusted for a preview. */
  setCertificateVerifyProc?(
    proc: (request: unknown, callback: (verificationResult: number) => void) => void,
  ): void;
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: (
        details: { url: string; resourceType?: string },
        callback: (result: { cancel: boolean }) => void,
      ) => void,
    ): void;
    onBeforeSendHeaders(
      filter: { urls: string[] },
      listener: (
        details: { requestHeaders: Record<string, string> },
        callback: (result: { requestHeaders: Record<string, string> }) => void,
      ) => void,
    ): void;
  };
  on(event: 'will-download', listener: (...args: unknown[]) => void): void;
}

export interface BrowserWorkspacePreviewCaptureOptions {
  listTargets?: () => DevServerTarget[];
  listTerminals?: (workspaceId: string) => TerminalSessionSummary[];
  createWindow?: (options: {
    width: number;
    height: number;
    show: false;
    webPreferences: {
      sandbox: true;
      contextIsolation: true;
      nodeIntegration: false;
      webSecurity: true;
      webviewTag: false;
      devTools: false;
      partition: string;
    };
  }) => Promise<PreviewWindow> | PreviewWindow;
  loadTimeoutMs?: number;
}

export interface BrowserWorkspaceToolsOptions {
  /** Desktop-owned repo lookup. The browser never supplies a cwd/path. */
  resolveRepoCwd: (workspaceId: string, repoId: string) => string | undefined;
  terminal?: Partial<BrowserWorkspaceTerminalAdapter>;
  /**
   * Optional replacement for the authenticated Desktop renderer capture. No
   * URL/proxy callback is accepted. The default capture is the repo-bound,
   * isolated screenshot adapter below; callers can inject this only to supply
   * an equally bounded implementation in tests or a platform-specific shell.
   */
  capturePreview?: (input: {
    context: BrowserWorkspaceRuntimeContext;
    repoId: string;
    refresh: boolean;
  }) => Promise<BrowserWorkspacePreviewCaptureResult>;
  now?: () => number;
}

export interface BrowserWorkspaceTools {
  /**
   * Terminal output is raw Desktop-user shell output; no secret-filtering or
   * filesystem sandbox guarantee is made by this service.
   */
  execute(request: BrowserWorkspaceToolRequest): Promise<BrowserWorkspaceToolResult>;
  /** Close all PTYs owned by a grant when the grant is revoked or expires. */
  revokeGrant(grantId: string): void;
  /** Test/app-shutdown cleanup for all browser-owned PTYs. */
  dispose(): void;
  getDiagnostics(): { activeTerminals: number; grants: number };
}

interface OwnedTerminal {
  grantId: string;
  workspaceId: string;
  repoId: string;
  terminalId: string;
  expiryTimer: ReturnType<typeof setTimeout>;
}

const defaultTerminal: BrowserWorkspaceTerminalAdapter = {
  create: createTerminal,
  read: attachTerminal,
  write: writeToTerminal,
  resize: resizeTerminal,
  close: closeTerminal,
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
// Catch file:, data:, and other non-network navigations as well as HTTP(S).
const PREVIEW_NETWORK_FILTER = { urls: ['<all_urls>'] };

function previewUrl(target: DevServerTarget): URL | null {
  if (target.terminalId === undefined || target.terminalId.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(target.url);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || port !== target.port) return null;
  return parsed;
}

function allowedPreviewUrl(value: string, allowedOrigin: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.origin === allowedOrigin && ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

async function defaultPreviewWindow(options: {
  width: number;
  height: number;
  show: false;
  webPreferences: {
    sandbox: true;
    contextIsolation: true;
    nodeIntegration: false;
    webSecurity: true;
    webviewTag: false;
    devTools: false;
    partition: string;
  };
}): Promise<PreviewWindow> {
  const { BrowserWindow } = await import('electron');
  return new BrowserWindow(options) as unknown as PreviewWindow;
}

/**
 * Capture an approved repository's already-running localhost dev server.
 * Targets are accepted only when their terminal belongs to the requested
 * workspace/repository; the page is loaded in a fresh, non-persistent,
 * sandboxed window and only same-origin loopback requests are allowed.
 */
export function createDesktopRepoPreviewCapture(
  options: BrowserWorkspacePreviewCaptureOptions = {},
): (input: {
  context: BrowserWorkspaceRuntimeContext;
  repoId: string;
  refresh: boolean;
}) => Promise<BrowserWorkspacePreviewCaptureResult> {
  const getTargets = options.listTargets ?? listTargets;
  const getTerminals = options.listTerminals ?? listTerminals;
  const createWindow = options.createWindow ?? defaultPreviewWindow;
  const timeoutMs =
    options.loadTimeoutMs !== undefined && Number.isFinite(options.loadTimeoutMs)
      ? Math.min(Math.max(1, options.loadTimeoutMs), BROWSER_PREVIEW_LOAD_TIMEOUT_MS)
      : BROWSER_PREVIEW_LOAD_TIMEOUT_MS;

  return async ({ context, repoId }): Promise<BrowserWorkspacePreviewCaptureResult> => {
    const terminals = getTerminals(context.workspaceId);
    const terminalIds = new Set(
      terminals
        .filter(
          (terminal) =>
            terminal.workspaceId === context.workspaceId &&
            terminal.repoId === repoId &&
            terminal.status === 'running',
        )
        .map((terminal) => terminal.terminalId),
    );
    const target = getTargets().find(
      (candidate) => candidate.terminalId !== undefined && terminalIds.has(candidate.terminalId),
    );
    if (!target) return { unavailable: 'repo-dev-server-not-found' };

    const parsedTarget = previewUrl(target);
    if (parsedTarget === null) return { unavailable: 'desktop-preview-blocked' };

    const previewWindow = await createWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
        partition: `preview-${randomUUID()}`,
      },
    });
    const webContents = previewWindow.webContents;
    const session = webContents.session;
    const allowedOrigin = parsedTarget.origin;
    let blockedReason:
      | 'navigation'
      | 'request'
      | 'download'
      | 'window-open'
      | 'auth'
      | 'certificate'
      | null = null;

    // The preview is a screenshot, not a browser: deny every privileged
    // surface the loaded page could reach for and fail closed on TLS or
    // HTTP-auth challenges instead of delegating trust to the target origin.
    session.setPermissionRequestHandler?.((_wc, _permission, callback) => callback(false));
    session.setPermissionCheckHandler?.(() => false);
    session.setDevicePermissionHandler?.(() => false);
    session.setDisplayMediaRequestHandler?.((_request, callback) =>
      callback({ video: false, audio: false }),
    );
    session.setCertificateVerifyProc?.((_request, callback) => {
      blockedReason ??= 'certificate';
      callback(-2);
    });
    webContents.on('login', (...args: unknown[]) => {
      const event = args[0] as { preventDefault(): void };
      event.preventDefault();
      blockedReason ??= 'auth';
    });

    session.webRequest.onBeforeRequest(PREVIEW_NETWORK_FILTER, (details, callback) => {
      if (allowedPreviewUrl(details.url, allowedOrigin)) {
        callback({ cancel: false });
        return;
      }
      // Optional subresources (trackers, external fonts) are cancelled but do
      // not invalidate an otherwise valid same-origin frame. A blocked
      // main-frame request is a navigation attempt and fails closed.
      if (details.resourceType === 'mainFrame') blockedReason ??= 'request';
      callback({ cancel: true });
    });
    session.webRequest.onBeforeSendHeaders(PREVIEW_NETWORK_FILTER, (details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      for (const name of Object.keys(requestHeaders)) {
        if (['cookie', 'authorization', 'proxy-authorization'].includes(name.toLowerCase())) {
          delete requestHeaders[name];
        }
      }
      callback({ requestHeaders });
    });
    webContents.on('will-navigate', (...args: unknown[]) => {
      const event = args[0] as { preventDefault(): void };
      const url = String(args[1] ?? '');
      if (!allowedPreviewUrl(url, allowedOrigin)) {
        event.preventDefault();
        blockedReason ??= 'navigation';
      }
    });
    webContents.on('will-redirect', (...args: unknown[]) => {
      const event = args[0] as { preventDefault(): void };
      const url = String(args[1] ?? '');
      if (!allowedPreviewUrl(url, allowedOrigin)) {
        event.preventDefault();
        blockedReason ??= 'navigation';
      }
    });
    webContents.setWindowOpenHandler(() => {
      blockedReason ??= 'window-open';
      return { action: 'deny' };
    });
    session.on('will-download', (...args: unknown[]) => {
      blockedReason ??= 'download';
      const item = args[1] as { cancel?: () => void } | undefined;
      item?.cancel?.();
    });

    try {
      await session.setProxy?.({ mode: 'direct' });
      // One deadline covers navigation, load, and capturePage: a hung capture
      // must not leak the hidden window past the command's expiry.
      const png = await new Promise<Buffer>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, png?: Buffer): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error !== undefined) reject(error);
          else resolve(png as Buffer);
        };
        const timer = setTimeout(() => finish(new Error('Desktop preview timed out')), timeoutMs);
        webContents.once('did-finish-load', () => {
          if (blockedReason !== null) {
            finish(new Error('Desktop preview attempted a blocked navigation or request'));
            return;
          }
          webContents.capturePage().then(
            (image) => finish(undefined, image.toPNG()),
            (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
          );
        });
        webContents.once('did-fail-load', (...args: unknown[]) => {
          const isMainFrame = args[4];
          if (isMainFrame === false) return;
          finish(
            new Error(`Desktop preview failed to load: ${String(args[2] ?? 'unknown error')}`),
          );
        });
        void previewWindow
          .loadURL(parsedTarget.href)
          .catch((error: unknown) =>
            finish(error instanceof Error ? error : new Error(String(error))),
          );
      });
      if (blockedReason !== null) return { unavailable: 'desktop-preview-blocked' };
      if (png.byteLength > BROWSER_PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error('Desktop preview screenshot exceeds the relay size limit');
      }
      return { data: png.toString('base64'), capturedAt: Date.now() };
    } catch (error) {
      if (blockedReason !== null) return { unavailable: 'desktop-preview-blocked' };
      throw error;
    } finally {
      try {
        if (previewWindow.destroy) previewWindow.destroy();
        else previewWindow.close();
      } catch {
        /* the hidden preview may already be destroyed */
      }
    }
  };
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`);
}

function assertRuntimeContext(
  context: BrowserWorkspaceRuntimeContext,
  now: number,
  scope: 'terminal' | 'preview',
): void {
  requireNonEmpty(context.grantId, 'grantId');
  requireNonEmpty(context.workspaceId, 'workspaceId');
  if (
    !Array.isArray(context.repoIds) ||
    !context.repoIds.every((repoId) => typeof repoId === 'string')
  ) {
    throw new Error('repoIds must be an array of repository IDs');
  }
  if (
    !Array.isArray(context.scopes) ||
    !context.scopes.every((value) => typeof value === 'string')
  ) {
    throw new Error('scopes must be an array of strings');
  }
  if (!Number.isFinite(context.expiresAt)) throw new Error('expiresAt must be epoch milliseconds');
  if (context.expiresAt <= now) throw new Error('Browser grant has expired');
  if (!context.scopes.includes(scope)) throw new Error(`Browser grant lacks the ${scope} scope`);
}

function assertRepoBinding(
  request: BrowserWorkspaceRequestBase | BrowserWorkspacePreviewRequest,
): void {
  requireNonEmpty(request.repoId, 'repoId');
  if (!request.context.repoIds.includes(request.repoId)) {
    throw new Error(`Repository is not approved by grant: ${request.repoId}`);
  }
}

function assertSequence(afterSequence: number | undefined): void {
  if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
    throw new Error('afterSequence must be a non-negative safe integer');
  }
}

function assertResizeDimension(value: number, label: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}`);
  }
}

function isBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}

function isPngBase64(value: string): boolean {
  // Reject oversized encoded data before allocating a decoded Buffer.
  if (value.length > Math.ceil(BROWSER_PREVIEW_MAX_IMAGE_BYTES / 3) * 4) return false;
  if (!isBase64(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length * 3) / 4 - padding;
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let suffix = bytes.subarray(bytes.byteLength - maxBytes);
  while (suffix.length > 0 && (suffix[0] & 0xc0) === 0x80) suffix = suffix.subarray(1);
  return suffix.toString('utf8');
}

function serializedReadResultBytes(
  result: TerminalAttachResult,
  output: TerminalAttachResult['output'],
  truncated: boolean,
  droppedBeforeSequence: number | undefined,
): number {
  const terminal: BrowserWorkspaceTerminalReadResult = {
    ...result,
    output,
    truncated,
    ...(droppedBeforeSequence === undefined ? {} : { droppedBeforeSequence }),
  };
  return Buffer.byteLength(JSON.stringify({ type: 'terminal.read', terminal }), 'utf8');
}

function boundReadResult(result: TerminalAttachResult): BrowserWorkspaceTerminalReadResult {
  const output: typeof result.output = [];
  let bytes = 0;
  let truncated = false;
  let droppedBeforeSequence: number | undefined;

  for (let index = result.output.length - 1; index >= 0; index -= 1) {
    if (output.length >= BROWSER_TERMINAL_MAX_READ_CHUNKS) {
      truncated = true;
      droppedBeforeSequence = result.output[index].sequence;
      break;
    }

    const chunk = result.output[index];
    const remaining = BROWSER_TERMINAL_MAX_READ_BYTES - bytes;
    if (remaining <= 0) {
      truncated = true;
      droppedBeforeSequence = chunk.sequence;
      break;
    }

    let data = takeUtf8Suffix(chunk.data, remaining);
    const candidate = (): { truncated: boolean; droppedBeforeSequence?: number } => ({
      truncated: index > 0 || data.length < chunk.data.length,
      ...(index > 0 || data.length < chunk.data.length
        ? { droppedBeforeSequence: chunk.sequence }
        : {}),
    });
    let state = candidate();

    // JSON escaping can make control-heavy terminal output much larger than
    // its UTF-8 byte count. Fit the actual serialized result, not just raw
    // terminal bytes, and retain the newest suffix when a chunk is partial.
    if (
      serializedReadResultBytes(
        result,
        [...output, { ...chunk, data }],
        state.truncated,
        state.droppedBeforeSequence,
      ) > BROWSER_TERMINAL_READ_PAYLOAD_BYTES
    ) {
      let low = 0;
      let high = Buffer.byteLength(data, 'utf8');
      let best = '';
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidateData = takeUtf8Suffix(data, middle);
        const candidateState = {
          truncated: true,
          droppedBeforeSequence: chunk.sequence,
        };
        const size = serializedReadResultBytes(
          result,
          [...output, { ...chunk, data: candidateData }],
          candidateState.truncated,
          candidateState.droppedBeforeSequence,
        );
        if (size <= BROWSER_TERMINAL_READ_PAYLOAD_BYTES) {
          best = candidateData;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      data = best;
      state = { truncated: true, droppedBeforeSequence: chunk.sequence };
      if (data === '') {
        truncated = true;
        droppedBeforeSequence = chunk.sequence;
        break;
      }
    }

    output.push({ ...chunk, data });
    bytes += Buffer.byteLength(data, 'utf8');
    if (state.truncated) {
      truncated = true;
      droppedBeforeSequence = state.droppedBeforeSequence;
      break;
    }
  }

  output.reverse();
  return {
    ...result,
    output,
    truncated,
    ...(droppedBeforeSequence === undefined ? {} : { droppedBeforeSequence }),
  };
}

/**
 * Grant-bound Desktop tools for the browser workspace.
 *
 * This service intentionally has no arbitrary URL fetcher or HTML relay.
 * Preview capture loads only an already-discovered, repo-bound loopback dev
 * target in an isolated window and returns a bounded PNG screenshot.
 */
export function createBrowserWorkspaceTools(
  options: BrowserWorkspaceToolsOptions,
): BrowserWorkspaceTools {
  const now = options.now ?? Date.now;
  const terminal: BrowserWorkspaceTerminalAdapter = {
    ...defaultTerminal,
    ...options.terminal,
  };
  const capturePreview = options.capturePreview ?? createDesktopRepoPreviewCapture();
  const owned = new Map<string, OwnedTerminal>();

  const clearOwned = (entry: OwnedTerminal, close: boolean): void => {
    if (owned.get(entry.terminalId) !== entry) return;
    owned.delete(entry.terminalId);
    clearTimeout(entry.expiryTimer);
    if (close) {
      try {
        terminal.close(entry.terminalId);
      } catch {
        // Revocation/expiry is best-effort after ownership has been removed.
      }
    }
  };

  const revokeGrant = (grantId: string): void => {
    for (const entry of [...owned.values()]) {
      if (entry.grantId === grantId) clearOwned(entry, true);
    }
  };

  const ensureRequest = (
    request: BrowserWorkspaceRequestBase | BrowserWorkspacePreviewRequest,
    scope: 'terminal' | 'preview',
  ): void => {
    if (Number.isFinite(request.context.expiresAt) && request.context.expiresAt <= now()) {
      revokeGrant(request.context.grantId);
    }
    assertRuntimeContext(request.context, now(), scope);
    assertRepoBinding(request);
  };

  const findOwned = (request: BrowserWorkspaceOwnedTerminalRequest): OwnedTerminal => {
    const entry = owned.get(request.terminalId);
    if (
      !entry ||
      entry.grantId !== request.context.grantId ||
      entry.workspaceId !== request.context.workspaceId ||
      entry.repoId !== request.repoId
    ) {
      throw new Error('Terminal session is not owned by this browser grant');
    }
    return entry;
  };

  const execute = async (
    request: BrowserWorkspaceToolRequest,
  ): Promise<BrowserWorkspaceToolResult> => {
    ensureRequest(request, request.type === 'preview.screenshot' ? 'preview' : 'terminal');

    if (request.type === 'preview.screenshot') {
      const capture = await capturePreview({
        context: request.context,
        repoId: request.repoId,
        refresh: request.refresh === true,
      });
      if ('unavailable' in capture) {
        return {
          type: 'preview.screenshot.result',
          status: 'unavailable',
          reason: capture.unavailable,
        };
      }
      const capturedAt = capture.capturedAt ?? now();
      if (
        typeof capture.data !== 'string' ||
        !isPngBase64(capture.data) ||
        base64ByteLength(capture.data) > BROWSER_PREVIEW_MAX_IMAGE_BYTES ||
        !Number.isFinite(capturedAt)
      ) {
        throw new Error('Desktop preview capture must be a bounded base64 PNG');
      }
      return {
        type: 'preview.screenshot.result',
        status: 'available',
        mimeType: 'image/png',
        data: capture.data,
        capturedAt,
      };
    }

    if (request.type === 'terminal.create') {
      const existing = [...owned.values()].find(
        (entry) =>
          entry.grantId === request.context.grantId &&
          entry.workspaceId === request.context.workspaceId &&
          entry.repoId === request.repoId,
      );
      if (existing) {
        return { type: 'terminal.created', terminal: terminal.read(existing.terminalId).session };
      }
      const grantCount = [...owned.values()].filter(
        (entry) => entry.grantId === request.context.grantId,
      ).length;
      if (grantCount >= BROWSER_TERMINAL_MAX_COUNT_PER_GRANT) {
        throw new Error('Browser grant terminal limit reached');
      }
      if (owned.size >= BROWSER_TERMINAL_MAX_COUNT_TOTAL) {
        throw new Error('Desktop browser terminal limit reached');
      }
      const cwd = options.resolveRepoCwd(request.context.workspaceId, request.repoId);
      if (typeof cwd !== 'string' || cwd.trim() === '') {
        throw new Error(`Approved repository has no usable working directory: ${request.repoId}`);
      }
      const sessionKey = `browser-${request.context.grantId}`;
      const session = terminal.create(request.context.workspaceId, request.repoId, cwd, {
        sessionKey,
        env: getTerminalSpawnEnv(),
      });
      const entry: OwnedTerminal = {
        grantId: request.context.grantId,
        workspaceId: request.context.workspaceId,
        repoId: request.repoId,
        terminalId: session.terminalId,
        expiryTimer: setTimeout(
          () => {
            clearOwned(entry, true);
          },
          Math.min(Math.max(1, request.context.expiresAt - now()), 2_147_483_647),
        ),
      };
      entry.expiryTimer.unref?.();
      owned.set(session.terminalId, entry);
      return { type: 'terminal.created', terminal: session };
    }

    const entry = findOwned(request);
    if (request.type === 'terminal.read') {
      assertSequence(request.afterSequence);
      return {
        type: 'terminal.read',
        terminal: boundReadResult(terminal.read(entry.terminalId, request.afterSequence)),
      };
    }
    if (request.type === 'terminal.write') {
      if (
        typeof request.data !== 'string' ||
        request.data.length > BROWSER_TERMINAL_MAX_INPUT_CHARS
      ) {
        throw new Error(`Terminal input exceeds ${BROWSER_TERMINAL_MAX_INPUT_CHARS} characters`);
      }
      terminal.write(entry.terminalId, request.data);
      return {
        type: 'terminal.written',
        terminalId: entry.terminalId,
        acceptedChars: request.data.length,
      };
    }
    if (request.type === 'terminal.resize') {
      assertResizeDimension(request.cols, 'cols', BROWSER_TERMINAL_MAX_COLUMNS);
      assertResizeDimension(request.rows, 'rows', BROWSER_TERMINAL_MAX_ROWS);
      terminal.resize(entry.terminalId, request.cols, request.rows);
      return {
        type: 'terminal.resized',
        terminalId: entry.terminalId,
        cols: request.cols,
        rows: request.rows,
      };
    }

    clearOwned(entry, true);
    return { type: 'terminal.closed', terminalId: request.terminalId };
  };

  return {
    execute,
    revokeGrant,
    dispose: () => {
      for (const entry of [...owned.values()]) clearOwned(entry, true);
    },
    getDiagnostics: () => ({
      activeTerminals: owned.size,
      grants: new Set([...owned.values()].map((entry) => entry.grantId)).size,
    }),
  };
}

/**
 * Resolve a repo's working directory from Desktop-owned workspace state. The
 * browser supplies only the repoId; it can never choose a cwd/path.
 */
function resolveWorkspaceRepoCwd(workspaceId: string, repoId: string): string | undefined {
  try {
    const repo = getWorkspace(workspaceId).repos.find((candidate) => candidate.id === repoId);
    if (repo === undefined) return undefined;
    const root = realpathSync(repo.path);
    return lstatSync(root).isDirectory() ? root : undefined;
  } catch {
    return undefined;
  }
}

let sharedTools: BrowserWorkspaceTools | null = null;

/**
 * The tools instance bound to the real Desktop runtime. The command executor
 * and the grant lifecycle must share it so grant revocation and shutdown
 * actually close the PTYs a browser created.
 */
export function getSharedBrowserWorkspaceTools(): BrowserWorkspaceTools {
  sharedTools ??= createBrowserWorkspaceTools({ resolveRepoCwd: resolveWorkspaceRepoCwd });
  return sharedTools;
}

/** Close every browser-owned PTY for a grant; safe before the runtime starts. */
export function revokeSharedBrowserWorkspaceGrant(grantId: string): void {
  sharedTools?.revokeGrant(grantId);
}

export function disposeSharedBrowserWorkspaceTools(): void {
  sharedTools?.dispose();
  sharedTools = null;
}
