import { Notification, BrowserWindow } from 'electron';
import type { ChatNavigationTarget } from '../../shared/types.js';
import { getChatThread } from './chat-persistence.service.js';

function isAppFocused(): boolean {
  return BrowserWindow.getAllWindows().some((win) => win.isFocused());
}

function focusApp(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  return win ?? null;
}

export function notifyIfUnfocused(title: string, body: string): void {
  if (isAppFocused()) return;
  if (!Notification.isSupported()) return;

  const notification = new Notification({ title, body });
  notification.on('click', () => focusApp());
  notification.show();
}

export type ChatActivityKind = 'approval' | 'input' | 'complete';

export interface ChatActivityNotification {
  kind: ChatActivityKind;
  target: ChatNavigationTarget;
}

/**
 * Notify about chat activity only while Anvil is in the background. Approval and
 * input remain inside the app; the notification action only opens the exact thread.
 */
export function notifyChatActivity({ kind, target }: ChatActivityNotification): void {
  // Completion is ambient; do not banner while the user is already in Anvil.
  // Approval and input are blocking and may belong to another workspace/window,
  // so they remain visible even when a different Anvil surface has focus.
  if (kind === 'complete' && isAppFocused()) return;
  if (!Notification.isSupported()) return;

  const thread = getChatThread(target.threadId);
  const threadTitle = thread?.title?.trim() || 'Anvil chat';
  const copy = getChatActivityCopy(kind, threadTitle);
  const notification = new Notification({
    title: copy.title,
    body: copy.body,
    actions: process.platform === 'darwin' ? [{ type: 'button', text: 'Open thread' }] : undefined,
    closeButtonText: process.platform === 'darwin' ? 'Dismiss' : undefined,
  });
  const openThread = () => {
    const win = focusApp();
    win?.webContents.send('app-window:navigate-to-chat', target);
  };

  notification.on('click', openThread);
  notification.on('action', (_event, actionIndex) => {
    if (actionIndex === 0) openThread();
  });
  notification.show();
}

function getChatActivityCopy(
  kind: ChatActivityKind,
  threadTitle: string,
): { title: string; body: string } {
  switch (kind) {
    case 'approval':
      return { title: 'Anvil needs your approval', body: `${threadTitle} is waiting for you.` };
    case 'input':
      return { title: 'Anvil needs your input', body: `${threadTitle} has a question for you.` };
    case 'complete':
      return { title: 'Chat complete', body: `${threadTitle} is ready.` };
  }
}
