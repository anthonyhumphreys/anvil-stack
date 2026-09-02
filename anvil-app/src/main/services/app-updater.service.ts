import { app, autoUpdater } from 'electron';

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const INITIAL_UPDATE_CHECK_DELAY_MS = 15 * 1000;
const UPDATE_FEED_PATH = '/v1/macos/arm64/feed.json';

let initialized = false;

function checkForUpdates(): void {
  try {
    autoUpdater.checkForUpdates();
  } catch (error: unknown) {
    console.error('[Updater] Failed to check for updates:', error);
  }
}

export function resolveUpdateFeedUrl(rawOrigin: string | undefined): string | null {
  const value = rawOrigin?.trim();
  if (!value) return null;

  try {
    const origin = new URL(value);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== '/'
    ) {
      return null;
    }
    return new URL(UPDATE_FEED_PATH, origin).toString();
  } catch {
    return null;
  }
}

export function initializeAppUpdater(): void {
  if (initialized || !app.isPackaged || process.platform !== 'darwin' || process.arch !== 'arm64') {
    return;
  }

  const feedUrl = resolveUpdateFeedUrl(process.env.ANVIL_UPDATE_ORIGIN);
  if (!feedUrl) {
    console.info('[Updater] Disabled because no valid HTTPS update origin was embedded.');
    return;
  }

  initialized = true;
  autoUpdater.setFeedURL({
    url: feedUrl,
    serverType: 'json',
  });

  autoUpdater.on('error', (error) => {
    console.error('[Updater] Auto-update error:', error);
  });
  autoUpdater.on('update-available', () => {
    console.info('[Updater] Update available; downloading in the background.');
  });
  autoUpdater.on('update-downloaded', (_event, _releaseNotes, releaseName) => {
    console.info(`[Updater] ${releaseName || 'Update'} downloaded; it will install on quit.`);
  });

  const initialCheck = setTimeout(checkForUpdates, INITIAL_UPDATE_CHECK_DELAY_MS);
  initialCheck.unref();

  const recurringCheck = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
  recurringCheck.unref();
}
