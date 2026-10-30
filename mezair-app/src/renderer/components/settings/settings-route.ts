import { resolveSettingsCategoryId } from './settings-registry';

/**
 * Deep-link parsing for Settings (ST4).
 *
 * Route contract for App.tsx (integration pass):
 *
 *   <Route path="/settings/:category?" element={<SettingsView ... />} />
 *
 * so that `/settings/delivery#git` mounts SettingsView with
 * `category = 'delivery'` and hash `#git`. The hash segment addresses a panel
 * inside the category (see `SettingsPanel`'s `panelId` prop and the registry's
 * `panels` metadata). Until the param route lands, `/settings?category=x#y`
 * is honoured as a fallback so links never dead-end.
 */

export interface SettingsLocation {
  category?: string;
  panel?: string;
}

/** Parse a router location into a settings category + optional panel anchor. */
export function parseSettingsLocation(
  pathname: string,
  search: string,
  hash: string,
): SettingsLocation {
  let category: string | undefined;
  let panel: string | undefined;

  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] === 'settings' && segments[1]) {
    category = resolveSettingsCategoryId(decodeURIComponent(segments[1]));
  }

  const params = new URLSearchParams(search);
  const queryCategory = params.get('category');
  if (!category && queryCategory) {
    category = resolveSettingsCategoryId(queryCategory);
  }
  const queryPanel = params.get('panel');
  if (queryPanel) panel = queryPanel;

  // "#delivery#git" style double-hash can appear inside a HashRouter path;
  // normalise by taking the last segment as the panel anchor.
  const rawHash = hash.startsWith('#') ? hash.slice(1) : hash;
  if (rawHash) {
    const last = rawHash.split('#').filter(Boolean).pop();
    if (last) panel = decodeURIComponent(last);
  }

  return { category, panel };
}

/** Build the canonical `/settings/:category#panel` href. */
export function buildSettingsPath(category: string, panel?: string): string {
  const resolved = resolveSettingsCategoryId(category) ?? category;
  return `/settings/${resolved}${panel ? `#${panel}` : ''}`;
}

/** Strip the `settings-panel-` prefix from a DOM anchor id. */
export function settingsPanelDomId(panelId: string): string {
  return `settings-panel-${panelId}`;
}
