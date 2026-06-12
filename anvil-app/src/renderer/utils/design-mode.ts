import type { DesignMode } from '../../shared/types';

export const DESIGN_MODE_STORAGE_KEY = 'anvil:design-mode';

export function loadDesignModePreference(): DesignMode {
  if (typeof window === 'undefined') return 'design';
  const stored = window.localStorage.getItem(DESIGN_MODE_STORAGE_KEY);
  return stored === 'implement' ? 'implement' : 'design';
}

export function storeDesignModePreference(mode: DesignMode): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DESIGN_MODE_STORAGE_KEY, mode);
}
