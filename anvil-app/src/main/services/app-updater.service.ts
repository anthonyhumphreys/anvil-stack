import { app, autoUpdater } from 'electron';

const UPDATE_FEED_URL =
  'https://github.com/anthonyhumphreys/anvil-stack/releases/latest/download/anvil-macos-arm64-updates.json';
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const INITIAL_UPDATE_CHECK_DELAY_MS = 15 * 1000;

let initialized = false;

function checkForUpdates(): void {
  autoUpdater.checkForUpdates().catch((error: unknown) => {
    console.error('[Updater] Failed to check for updates:', error);
  });
}

export function initializeAppUpdater(): void {
  if (initialized || !app.isPackaged || process.platform !== 'darwin' || process.arch !== 'arm64') {
    return;
  }
  initialized = true;

  autoUpdater.setFeedURL({
    url: UPDATE_FEED_URL,
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
