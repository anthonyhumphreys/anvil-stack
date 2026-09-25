import { describe, expect, it } from 'vitest';
import { buildSettingsPath, parseSettingsLocation } from '../settings-route';
import { searchSettings } from '../settings-search';
import { SETTINGS_CATEGORIES } from '../settings-registry';

describe('parseSettingsLocation', () => {
  it('parses /settings/:category#panel', () => {
    expect(parseSettingsLocation('/settings/delivery', '', '#git')).toEqual({
      category: 'delivery',
      panel: 'git',
    });
  });

  it('falls back to ?category= for the pre-param route', () => {
    expect(parseSettingsLocation('/settings', '?category=privacy', '')).toEqual({
      category: 'privacy',
      panel: undefined,
    });
  });

  it('resolves the pre-split "ai" alias to providers', () => {
    expect(parseSettingsLocation('/settings/ai', '', '').category).toBe('providers');
  });

  it('ignores unknown categories', () => {
    expect(parseSettingsLocation('/settings/nope', '', '').category).toBeUndefined();
  });
});

describe('buildSettingsPath', () => {
  it('builds /settings/:category#panel', () => {
    expect(buildSettingsPath('delivery', 'git')).toBe('/settings/delivery#git');
    expect(buildSettingsPath('profile')).toBe('/settings/profile');
  });
});

describe('searchSettings (ST7)', () => {
  it('returns nothing for a blank query', () => {
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  it('matches panel titles', () => {
    const results = searchSettings('git provider');
    expect(results.some((r) => r.panel?.id === 'git' && r.category.id === 'delivery')).toBe(true);
  });

  it('matches keywords case-insensitively', () => {
    const results = searchSettings('OLLAMA');
    expect(results.some((r) => r.panel?.id === 'local-model')).toBe(true);
  });

  it('matches a category with no panel hit as a category-level result', () => {
    const results = searchSettings('crash report');
    expect(results.some((r) => r.category.id === 'privacy')).toBe(true);
  });
});

describe('settings registry', () => {
  it('has unique category ids and unique panel ids within a category', () => {
    const ids = SETTINGS_CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of SETTINGS_CATEGORIES) {
      const panelIds = category.panels.map((panel) => panel.id);
      expect(new Set(panelIds).size).toBe(panelIds.length);
    }
  });

  it('splits the old "ai" category into providers and agents', () => {
    expect(SETTINGS_CATEGORIES.some((category) => category.id === 'providers')).toBe(true);
    expect(SETTINGS_CATEGORIES.some((category) => category.id === 'agents')).toBe(true);
    expect(SETTINGS_CATEGORIES.some((category) => category.id === 'ai')).toBe(false);
  });
});
