#!/usr/bin/env node
/**
 * Captures the real Mezair Desktop UI used on the website.
 *
 * Every image is a production component rendered with synthetic fixture
 * content. Nothing here is drawn by the website. Two sources are supported:
 *
 *   replay   The standalone replay harness in mezair-app (no Electron, no IPC):
 *              cd mezair-app && pnpm exec vite --config scripts/chat-replay.vite.config.ts
 *   desktop  The Electron app on an isolated fixture profile with remote debugging:
 *              MEZAIR_DEV_USER_DATA_PATH=/tmp/mezair-capture MEZAIR_DEV_PROCESSING_PREVIEW=1 \
 *                pnpm dev -- --remote-debugging-port=9333
 *            See docs at /docs/project/screenshots for seeding the fixture workspace.
 *
 * Usage: node scripts/capture-screens.mjs [id ...]
 * Env:   CHROME_PATH, MEZAIR_REPLAY_URL (http://127.0.0.1:4179), MEZAIR_DESKTOP_CDP (9333)
 *
 * Writes public/screens/<id>.webp (or .png without cwebp) and public/screens/manifest.json.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'screens');
const replayUrl = process.env.MEZAIR_REPLAY_URL ?? 'http://127.0.0.1:4179';
const desktopPort = Number(process.env.MEZAIR_DESKTOP_CDP ?? 9333);
const chromePath =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** @typedef {{ click?: string, select?: [string, string], eval?: string, wait?: number }} Step */
/**
 * @typedef {object} Capture
 * @property {string} id
 * @property {'replay' | 'desktop'} source
 * @property {string} route      Query string for replay, hash route for desktop
 * @property {[number, number]} viewport
 * @property {string} [selector] Element to clip; whole viewport when absent
 * @property {string} [hasText]  Narrows `selector` to the element containing this text
 * @property {number} [pad]
 * @property {Step[]} [steps]
 * @property {number} [settle]
 * @property {boolean} [transparent] Capture with an alpha background so the panel floats on the page
 * @property {string} fixture    Human description of the fixture behind the capture
 */

/** @type {Capture[]} */
const captures = [
  {
    id: 'desktop-run-complete',
    source: 'desktop',
    route: '#/_dev/processing?showcase',
    viewport: [1440, 900],
    settle: 2500,
    fixture: 'Electron shell, Acme fixture workspace, ProcessingPreview showcase turn',
  },
  {
    id: 'desktop-run-steps',
    source: 'desktop',
    route: '#/_dev/processing?showcase',
    viewport: [1440, 900],
    settle: 2500,
    steps: [{ click: 'Work completed' }, { wait: 800 }],
    fixture: 'Electron shell, Acme fixture workspace, ProcessingPreview showcase turn expanded',
  },
  {
    id: 'factories-line',
    source: 'replay',
    route: '?factories',
    viewport: [1440, 900],
    settle: 2500,
    fixture: 'FactoriesPreview synthetic factory backend',
  },
  {
    id: 'factories-workflows',
    source: 'replay',
    route: '?factories&workflows',
    viewport: [1440, 900],
    settle: 2500,
    fixture: 'FactoriesPreview, Workflows side',
  },
  {
    id: 'mesh-jobs',
    source: 'replay',
    transparent: true,
    route: '?mesh=jobs',
    viewport: [1000, 1000],
    selector: '[data-mesh-capture]',
    pad: 24,
    settle: 6500,
    fixture: 'MeshPreview: Mesh jobs with a watched attempt stream',
  },
  {
    id: 'mesh-approval',
    source: 'replay',
    transparent: true,
    route: '?mesh=approval',
    viewport: [1000, 900],
    selector: '[data-mesh-capture]',
    pad: 24,
    settle: 1800,
    fixture: 'MeshPreview: code-task waiting for a bootstrap approval',
  },
  {
    id: 'mesh-session',
    source: 'replay',
    transparent: true,
    route: '?mesh=session',
    viewport: [900, 700],
    selector: '[data-mesh-capture]',
    pad: 24,
    settle: 1800,
    fixture: 'MeshPreview: session ownership idle with Move open, and mid-handoff',
  },
  {
    id: 'mesh-devices',
    source: 'replay',
    transparent: true,
    route: '?mesh',
    viewport: [1100, 3200],
    selector: 'section',
    hasText: 'Enrolled devices',
    pad: 16,
    settle: 2500,
    fixture: 'MeshPreview: Settings → Sync & Mesh, enrolled devices',
  },
  {
    id: 'mesh-status',
    source: 'replay',
    transparent: true,
    route: '?mesh',
    viewport: [1100, 1400],
    selector: 'section',
    hasText: 'Allow this device to run Mesh jobs',
    pad: 16,
    settle: 2500,
    fixture: 'MeshPreview: Settings → Sync & Mesh connection status',
  },
  ...[
    ['surface-review', 'surface-review-working-tree', 1300, 'Review surface for a working tree'],
    ['surface-findings', 'surface-findings', 850, 'Findings surface from a security audit'],
    ['surface-pipeline', 'surface-pipeline', 800, 'Pipeline surface for a slow CI run'],
    ['surface-dependencies', 'surface-dependencies', 770, 'Dependencies surface with advisories'],
  ].map(([id, scenario, height, fixture]) => ({
    id,
    source: /** @type {const} */ ('replay'),
    route: '',
    viewport: /** @type {[number, number]} */ ([1440, height]),
    selector: 'main section > div.relative',
    settle: 1500,
    steps: [{ select: ['#chat-replay-scenario', scenario] }, { wait: 400 }, { click: 'Show complete' }, { wait: 1500 }],
    fixture: `ChatReplayPreview ${scenario}: ${fixture}`,
  })),
];

