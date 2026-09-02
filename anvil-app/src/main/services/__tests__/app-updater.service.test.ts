import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  autoUpdater: {
    checkForUpdates: vi.fn<() => void>(),
    on: vi.fn(),
    setFeedURL: vi.fn(),
  },
}));

vi.mock('electron', () => electronMocks);

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');

describe('initializeAppUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('ANVIL_UPDATE_ORIGIN', 'https://updates.example.com');
    electronMocks.app.isPackaged = true;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    Object.defineProperty(process, 'arch', { configurable: true, value: 'arm64' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalArch) Object.defineProperty(process, 'arch', originalArch);
  });

  it('configures the Cloudflare feed and checks after startup and every four hours', async () => {
    const { initializeAppUpdater } = await import('../app-updater.service.js');

    initializeAppUpdater();

    expect(electronMocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      url: 'https://updates.example.com/v1/macos/arm64/feed.json',
      serverType: 'json',
    });
    expect(electronMocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(electronMocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 - 15_000);
    expect(electronMocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('initializes only once', async () => {
    const { initializeAppUpdater } = await import('../app-updater.service.js');

    initializeAppUpdater();
    initializeAppUpdater();

    expect(electronMocks.autoUpdater.setFeedURL).toHaveBeenCalledTimes(1);
    expect(electronMocks.autoUpdater.on).toHaveBeenCalledTimes(3);
  });

  it('logs synchronous update check failures without throwing from the timer', async () => {
    const error = new Error('check failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    electronMocks.autoUpdater.checkForUpdates.mockImplementationOnce(() => {
      throw error;
    });
    const { initializeAppUpdater } = await import('../app-updater.service.js');

    initializeAppUpdater();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(consoleError).toHaveBeenCalledWith('[Updater] Failed to check for updates:', error);
    consoleError.mockRestore();
  });

  it('does not initialize an unpackaged app', async () => {
    electronMocks.app.isPackaged = false;
    const { initializeAppUpdater } = await import('../app-updater.service.js');

    initializeAppUpdater();

    expect(electronMocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
  });

  it('does not initialize without a valid HTTPS origin', async () => {
    vi.stubEnv('ANVIL_UPDATE_ORIGIN', 'http://updates.example.com/path');
    const { initializeAppUpdater } = await import('../app-updater.service.js');

    initializeAppUpdater();

    expect(electronMocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
  });

  it.each([
    ['linux', 'arm64'],
    ['darwin', 'x64'],
  ])('does not initialize on %s %s', async (platform, arch) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    Object.defineProperty(process, 'arch', { configurable: true, value: arch });
    const { initializeAppUpdater } = await import('../app-updater.service.js');

    initializeAppUpdater();

    expect(electronMocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
  });
});
