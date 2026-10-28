import { describe, expect, it } from 'vitest';
import {
  cleanIpcError,
  formatFreshness,
  formatRelativeTime,
  readStoredTimeRange,
  writeStoredTimeRange,
} from '../overview-format';

const NOW = new Date(2026, 9, 13, 10, 0, 0).getTime();

describe('overview formatting', () => {
  it('formats compact relative times for dense tables', () => {
    expect(formatRelativeTime(new Date(NOW - 20_000).toISOString(), NOW)).toBe('Now');
    expect(formatRelativeTime(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe('12m ago');
    expect(formatRelativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h ago');
    expect(formatRelativeTime(new Date(2026, 9, 12, 8).toISOString(), NOW)).toBe('Yesterday');
    expect(formatRelativeTime(undefined, NOW)).toBe('—');
    expect(formatRelativeTime('not a date', NOW)).toBe('—');
  });

  it('describes freshness without claiming data it does not have', () => {
    expect(formatFreshness(new Date(NOW - 10_000).toISOString(), NOW)).toBe('Updated now');
    expect(formatFreshness(new Date(NOW - 4 * 60_000).toISOString(), NOW)).toBe('Updated 4 m ago');
    expect(formatFreshness(undefined, NOW)).toBeNull();
  });

  it('strips Electron transport detail from IPC errors', () => {
    expect(
      cleanIpcError(
        new Error(
          "Error invoking remote method 'overview:get-layout': Error: This workspace no longer exists.",
        ),
      ),
    ).toBe('This workspace no longer exists.');
  });

  it('remembers the time range per scope and ignores unknown values', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    expect(readStoredTimeRange('global', storage)).toBe('7d');
    writeStoredTimeRange('global', '30d', storage);
    expect(readStoredTimeRange('global', storage)).toBe('30d');
    expect(readStoredTimeRange('workspace:ws-1', storage)).toBe('7d');
    values.set('overview:time-range:v1:global', 'forever');
    expect(readStoredTimeRange('global', storage)).toBe('7d');
  });
});