class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`Could not connect to ${url}`));
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.waiters = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result);
        return;
      }
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.method !== message.method || waiter.sessionId !== message.sessionId) return true;
        waiter.resolve(message.params);
        return false;
      });
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  once(method, sessionId) {
    return new Promise((resolve) => this.waiters.push({ method, sessionId, resolve }));
  }

  close() {
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchChrome() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mezair-capture-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    'about:blank',
  ]);
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    chrome.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    chrome.on('exit', () => reject(new Error('Chrome exited before DevTools started')));
  });
  return { cdp: await Cdp.connect(url), chrome, profile };
}

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? expression);
  return result.value;
}

const clickByText = (text) => `(() => {
  const nodes = [...document.querySelectorAll('button, [role="button"], a, summary, [aria-expanded]')];
  const node = nodes.find((candidate) => candidate.textContent?.includes(${JSON.stringify(text)}));
  if (!node) throw new Error('No clickable element with text ' + ${JSON.stringify(text)});
  node.click();
  return true;
})()`;

// Sets a controlled <select> the way React expects, then notifies it.
const selectValue = (selector, value) => `(() => {
  const select = document.querySelector(${JSON.stringify(selector)});
  if (!select) throw new Error('No select ' + ${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)});
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

const rectFor = (selector, hasText, pad) => `(() => {
  const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const text = ${JSON.stringify(hasText ?? null)};
  const matches = text ? candidates.filter((node) => node.textContent?.includes(text)) : candidates;
  // Prefer the innermost match so a section heading selects its own section.
  const node = matches.find((candidate) => !matches.some((other) => other !== candidate && candidate.contains(other))) ?? matches[0];
  if (!node) throw new Error('No element for ' + ${JSON.stringify(selector)});
  node.scrollIntoView({ block: 'start' });
  const rect = node.getBoundingClientRect();
  const pad = ${pad ?? 0};
  return { x: Math.max(0, rect.left - pad + window.scrollX), y: Math.max(0, rect.top - pad + window.scrollY), width: rect.width + pad * 2, height: rect.height + pad * 2 };
})()`;

async function shoot(cdp, sessionId, capture) {
  for (const step of capture.steps ?? []) {
    if (step.select) await evaluate(cdp, sessionId, selectValue(...step.select));
    if (step.click) await evaluate(cdp, sessionId, clickByText(step.click));
    if (step.eval) await evaluate(cdp, sessionId, step.eval);
    if (step.wait) await sleep(step.wait);
  }
  const [width, height] = capture.viewport;
  const clip = capture.selector
    ? await evaluate(cdp, sessionId, rectFor(capture.selector, capture.hasText, capture.pad))
    : { x: 0, y: 0, width, height };
  const { data } = await cdp.send(
    'Page.captureScreenshot',
    {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { ...clip, scale: 1 },
    },
    sessionId,
  );
  return { data, clip };
}

async function captureReplay(cdp, capture) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  const [width, height] = capture.viewport;
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile: false },
    sessionId,
  );
  const loaded = cdp.once('Page.loadEventFired', sessionId);
  await cdp.send('Page.navigate', { url: `${replayUrl}/${capture.route}` }, sessionId);
  await loaded;
  await sleep(capture.settle ?? 1500);
  if (capture.transparent) {
    // Panels float on the website's own ground: drop the page and frame backgrounds.
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
    await evaluate(
      cdp,
      sessionId,
      `(() => { const style = document.createElement('style'); style.textContent = 'html, body, #root, [data-capture-frame] { background: transparent !important; }'; document.head.append(style); return true; })()`,
    );
    await sleep(200);
  }
  const result = await shoot(cdp, sessionId, capture);
  await cdp.send('Target.closeTarget', { targetId });
  return result;
}

async function captureDesktop(capture) {
  const version = await fetch(`http://127.0.0.1:${desktopPort}/json/version`).then((response) =>
    response.json(),
  );
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = targetInfos.find(
      (target) => target.type === 'page' && !target.url.startsWith('devtools://'),
    );
    if (!page) throw new Error('No Mezair renderer page found on the desktop CDP port');
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    });
    const [width, height] = capture.viewport;
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 2, mobile: false },
      sessionId,
    );
    await evaluate(
      cdp,
      sessionId,
      `location.hash = ${JSON.stringify(capture.route.replace(/^#/, ''))}; true`,
    );
    await sleep(capture.settle ?? 2000);
    // Fixture switchers are development chrome, not product UI.
    await evaluate(
      cdp,
      sessionId,
      `(() => {
        let style = document.getElementById('capture-style');
        if (!style) { style = document.createElement('style'); style.id = 'capture-style'; document.head.append(style); }
        style.textContent = '[data-fixture-toolbar]{display:none!important} *{caret-color:transparent!important}';
        document.activeElement?.blur?.();
        return true;
      })()`,
    );
    await cdp.send('Page.bringToFront', {}, sessionId);
    await sleep(500);
    const result = await shoot(cdp, sessionId, capture);
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    return result;
  } finally {
    cdp.close();
  }
}

