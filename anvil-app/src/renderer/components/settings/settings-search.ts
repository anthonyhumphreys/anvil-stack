import { SETTINGS_CATEGORIES } from './settings-registry';
import type { SettingsCategoryMeta, SettingsPanelMeta } from './settings-registry';

/**
 * ⌘F search over settings panel titles, descriptions and keywords (ST7).
 * Pure and registry-driven so new categories/panels are searchable as soon as
 * they are registered.
 */

export interface SettingsSearchResult {
  category: SettingsCategoryMeta;
  /** Undefined when the match is the category itself rather than a panel. */
  panel?: SettingsPanelMeta;
  /** Human-readable location, e.g. "Delivery integrations · Git provider". */
  breadcrumb: string;
  /** Searchable text that matched — used for result ranking/tests. */
  text: string;
}

function matches(query: string, text: string | undefined): boolean {
  return !!text && text.toLowerCase().includes(query);
}

export function searchSettings(query: string): SettingsSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: SettingsSearchResult[] = [];
  for (const category of SETTINGS_CATEGORIES) {
    const categoryHit =
      matches(q, category.label) ||
      matches(q, category.description) ||
      (category.keywords ?? []).some((keyword) => matches(q, keyword));

    for (const panel of category.panels) {
      const panelHit =
        matches(q, panel.title) ||
        matches(q, panel.description) ||
        (panel.keywords ?? []).some((keyword) => matches(q, keyword));
      if (panelHit) {
        results.push({
          category,
          panel,
          breadcrumb: `${category.label} · ${panel.title}`,
          text: `${panel.title} ${panel.description ?? ''} ${(panel.keywords ?? []).join(' ')}`,
        });
      }
    }

    // Surface the category itself when nothing inside it matched.
    if (categoryHit && !results.some((result) => result.category === category)) {
      results.push({
        category,
        breadcrumb: category.label,
        text: `${category.label} ${category.description}`,
      });
    }
  }
  return results;
}
