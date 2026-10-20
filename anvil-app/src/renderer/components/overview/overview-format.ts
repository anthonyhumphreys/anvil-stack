import type {
  OverviewModuleWidth,
  OverviewScope,
  OverviewTimeRange,
  OverviewTone,
} from '../../../shared/overview';
import { OVERVIEW_TIME_RANGES } from '../../../shared/overview';

export const WIDTH_SPAN_CLASSES: Record<OverviewModuleWidth, string> = {
  third: '@3xl:col-span-2',
  half: '@3xl:col-span-3',
  'two-thirds': '@3xl:col-span-4',
  full: '@3xl:col-span-6',
};

export const TONE_TEXT_CLASSES: Record<OverviewTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-error',
  info: 'text-info',
  neutral: 'text-text-tertiary',
  accent: 'text-accent',
};

export function overviewScopeKey(scope: OverviewScope): string {
  return scope.kind === 'global' ? 'global' : `workspace:${scope.workspaceId}`;
}

/** Compact relative time for dense tables: "Now", "12m ago", "Yesterday", "Fri", "3 Oct". */
export function formatRelativeTime(value: string | undefined, now = Date.now()): string {
  if (!value) return '—';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '—';
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return 'Now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const date = new Date(time);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Math.ceil((startOfToday - time) / 86_400_000);
  if (days <= 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Freshness copy for module headers: "Updated now", "Updated 4 m ago". */
export function formatFreshness(value: string | undefined, now = Date.now()): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return 'Updated now';
  if (minutes < 60) return `Updated ${minutes} m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours} h ago`;
  return `Updated ${formatRelativeTime(value, now)}`;
}

const TIME_RANGE_STORAGE_PREFIX = 'overview:time-range:v1:';

export function readStoredTimeRange(
  scopeKey: string,
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage(),
): OverviewTimeRange {
  try {
    const value = storage?.getItem(`${TIME_RANGE_STORAGE_PREFIX}${scopeKey}`);
    if (OVERVIEW_TIME_RANGES.some((range) => range.value === value)) {
      return value as OverviewTimeRange;
    }
  } catch {
    // Storage can be unavailable (tool windows); the default is fine.
  }
  return '7d';
}

export function writeStoredTimeRange(
  scopeKey: string,
  range: OverviewTimeRange,
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(`${TIME_RANGE_STORAGE_PREFIX}${scopeKey}`, range);
  } catch {
    // Best-effort view preference.
  }
}

function safeStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

/** IPC errors arrive wrapped in Electron transport detail; keep only the reason. */
export function cleanIpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    raw
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^(Error:\s*)+/i, '')
      .trim() || 'Something went wrong.'
  );
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
