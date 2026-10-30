// Pure formatting helpers shared by ShareDialog and SharedLinksList.
import type { ShareRecord } from '../../../shared/shares-ipc';

export const SHARE_EXPIRY_OPTIONS: { days: number; label: string }[] = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];

export function formatShareDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function isShareExpired(record: Pick<ShareRecord, 'expiresAt'>, now = Date.now()): boolean {
  if (!record.expiresAt) return false;
  const at = Date.parse(record.expiresAt);
  return Number.isFinite(at) && at <= now;
}

/** True when the item has moved on since the share captured it. */
export function isShareBehind(record: Pick<ShareRecord, 'version' | 'currentVersion'>): boolean {
  return record.currentVersion !== undefined && record.currentVersion > record.version;
}

/** "Shared v2 · you're on v4" when behind, else "Shared v2 · expires 12 Nov". */
export function shareStatusLine(record: ShareRecord, now: Date = new Date()): string {
  const base = `Shared v${record.version}`;
  if (isShareBehind(record)) return `${base} · you're on v${record.currentVersion}`;
  if (isShareExpired(record, now.getTime())) return `${base} · expired`;
  if (record.expiresAt) return `${base} · expires ${formatShareDate(record.expiresAt, now)}`;
  return base;
}

export function formatShareBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Electron prefixes IPC rejections; keep only the service's message.
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