function appCommit() {
  try {
    return execFileSync('git', ['log', '-1', '--format=%h', '--', '../mezair-app'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function hasCwebp() {
  try {
    execFileSync('cwebp', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const only = new Set(process.argv.slice(2));
  const selected = captures.filter((capture) => only.size === 0 || only.has(capture.id));
  await fs.mkdir(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  // A full run rebuilds the manifest; a partial run updates only the named captures.
  const manifest =
    only.size === 0 ? {} : JSON.parse(await fs.readFile(manifestPath, 'utf8').catch(() => '{}'));
  const webp = hasCwebp();
  const commit = appCommit();
  let chrome = null;

  try {
    for (const capture of selected) {
      process.stdout.write(`${capture.id} … `);
      if (capture.source === 'replay' && chrome === null) chrome = await launchChrome();
      const { data, clip } =
        capture.source === 'replay'
          ? await captureReplay(chrome.cdp, capture)
          : await captureDesktop(capture);
      const pngPath = path.join(os.tmpdir(), `${capture.id}.png`);
      await fs.writeFile(pngPath, Buffer.from(data, 'base64'));
      const file = `${capture.id}.${webp ? 'webp' : 'png'}`;
      if (webp) {
        execFileSync('cwebp', ['-quiet', '-q', '90', '-m', '6', pngPath, '-o', path.join(outDir, file)]);
      } else {
        await fs.copyFile(pngPath, path.join(outDir, file));
      }
      manifest[capture.id] = {
        file: `/screens/${file}`,
        width: Math.round(clip.width * 2),
        height: Math.round(clip.height * 2),
        source: capture.source,
        route: capture.route,
        fixture: capture.fixture,
        appCommit: commit,
        capturedAt: new Date().toISOString().slice(0, 10),
      };
      console.log(`${manifest[capture.id].width}×${manifest[capture.id].height}`);
    }
  } finally {
    if (chrome) {
      chrome.cdp.close();
      const exited = new Promise((resolve) => chrome.chrome.once('exit', resolve));
      chrome.chrome.kill();
      await exited;
      await fs.rm(chrome.profile, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
