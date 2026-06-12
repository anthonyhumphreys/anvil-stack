const EDITABLE_TARGET_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;

  const element = target as Partial<HTMLElement>;
  if (element.isContentEditable) return true;
  if (typeof element.closest !== 'function') return false;

  return !!element.closest(EDITABLE_TARGET_SELECTOR);
}

export function isShellShortcutOptInTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;

  const element = target as Partial<HTMLElement>;
  if (typeof element.closest !== 'function') return false;

  return !!element.closest('[data-shell-shortcuts]');
}
