import { useEffect, useState } from 'react';
import {
  readShortcutOverrides,
  SHORTCUT_CHANGED_EVENT,
  SHORTCUT_STORAGE_KEY,
  type ShortcutOverrides,
} from '../utils/shortcuts';

export function useShortcuts() {
  const [overrides, setOverrides] = useState<ShortcutOverrides>(() =>
    readShortcutOverrides(window.localStorage),
  );
  useEffect(() => {
    const refresh = () => setOverrides(readShortcutOverrides(window.localStorage));
    window.addEventListener(SHORTCUT_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(SHORTCUT_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  const save = (next: ShortcutOverrides) => {
    window.localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(SHORTCUT_CHANGED_EVENT));
  };
  return { overrides, save };
}
