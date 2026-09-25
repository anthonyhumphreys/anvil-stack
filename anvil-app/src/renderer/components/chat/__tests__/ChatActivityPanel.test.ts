import { describe, expect, it } from 'vitest';
import { getActivitySectionForKey } from '../ChatActivityPanel';

describe('activity tab keyboard navigation', () => {
  it('moves between current activity and run history with arrow keys', () => {
    expect(getActivitySectionForKey('current', 'ArrowRight')).toBe('history');
    expect(getActivitySectionForKey('history', 'ArrowRight')).toBe('current');
    expect(getActivitySectionForKey('current', 'ArrowLeft')).toBe('history');
    expect(getActivitySectionForKey('history', 'ArrowLeft')).toBe('current');
    expect(getActivitySectionForKey('current', 'ArrowDown')).toBe('history');
    expect(getActivitySectionForKey('history', 'ArrowUp')).toBe('current');
  });

  it('supports Home and End and ignores unrelated keys', () => {
    expect(getActivitySectionForKey('history', 'Home')).toBe('current');
    expect(getActivitySectionForKey('current', 'End')).toBe('history');
    expect(getActivitySectionForKey('current', 'Enter')).toBeNull();
  });
});
