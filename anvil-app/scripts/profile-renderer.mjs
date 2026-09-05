import { app, BrowserWindow, ipcMain, session } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// Run with Electron, not Node. Measures the built onboarding renderer with fixed IPC fixtures.
// It deliberately does not start application services or read real settings/credentials.
// Usage: pnpm exec electron scripts/profile-renderer.mjs [out-directory]
const output = resolve(process.argv[2] ?? 'out');
const profile = mkdtempSync(join(tmpdir(), 'anvil-renderer-profile-'));
app.setPath('userData', profile);
const brand = {
  id: 'anvil',
  appName: 'Anvil',
  defaultTheme: 'dark',
  accentColor: '#d58b48',
  accentGlow: '#d58b4833',
  accentGradientEnd: '#b66b34',
};
ipcMain.handle('settings:get', () => ({
  theme: 'dark',
  llmProvider: 'openai',
  cloudFeaturesEnabled: false,
}));
ipcMain.handle('brand:get', () => brand);
ipcMain.handle('launch:get-pending-intent', () => null);

void app
  .whenReady()
  .then(async () => {
    // Keep external font requests and other network variability out of this local fixture.
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );
    const window = new BrowserWindow({
      show: false,
      width: 1400,
      height: 900,
      webPreferences: {
        preload: join(output, 'preload/index.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    const errors = [];
    window.webContents.on('console-message', ({ level, message }) => {
      if (level === 'error' && !message.includes('ERR_BLOCKED_BY_CLIENT')) errors.push(message);
    });
    const started = performance.now();
    try {
      await window.loadFile(join(output, 'renderer/index.html'));
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Role picker did not appear')); }, 10000);
    const check = () => {
      if (document.body.textContent.includes('What best describes your role?')) {
        clearTimeout(timeout); observer.disconnect(); resolve();
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {subtree: true, childList: true}); check();
  })`);
      const readyMs = performance.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const heap = await window.webContents.executeJavaScript('performance.memory.usedJSHeapSize');
      console.log(
        JSON.stringify({
          output,
          readyMs,
          rendererHeapBytes: heap,
          processes: app.getAppMetrics(),
          errors,
        }),
      );
      if (errors.length) process.exitCode = 1;
    } finally {
      window.destroy();
      await session.defaultSession.closeAllConnections();
      rmSync(profile, { recursive: true, force: true });
      app.exit(process.exitCode ?? 0);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
