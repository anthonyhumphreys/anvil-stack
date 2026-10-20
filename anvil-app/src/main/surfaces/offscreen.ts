// Offscreen rendering of sketch documents: measure height, screenshot, and
// freeze (serialise the settled DOM, canvases to images). Owned by the
// surface-contract workstream; used by sketches and sharing.
import { BrowserWindow, session, type NativeImage } from 'electron';

export interface OffscreenRenderOptions {
  width: number;
  /** Wait after load before measuring/serialising. */
  settleMs?: number;
  screenshot?: boolean;
  freeze?: boolean;
}

export interface OffscreenRenderResult {
  height: number;
  /** Base64 PNG when `screenshot`. */
  png?: string;
  /** Script-free serialised document when `freeze`. */
  frozenHtml?: string;
}

/** In-memory partition (no `persist:` prefix): nothing survives the app run. */
const PARTITION = 'anvil-sketch-offscreen';
const DEFAULT_SETTLE_MS = 400;
const MAX_TOTAL_MS = 8_000;
const VIEWPORT_HEIGHT = 800;
const MAX_CAPTURE_HEIGHT = 16_384;
/** Chromium caps URLs at 2 MB; larger documents are written into a blank page instead. */
const MAX_DATA_URL_CHARS = 1_900_000;

const MEASURE_SCRIPT = `Math.ceil(Math.max(
  document.documentElement ? document.documentElement.scrollHeight : 0,
  document.body ? document.body.scrollHeight : 0
))`;

const FREEZE_SCRIPT = `(() => {
  for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
    try {
      const img = document.createElement('img');
      img.src = canvas.toDataURL('image/png');
      if (canvas.className) img.className = canvas.className;
      const style = canvas.getAttribute('style');
      if (style) img.setAttribute('style', style);
      img.style.width = canvas.clientWidth + 'px';
      img.style.height = canvas.clientHeight + 'px';
      img.alt = canvas.getAttribute('aria-label') || '';
      canvas.replaceWith(img);
    } catch (_) {}
  }
  document.querySelectorAll('script, iframe, object, embed, meta[http-equiv]').forEach((el) => el.remove());
  for (const el of Array.from(document.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if (/^(href|src|action|formaction|xlink:href)$/.test(name) && /^\\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return '<!doctype html>' + document.documentElement.outerHTML;
})()`;

let queue: Promise<unknown> = Promise.resolve();
let sessionHardened = false;

/** Renders one document at a time so memory stays bounded. */
export async function renderOffscreen(
  document: string,
  options: OffscreenRenderOptions,
): Promise<OffscreenRenderResult> {
  const run = queue.then(() => renderNow(document, options));
  queue = run.catch(() => undefined);
  return run;
}

function hardenSession(): void {
  if (sessionHardened) return;
  const offscreenSession = session.fromPartition(PARTITION);
  offscreenSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(data|blob):/i.test(details.url) });
  });
  offscreenSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  offscreenSession.setPermissionCheckHandler(() => false);
  sessionHardened = true;
}

async function renderNow(
  document: string,
  options: OffscreenRenderOptions,
): Promise<OffscreenRenderResult> {
  hardenSession();
  const width = Math.max(200, Math.min(2_400, Math.round(options.width) || 728));
  const deadline = Date.now() + MAX_TOTAL_MS;
  const win = new BrowserWindow({
    show: false,
    width,
    height: VIEWPORT_HEIGHT,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      partition: PARTITION,
      offscreen: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const { webContents } = win;
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event) => event.preventDefault());
  webContents.on('will-redirect', (event) => event.preventDefault());

  try {
    const encoded = Buffer.from(document, 'utf8').toString('base64');
    if (encoded.length <= MAX_DATA_URL_CHARS) {
      await withDeadline(webContents.loadURL(`data:text/html;base64,${encoded}`), deadline);
    } else {
      await withDeadline(webContents.loadURL('data:text/html;charset=utf-8,'), deadline);
      await withDeadline(
        webContents.executeJavaScript(
          `document.open();document.write(${JSON.stringify(document)});document.close();`,
          true,
        ),
        deadline,
      );
    }
    await delay(Math.min(options.settleMs ?? DEFAULT_SETTLE_MS, remaining(deadline)));
    const measured = Number(
      await withDeadline(webContents.executeJavaScript(MEASURE_SCRIPT, true), deadline),
    );
    const height = Number.isFinite(measured) && measured > 0 ? Math.round(measured) : 1;
    const result: OffscreenRenderResult = { height };

    if (options.screenshot) {
      win.setContentSize(width, Math.min(height, MAX_CAPTURE_HEIGHT));
      await delay(Math.min(80, remaining(deadline)));
      const image = await withDeadline(capture(win), deadline);
      if (!image.isEmpty()) result.png = image.toPNG().toString('base64');
    }
    if (options.freeze) {
      result.frozenHtml = String(
        await withDeadline(webContents.executeJavaScript(FREEZE_SCRIPT, true), deadline),
      );
    }
    return result;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function capture(win: BrowserWindow): Promise<NativeImage> {
  const image = await win.webContents.capturePage();
  if (!image.isEmpty()) return image;
  // Offscreen windows may not have composited yet: take the next paint.
  return new Promise<NativeImage>((resolve) => {
    win.webContents.once('paint', (_event, _dirty, painted) => resolve(painted));
    win.webContents.invalidate();
  });
}

function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const ms = remaining(deadline);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Offscreen render timed out.')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
