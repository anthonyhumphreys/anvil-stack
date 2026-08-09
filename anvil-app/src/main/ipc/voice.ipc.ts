import { app, ipcMain, BrowserWindow, systemPreferences } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, unwatchFile, watchFile } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let isListening = false;
let speechProcess: ChildProcessWithoutNullStreams | null = null;
let stopRequested = false;
let speechStopFilePath: string | null = null;

interface SpeechHelperEvent {
  type?: 'result' | 'status' | 'error';
  text?: string;
  isFinal?: boolean;
  error?: string;
}

function getSpeechHelperAppPath(): string {
  const resourcesDirectory = app.isPackaged
    ? process.resourcesPath
    : join(process.cwd(), 'resources', '.build');
  return join(resourcesDirectory, 'Anvil Speech Recognition.app');
}

async function startNativeSpeechRecognition(): Promise<{
  success: boolean;
  error?: string;
  fallback?: boolean;
}> {
  if (process.platform !== 'darwin') {
    return Promise.resolve({
      success: false,
      fallback: true,
      error: 'Native voice input is only available on macOS.',
    });
  }

  const helperAppPath = getSpeechHelperAppPath();
  if (!existsSync(helperAppPath)) {
    return {
      success: false,
      fallback: process.platform !== 'darwin',
      error: `Speech recognition helper was not found at ${helperAppPath}`,
    };
  }

  const sessionDirectory = await mkdtemp(join(tmpdir(), 'anvil-speech-'));
  const eventsPath = join(sessionDirectory, 'events.jsonl');
  const errorsPath = join(sessionDirectory, 'errors.log');
  const stopPath = join(sessionDirectory, 'stop');
  await Promise.all([writeFile(eventsPath, ''), writeFile(errorsPath, '')]);
  speechStopFilePath = stopPath;

  return new Promise((resolve) => {
    const child = spawn(
      '/usr/bin/open',
      ['-W', '-n', '--stderr', errorsPath, helperAppPath, '--args', eventsPath, stopPath],
      {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    speechProcess = child;
    stopRequested = false;

    let stdoutBuffer = '';
    let eventOffset = 0;
    let eventReadQueue = Promise.resolve();
    let settled = false;
    let helperReportedError = false;

    const settle = (result: { success: boolean; error?: string; fallback?: boolean }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimeout);
      resolve(result);
    };

    const startTimeout = setTimeout(() => {
      const message = 'Voice input took too long to start.';
      stopRequested = true;
      void writeFile(stopPath, 'stop');
      settle({ success: false, error: message });
      broadcastVoiceError(message);
    }, 60_000);

    const handleLine = (line: string): void => {
      if (!line.trim()) return;

      let event: SpeechHelperEvent;
      try {
        event = JSON.parse(line) as SpeechHelperEvent;
      } catch {
        return;
      }

      if (event.type === 'result' && event.text) {
        broadcastVoiceResult(event.text);
        return;
      }

      if (event.type === 'status' && event.text === 'listening') {
        isListening = true;
        broadcastVoiceStatus('listening');
        settle({ success: true });
        return;
      }

      if (event.type === 'status' && event.text === 'stopped') {
        isListening = false;
        broadcastVoiceStatus('stopped');
        return;
      }

      if (event.type === 'error') {
        const message = event.error?.trim() || 'Native speech recognition failed.';
        helperReportedError = true;
        isListening = false;
        broadcastVoiceError(message);
        broadcastVoiceStatus('error');
        settle({ success: false, error: message });
      }
    };

    const readEvents = async (): Promise<void> => {
      const events = await readFile(eventsPath);
      if (events.length <= eventOffset) return;
      stdoutBuffer += events.subarray(eventOffset).toString();
      eventOffset = events.length;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      lines.forEach(handleLine);
    };

    watchFile(eventsPath, { interval: 100 }, () => {
      eventReadQueue = eventReadQueue.then(readEvents).catch(() => undefined);
    });

    child.on('error', (err) => {
      unwatchFile(eventsPath);
      speechProcess = null;
      speechStopFilePath = null;
      isListening = false;
      settle({ success: false, error: err.message });
      void rm(sessionDirectory, { recursive: true, force: true });
    });

    child.on('close', async (code) => {
      unwatchFile(eventsPath);
      await eventReadQueue;
      await readEvents().catch(() => undefined);
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      const wasExpected = stopRequested;
      speechProcess = null;
      speechStopFilePath = null;
      isListening = false;
      const stderr = await readFile(errorsPath, 'utf8').catch(() => '');

      if (!settled) {
        const detail = stderr.trim();
        settle({
          success: false,
          error: detail
            ? `Native speech recognition could not start: ${detail.slice(0, 500)}`
            : 'Native speech recognition stopped before the microphone was ready.',
        });
      } else if (!wasExpected && !helperReportedError && code !== 0) {
        const detail = stderr.trim();
        const message = detail
          ? `Native speech recognition stopped: ${detail.slice(0, 500)}`
          : 'Native speech recognition stopped unexpectedly.';
        broadcastVoiceError(message);
        broadcastVoiceStatus('error');
      }

      await rm(sessionDirectory, { recursive: true, force: true }).catch(() => undefined);
    });

    child.stdin.end();
  });
}

function stopNativeSpeechRecognition(): void {
  stopRequested = true;
  isListening = false;

  if (!speechProcess) {
    broadcastVoiceStatus('stopped');
    return;
  }

  if (speechStopFilePath) void writeFile(speechStopFilePath, 'stop');
}

export function registerVoiceHandlers(_mainWindow: BrowserWindow): void {
  ipcMain.handle('voice:request-permission', async () => {
    if (process.platform !== 'darwin') {
      return { granted: true, status: 'granted' as const };
    }

    // The LaunchServices-hosted speech helper owns microphone capture on macOS,
    // so its privacy prompts and TCC state are separate from Electron's.
    if (existsSync(getSpeechHelperAppPath())) {
      return { granted: true, status: 'unknown' as const };
    }

    const currentStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (currentStatus === 'granted') {
      return { granted: true, status: currentStatus };
    }
    // The development runtime is the generic Electron.app bundle, so it cannot
    // present Anvil's packaged NSMicrophoneUsageDescription. Let Chromium make
    // its normal media request instead of leaving the UI waiting on TCC.
    if (!app.isPackaged && currentStatus === 'not-determined') {
      return { granted: true, status: 'unknown' as const };
    }
    if (currentStatus === 'denied' || currentStatus === 'restricted') {
      return {
        granted: false,
        status: currentStatus,
        error:
          currentStatus === 'restricted'
            ? 'Microphone access is restricted by macOS.'
            : 'Microphone access is off for Anvil. Enable it in System Settings → Privacy & Security → Microphone, then restart Anvil.',
      };
    }

    try {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      const status = systemPreferences.getMediaAccessStatus('microphone');
      return {
        granted,
        status,
        error: granted
          ? undefined
          : 'Microphone access was not granted. Enable it in System Settings → Privacy & Security → Microphone, then restart Anvil.',
      };
    } catch (err) {
      return {
        granted: false,
        status: systemPreferences.getMediaAccessStatus('microphone'),
        error: err instanceof Error ? err.message : 'Anvil could not request microphone access.',
      };
    }
  });

  ipcMain.handle('voice:start-listening', async () => {
    if (isListening || speechProcess) return { success: false, error: 'Already listening' };
    return startNativeSpeechRecognition();
  });

  ipcMain.handle('voice:stop-listening', async () => {
    stopNativeSpeechRecognition();
    return { success: true };
  });

  ipcMain.handle('voice:get-status', async () => {
    return { isListening };
  });
}

export function broadcastVoiceResult(text: string): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('voice:result', text);
  });
}

export function broadcastVoiceError(error: string): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('voice:error', error);
  });
}

export function broadcastVoiceStatus(status: 'listening' | 'stopped' | 'error'): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('voice:status', status);
  });
}
