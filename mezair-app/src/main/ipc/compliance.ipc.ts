import { ipcMain, BrowserWindow } from 'electron';
import type { ComplianceDocType } from '../../shared/types.js';
import {
  generateComplianceDoc,
  listComplianceDocs,
  readComplianceDoc,
} from '../services/compliance.service.js';

function sendToRenderer(channel: string, payload: unknown): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

export function registerComplianceHandlers(): void {
  ipcMain.handle(
    'compliance:generate',
    async (_event, repoId: string, docType: ComplianceDocType) => {
      try {
        return await generateComplianceDoc(repoId, docType, (message, percent) => {
          sendToRenderer('compliance:progress', { repoId, docType, message, percent });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Compliance] Generation failed for ${docType}:`, message);
        throw new Error(`Failed to generate ${docType}: ${message}`);
      }
    },
  );

  ipcMain.handle('compliance:list', (_event, repoId: string) => {
    return listComplianceDocs(repoId);
  });

  ipcMain.handle('compliance:read', (_event, repoId: string, docType: ComplianceDocType) => {
    return readComplianceDoc(repoId, docType);
  });
}
