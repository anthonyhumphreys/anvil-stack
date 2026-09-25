/**
 * Minimal `electron` module replacement for the headless daemon build.
 * Bundled via `--alias:electron=.../electron-stub.ts`; provides just the
 * surface the host services import: data-dir resolution, a file-backed
 * safeStorage, and inert window/shell stubs. Anything genuinely
 * UI-dependent (BrowserWindow instances, dialogs, tray) is absent by
 * design — daemon code paths must not reach for it.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = process.env.ANVIL_DATA_DIR ?? join(homedir(), '.anvil-daemon');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

export const app = {
  getPath(name: string): string {
    switch (name) {
      case 'userData':
        return dataDir;
      case 'home':
        return homedir();
      case 'temp':
        return tmpdir();
      default:
        return join(dataDir, name);
    }
  },
  getVersion(): string {
    return process.env.ANVIL_VERSION ?? '0.0.0-daemon';
  },
  getName(): string {
    return 'anvil-daemon';
  },
  getAppPath(): string {
    return process.cwd();
  },
  getLocale(): string {
    return 'en-US';
  },
  isPackaged: true,
  isReady(): boolean {
    return true;
  },
  whenReady(): Promise<void> {
    return Promise.resolve();
  },
  on(): void {},
  once(): void {},
  quit(): void {
    process.exit(0);
  },
  exit(code = 0): void {
    process.exit(code);
  },
  setAsDefaultProtocolClient(): boolean {
    return false;
  },
  requestSingleInstanceLock(): boolean {
    return true;
  },
  setLoginItemSettings(): void {},
  getLoginItemSettings(): { openAtLogin: boolean } {
    return { openAtLogin: false };
  },
};

// File-backed safeStorage: AES-256-GCM with a locally generated master key
// stored 0600 alongside the data dir. Equivalent trust boundary to ssh
// key files — possession of the data dir is possession of the secrets.
const KEY_PATH = join(dataDir, '.daemon-key');
const ENC_VERSION = 'v1';

function masterKey(): Buffer {
  if (!existsSync(KEY_PATH)) {
    const key = randomBytes(32);
    writeFileSync(KEY_PATH, key, { mode: 0o600 });
    chmodSync(KEY_PATH, 0o600);
    return key;
  }
  return readFileSync(KEY_PATH);
}

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return true;
  },
  encryptString(plainText: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from(ENC_VERSION), iv, tag, ciphertext]);
  },
  decryptString(encrypted: Buffer): string {
    const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
    const version = buf.subarray(0, 2).toString('utf8');
    if (version !== ENC_VERSION) throw new Error('unsupported secret encoding');
    const iv = buf.subarray(2, 14);
    const tag = buf.subarray(14, 30);
    const ciphertext = buf.subarray(30);
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  },
};

export const BrowserWindow = {
  getAllWindows(): [] {
    return [];
  },
  fromWebContents(): null {
    return null;
  },
  getFocusedWindow(): null {
    return null;
  },
};

export const shell = {
  openExternal(url: string): Promise<void> {
    console.log(`[anvil-daemon] openExternal requested (headless): ${url}`);
    return Promise.resolve();
  },
  openPath(): Promise<string> {
    return Promise.resolve('');
  },
  showItemInFolder(): void {},
  trashItem(): Promise<void> {
    return Promise.resolve();
  },
};

export const ipcMain = {
  handle(): void {},
  on(): void {},
  once(): void {},
  removeHandler(): void {},
  removeAllListeners(): void {},
};

export const ipcRenderer = {
  invoke(): Promise<never> {
    return Promise.reject(new Error('ipcRenderer unavailable in daemon'));
  },
  on(): void {},
  send(): void {},
};

export const powerMonitor = {
  on(): void {},
  getSystemIdleTime(): number {
    return 0;
  },
};

export const nativeTheme = {
  shouldUseDarkColors: false,
  on(): void {},
};

export const Notification = {
  isSupported(): boolean {
    return false;
  },
};

export const dialog = {
  showOpenDialog(): Promise<{ canceled: true; filePaths: [] }> {
    return Promise.resolve({ canceled: true, filePaths: [] });
  },
  showMessageBox(): Promise<{ response: number }> {
    return Promise.resolve({ response: 0 });
  },
};

export const net = { fetch };

export const session = {
  defaultSession: {
    webRequest: { onBeforeSendHeaders(): void {}, onHeadersReceived(): void {} },
    setPermissionRequestHandler(): void {},
    clearCache(): Promise<void> {
      return Promise.resolve();
    },
  },
  fromPartition(): typeof session.defaultSession {
    return session.defaultSession;
  },
};

export const screen = {
  getPrimaryDisplay(): { workAreaSize: { width: number; height: number } } {
    return { workAreaSize: { width: 1920, height: 1080 } };
  },
  on(): void {},
};

export const Menu = {
  setApplicationMenu(): void {},
  buildFromTemplate(): unknown {
    return {};
  },
};

export const Tray = class {
  setToolTip(): void {}
  setContextMenu(): void {}
  on(): void {}
  destroy(): void {}
};

export const globalShortcut = {
  register(): boolean {
    return false;
  },
  unregisterAll(): void {},
};
export const clipboard = {
  readText(): string {
    return '';
  },
  writeText(): void {},
};
export const systemPreferences = {
  getColor(): string {
    return '#000000';
  },
  on(): void {},
};
export const autoUpdater = { on(): void {}, checkForUpdates(): void {}, quitAndInstall(): void {} };
export const crashReporter = { start(): void {} };
export const desktopCapturer = {
  getSources(): Promise<[]> {
    return Promise.resolve([]);
  },
};
export const webContents = {
  getAllWebContents(): [] {
    return [];
  },
};
export const contextBridge = { exposeInMainWorld(): void {} };
export const nativeImage = {
  createFromPath(): { isEmpty(): boolean } {
    return { isEmpty: () => true };
  },
};
