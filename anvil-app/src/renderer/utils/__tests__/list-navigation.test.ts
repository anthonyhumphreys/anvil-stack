import { describe, expect, it } from 'vitest';
import { getNextListboxIndex } from '../list-navigation';

describe('getNextListboxIndex', () => {
  it('wraps arrow navigation through listbox items', () => {
    expect(getNextListboxIndex('ArrowDown', 2, 3)).toBe(0);
    expect(getNextListboxIndex('ArrowUp', 0, 3)).toBe(2);
  });

  it('jumps to the first and last item with Home and End', () => {
    expect(getNextListboxIndex('Home', 2, 5)).toBe(0);
    expect(getNextListboxIndex('End', 2, 5)).toBe(4);
  });

  it('ignores unsupported keys and empty lists', () => {
    expect(getNextListboxIndex('Enter', 1, 3)).toBeNull();
    expect(getNextListboxIndex('ArrowDown', 0, 0)).toBeNull();
  });
});
