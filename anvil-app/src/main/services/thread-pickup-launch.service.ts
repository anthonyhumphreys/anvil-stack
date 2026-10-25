import { isAbsolute } from 'node:path';
import type { BrowserWindow } from 'electron';
import { PRIMARY_PROTOCOL, LEGACY_PROTOCOL } from '../../shared/app-identity.js';

let requested = false;
let pendingFile: string | null = null;

/** The protocol only opens import review. Conversation data and keys never travel in it. */
export function isThreadPickupUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      [PRIMARY_PROTOCOL + ':', LEGACY_PROTOCOL + ':'].includes(url.protocol) &&
      url.hostname === 'pick-up-thread' &&
      ['', '/'].includes(url.pathname) &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

export function queueThreadPickup(file?: string): boolean {
  if (
    file !== undefined &&
    (!isAbsolute(file) ||
      file.length > 4096 ||
      file.includes('\0') ||
      !file.toLowerCase().endsWith('.anvil-thread'))
  )
    return false;
  pendingFile = file ?? null;
  requested = true;
  return true;
}

export function queueThreadPickupFromArgv(argv: readonly string[]): boolean {
  const file = argv.find(
    (value) => isAbsolute(value) && value.toLowerCase().endsWith('.anvil-thread'),
  );
  if (file) return queueThreadPickup(file);
  return argv.some(isThreadPickupUrl) ? queueThreadPickup() : false;
}

export function hasPendingThreadPickup(): boolean {
  return requested;
}

export function takePendingThreadPickupFile(): string | null {
  const file = pendingFile;
  requested = false;
  pendingFile = null;
  return file;
}

export function deliverPendingThreadPickup(window: BrowserWindow | null): void {
  if (requested && window && !window.isDestroyed())
    window.webContents.send('shares:pickup-requested');
}
