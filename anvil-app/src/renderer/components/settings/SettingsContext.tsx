import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { AppTheme, UserRole } from '../../../shared/types';
import type { SettingsDraft } from './useSettingsDraft';

/**
 * Shared context for lazily-mounted settings categories (ST6). The view owns
 * one `useSettingsDraft()` instance; category components read it here instead
 * of mounting their own state next to every other category's.
 */
export interface SettingsContextValue {
  draft: SettingsDraft;
  userRole?: UserRole;
  onSettingsSaved?: () => void;
  onRoleChange?: (role: UserRole) => void;
  onThemeChange?: (theme: AppTheme) => void;
  onPreviewOnboarding?: () => void;
  /** Surfaces an error string in the shared header notice. */
  reportError: (message: string | null) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsContextProvider({
  value,
  children,
}: {
  value: SettingsContextValue;
  children: ReactNode;
}) {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettingsContext(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) {
    throw new Error('useSettingsContext must be used inside a SettingsView');
  }
  return value;
}
