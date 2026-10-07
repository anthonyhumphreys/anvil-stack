export const SHORTCUTS = [
  { id: 'commandPalette', label: 'Command palette', binding: 'Mod+K' },
  { id: 'settings', label: 'Settings', binding: 'Mod+,' },
  { id: 'terminal', label: 'Toggle terminal', binding: 'Mod+`' },
  { id: 'newThread', label: 'New chat thread', binding: 'Mod+Shift+N' },
  { id: 'newWorkspace', label: 'Create workspace', binding: 'Mod+Alt+N' },
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]['id'];
export type ShortcutOverrides = Partial<Record<ShortcutId, string>>;
export const SHORTCUT_STORAGE_KEY = 'anvil:keyboard-shortcuts:v1';
export const SHORTCUT_CHANGED_EVENT = 'anvil:keyboard-shortcuts-changed';

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & {
  code?: string;
};
const MODIFIERS = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'];
const RESERVED_KEYS = new Set(['c', 'v', 'x', 'a', 'z', 'y', 'q', 'w', 'r', 'f', 'h', 'm', 'tab']);

export function normaliseShortcut(value: string): string | null {
  const parts = value
    .trim()
    .split('+')
    .map((part) => part.trim());
  const key = parts.pop();
  if (!key || parts.length === 0 || parts.some((part) => !MODIFIERS.includes(part))) return null;
  if (new Set(parts).size !== parts.length) return null;
  if (!parts.some((part) => ['Mod', 'Ctrl', 'Meta', 'Alt'].includes(part))) return null;
  if (parts.includes('Mod') && (parts.includes('Ctrl') || parts.includes('Meta'))) return null;
  if (
    !(
      key.length === 1 ||
      /^F(?:[1-9]|1[0-2])$/.test(key) ||
      [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Enter',
        'Escape',
        'Tab',
        'Space',
      ].includes(key)
    )
  )
    return null;
  if (RESERVED_KEYS.has(key.toLowerCase()) || /^[1-9]$/.test(key) || key === 'Escape') return null;
  return [
    ...MODIFIERS.filter((part) => parts.includes(part)),
    key.length === 1 ? key.toUpperCase() : key,
  ].join('+');
}

export function shortcutMatches(event: ShortcutEvent, binding: string, mac: boolean): boolean {
  if (!binding) return false;
  const parts = binding.split('+');
  const key = parts.pop();
  return (
    (event.code?.startsWith('Key') ? event.code.slice(3) : event.key).toLowerCase() ===
      (key === 'Space' ? ' ' : key?.toLowerCase()) &&
    event.metaKey === (parts.includes('Meta') || (parts.includes('Mod') && mac)) &&
    event.ctrlKey === (parts.includes('Ctrl') || (parts.includes('Mod') && !mac)) &&
    event.altKey === parts.includes('Alt') &&
    event.shiftKey === parts.includes('Shift')
  );
}

export function shortcutFor(id: ShortcutId, overrides: ShortcutOverrides): string {
  return overrides[id] ?? SHORTCUTS.find((shortcut) => shortcut.id === id)!.binding;
}

export function shortcutConflict(
  id: ShortcutId,
  binding: string,
  overrides: ShortcutOverrides,
): string | null {
  if (!binding) return null;
  // Check both platforms so a Mod binding cannot silently collide with Ctrl or Meta.
  const parts = binding.split('+');
  const key = parts.pop()!;
  for (const mac of [false, true]) {
    const event: ShortcutEvent = {
      key: key === 'Space' ? ' ' : key,
      ctrlKey: parts.includes('Ctrl') || (!mac && parts.includes('Mod')),
      metaKey: parts.includes('Meta') || (mac && parts.includes('Mod')),
      altKey: parts.includes('Alt'),
      shiftKey: parts.includes('Shift'),
    };
    const conflict = SHORTCUTS.find(
      (shortcut) =>
        shortcut.id !== id && shortcutMatches(event, shortcutFor(shortcut.id, overrides), mac),
    );
    if (conflict) return conflict.label;
  }
  return null;
}

export function readShortcutOverrides(storage: Pick<Storage, 'getItem'>): ShortcutOverrides {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(SHORTCUT_STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const overrides: ShortcutOverrides = {};
    for (const shortcut of SHORTCUTS) {
      const value = (parsed as Record<string, unknown>)[shortcut.id];
      if (typeof value === 'string' && (value === '' || normaliseShortcut(value)))
        overrides[shortcut.id] = value === '' ? '' : normaliseShortcut(value)!;
    }
    if (
      SHORTCUTS.some((shortcut) =>
        shortcutConflict(shortcut.id, shortcutFor(shortcut.id, overrides), overrides),
      )
    )
      return {};
    return overrides;
  } catch {
    return {};
  }
}

export function formatShortcut(binding: string, mac: boolean): string {
  return binding
    ? binding
        .replace('Mod', mac ? '⌘' : 'Ctrl')
        .replace('Meta', '⌘')
        .replace('Space', 'Space')
    : 'Disabled';
}
