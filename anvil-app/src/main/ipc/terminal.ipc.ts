import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import {
  createTerminal,
  writeToTerminal,
  resizeTerminal,
  closeTerminal,
  closeAllTerminals,
} from '../services/terminal.service.js';
import { notifyIfUnfocused } from '../services/notification.service.js';
import {
  scanTerminalData,
  removeTerminalTargets,
  listTargets,
} from '../services/browser.service.js';

function sendToRenderer(channel: string, payload: unknown): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

export function registerTerminalHandlers(): void {
  ipcMain.handle(
    'terminal:create',
    (
      _event,
      { workspaceId, repoId, cwd }: { workspaceId: string; repoId: string; cwd: string },
    ) => {
      // Validate cwd exists and is a directory
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`Invalid terminal working directory: ${cwd}`);
      }

      const terminalId = createTerminal(
        workspaceId,
        repoId,
        cwd,
        (id, data) => {
          sendToRenderer('terminal:data', { terminalId: id, data });

          // Scan terminal output for dev server port patterns
          const countBefore = listTargets().length;
          scanTerminalData(id, data);
          const targetsNow = listTargets();
          if (targetsNow.length > countBefore) {
            sendToRenderer('browser:target-detected', targetsNow[0]);
          }
        },
        (id, exitCode) => {
          sendToRenderer('terminal:exit', { terminalId: id, exitCode });
          removeTerminalTargets(id);
          notifyIfUnfocused(
            'Terminal Process Exited',
            exitCode === 0
              ? 'Process completed successfully.'
              : `Process exited with code ${exitCode}.`,
          );
        },
      );

      return { terminalId };
    },
  );

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
    closeTerminal(terminalId);
  });

  ipcMain.handle('terminal:close-all', () => {
    closeAllTerminals();
  });
}

export function cleanupTerminals(): void {
  closeAllTerminals();
}
