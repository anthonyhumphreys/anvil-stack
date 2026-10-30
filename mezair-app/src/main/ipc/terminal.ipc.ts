import { BrowserWindow, ipcMain, webContents, type WebContents } from 'electron';
import fs from 'node:fs';
import {
  attachTerminal,
  closeAllTerminals,
  closeTerminal,
  createTerminal,
  listTerminals,
  resizeTerminal,
  subscribeToTerminalEvents,
  writeToTerminal,
} from '../services/terminal.service.js';
import { notifyIfUnfocused } from '../services/notification.service.js';
import {
  scanTerminalData,
  removeTerminalTargets,
  listTargets,
} from '../services/browser.service.js';

const terminalSubscribers = new Map<string, Set<number>>();
const senderSubscriptions = new Map<number, Set<string>>();
let stopTerminalEventSubscription: (() => void) | null = null;

function removeSenderSubscriptions(senderId: number): void {
  const terminalIds = senderSubscriptions.get(senderId);
  if (!terminalIds) return;

  for (const terminalId of terminalIds) {
    const subscribers = terminalSubscribers.get(terminalId);
    subscribers?.delete(senderId);
    if (subscribers?.size === 0) terminalSubscribers.delete(terminalId);
  }
  senderSubscriptions.delete(senderId);
}

function subscribeSender(sender: WebContents, terminalId: string): void {
  const senderId = sender.id;
  let senderTerminalIds = senderSubscriptions.get(senderId);
  if (!senderTerminalIds) {
    senderTerminalIds = new Set();
    senderSubscriptions.set(senderId, senderTerminalIds);
    sender.once('destroyed', () => removeSenderSubscriptions(senderId));
  }
  senderTerminalIds.add(terminalId);

  const subscribers = terminalSubscribers.get(terminalId) ?? new Set<number>();
  subscribers.add(senderId);
  terminalSubscribers.set(terminalId, subscribers);
}

function detachSender(senderId: number, terminalId: string): void {
  const subscribers = terminalSubscribers.get(terminalId);
  subscribers?.delete(senderId);
  if (subscribers?.size === 0) terminalSubscribers.delete(terminalId);

  const terminalIds = senderSubscriptions.get(senderId);
  terminalIds?.delete(terminalId);
  if (terminalIds?.size === 0) senderSubscriptions.delete(senderId);
}

function removeTerminalSubscriptions(terminalId: string): void {
  const subscribers = terminalSubscribers.get(terminalId);
  if (!subscribers) return;
  for (const senderId of subscribers) {
    const terminalIds = senderSubscriptions.get(senderId);
    terminalIds?.delete(terminalId);
    if (terminalIds?.size === 0) senderSubscriptions.delete(senderId);
  }
  terminalSubscribers.delete(terminalId);
}

function sendToTerminalSubscribers(terminalId: string, channel: string, payload: unknown): void {
  const subscribers = terminalSubscribers.get(terminalId);
  if (!subscribers) return;

  for (const senderId of [...subscribers]) {
    const sender = webContents.fromId(senderId);
    if (!sender || sender.isDestroyed()) {
      detachSender(senderId, terminalId);
      continue;
    }
    sender.send(channel, payload);
  }
}

function broadcastBrowserTarget(payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('browser:target-detected', payload);
  }
}

export function registerTerminalHandlers(): void {
  stopTerminalEventSubscription?.();
  stopTerminalEventSubscription = subscribeToTerminalEvents((event) => {
    if (event.type === 'data') {
      sendToTerminalSubscribers(event.terminalId, 'terminal:data', {
        terminalId: event.terminalId,
        sequence: event.sequence,
        data: event.data,
      });

      const countBefore = listTargets().length;
      scanTerminalData(event.terminalId, event.data);
      const targetsNow = listTargets();
      if (targetsNow.length > countBefore) {
        broadcastBrowserTarget(targetsNow[0]);
      }
      return;
    }

    sendToTerminalSubscribers(event.terminalId, 'terminal:exit', {
      terminalId: event.terminalId,
      exitCode: event.exitCode,
    });
    removeTerminalTargets(event.terminalId);
    notifyIfUnfocused(
      'Terminal Process Exited',
      event.exitCode === 0
        ? 'Process completed successfully.'
        : `Process exited with code ${event.exitCode}.`,
    );
  });

  ipcMain.handle(
    'terminal:create',
    (
      _event,
      { workspaceId, repoId, cwd }: { workspaceId: string; repoId: string; cwd: string },
    ) => {
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`Invalid terminal working directory: ${cwd}`);
      }

      const terminal = createTerminal(workspaceId, repoId, cwd);
      return { terminalId: terminal.terminalId };
    },
  );

  ipcMain.handle('terminal:list', (_event, { workspaceId }: { workspaceId: string }) => {
    return listTerminals(workspaceId);
  });

  ipcMain.handle(
    'terminal:attach',
    (event, { terminalId, afterSequence }: { terminalId: string; afterSequence?: number }) => {
      subscribeSender(event.sender, terminalId);
      try {
        return attachTerminal(terminalId, afterSequence);
      } catch (error) {
        detachSender(event.sender.id, terminalId);
        throw error;
      }
    },
  );

  ipcMain.on('terminal:detach', (event, { terminalId }: { terminalId: string }) => {
    detachSender(event.sender.id, terminalId);
  });

  ipcMain.on(
    'terminal:input',
    (_event, { terminalId, data }: { terminalId: string; data: string }) => {
      writeToTerminal(terminalId, data);
    },
  );

  ipcMain.on(
    'terminal:resize',
    (_event, { terminalId, cols, rows }: { terminalId: string; cols: number; rows: number }) => {
      resizeTerminal(terminalId, cols, rows);
    },
  );

  ipcMain.handle('terminal:close', (_event, { terminalId }: { terminalId: string }) => {
    sendToTerminalSubscribers(terminalId, 'terminal:closed', { terminalId });
    removeTerminalTargets(terminalId);
    closeTerminal(terminalId);
    removeTerminalSubscriptions(terminalId);
  });
}

export function cleanupTerminals(): void {
  stopTerminalEventSubscription?.();
  stopTerminalEventSubscription = null;
  terminalSubscribers.clear();
  senderSubscriptions.clear();
  closeAllTerminals();
}
