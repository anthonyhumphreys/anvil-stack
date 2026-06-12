import { Notification, BrowserWindow } from 'electron';

function isAppFocused(): boolean {
  return BrowserWindow.getAllWindows().some((win) => win.isFocused());
}

function focusApp(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

export function notifyIfUnfocused(title: string, body: string): void {
  if (isAppFocused()) return;
  if (!Notification.isSupported()) return;

  const notification = new Notification({ title, body });
  notification.on('click', () => focusApp());
  notification.show();
}
