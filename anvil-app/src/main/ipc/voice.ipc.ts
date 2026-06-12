import { ipcMain, BrowserWindow } from 'electron';

let isListening = false;

export function registerVoiceHandlers(_mainWindow: BrowserWindow): void {
  ipcMain.handle('voice:start-listening', async () => {
    if (isListening) return { success: false, error: 'Already listening' };
    isListening = true;
    return { success: true };
  });

  ipcMain.handle('voice:stop-listening', async () => {
    isListening = false;
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
