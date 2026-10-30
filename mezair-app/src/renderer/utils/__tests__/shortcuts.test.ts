import { describe, expect, it } from 'vitest';
import {
  normaliseShortcut,
  shortcutConflict,
  shortcutMatches,
  readShortcutOverrides,
  shortcutFor,
} from '../shortcuts';

const event = (key: string, changes = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...changes,
});
describe('keyboard shortcuts', () => {
  it('matches the platform modifier and rejects extra modifiers', () => {
    expect(shortcutMatches(event('k', { metaKey: true }), 'Mod+K', true)).toBe(true);
    expect(shortcutMatches(event('k', { ctrlKey: true }), 'Mod+K', false)).toBe(true);
    expect(shortcutMatches(event('k', { ctrlKey: true }), 'Mod+K', true)).toBe(false);
    expect(shortcutMatches(event('k', { metaKey: true, shiftKey: true }), 'Mod+K', true)).toBe(
      false,
    );
    expect(shortcutMatches(event('k', { metaKey: true }), '', true)).toBe(false);
  });
  it('uses physical letter keys when Option changes the character', () => {
    expect(
      shortcutMatches(
        event('Dead', { code: 'KeyN', metaKey: true, altKey: true }),
        'Mod+Alt+N',
        true,
      ),
    ).toBe(true);
  });
  it('normalises combinations and protects standard editing and workspace keys', () => {
    expect(normaliseShortcut('Shift+Mod+n')).toBe('Mod+Shift+N');
    expect(normaliseShortcut('Mod+C')).toBeNull();
    expect(normaliseShortcut('Ctrl+1')).toBeNull();
    expect(normaliseShortcut('N')).toBeNull();
    expect(normaliseShortcut('Mod+Mod+N')).toBeNull();
    expect(normaliseShortcut('Bogus+N')).toBeNull();
  });
  it('detects collisions with defaults and platform-equivalent combinations', () => {
    expect(shortcutConflict('terminal', 'Ctrl+K', {})).toBe('Command palette');
    expect(shortcutConflict('terminal', 'Meta+K', {})).toBe('Command palette');
    expect(shortcutConflict('terminal', 'Mod+Shift+T', {})).toBeNull();
  });
  it('loads valid overrides, keeps disables and handles corrupt storage', () => {
    const storage = (value: string) => ({ getItem: () => value });
    expect(readShortcutOverrides(storage('{bad'))).toEqual({});
    expect(readShortcutOverrides(storage('{"terminal":"Mod+Shift+T","settings":""}'))).toEqual({
      terminal: 'Mod+Shift+T',
      settings: '',
    });
    expect(readShortcutOverrides(storage('{"terminal":"Mod+K"}'))).toEqual({});
    expect(shortcutFor('settings', { settings: '' })).toBe('');
  });
});
