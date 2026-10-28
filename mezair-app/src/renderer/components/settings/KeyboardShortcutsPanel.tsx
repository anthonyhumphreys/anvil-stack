import { useState } from 'react';
import { useShortcuts } from '../../hooks/useShortcuts';
import {
  formatShortcut,
  normaliseShortcut,
  shortcutConflict,
  shortcutFor,
  SHORTCUTS,
  type ShortcutId,
} from '../../utils/shortcuts';
import { Button } from '../ui';
import { SettingsPanel } from './settings-ui';

export function KeyboardShortcutsPanel() {
  const { overrides, save } = useShortcuts();
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mac = navigator.platform.includes('Mac');
  const persist = (next: typeof overrides) => {
    try {
      save(next);
      setNotice('Shortcut saved on this device.');
      setRecording(null);
    } catch {
      setNotice('Could not save the shortcut. Try again.');
    }
  };
  return (
    <SettingsPanel
      panelId="keyboard-shortcuts"
      title="Keyboard shortcuts"
      description="Customise app shortcuts on this device. Changes save immediately. Mod uses Command on macOS and Ctrl on Windows or Linux."
    >
      <div className="divide-y divide-border-subtle">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="text-sm text-text-primary">{shortcut.label}</span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setRecording(shortcut.id);
                  setNotice('Press a key combination. Escape cancels.');
                }}
                onKeyDown={(event) => {
                  if (recording !== shortcut.id || event.key === 'Tab') return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.key === 'Escape') {
                    setRecording(null);
                    setNotice(null);
                    return;
                  }
                  if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
                  const parts = [
                    event.metaKey || event.ctrlKey ? 'Mod' : '',
                    event.altKey ? 'Alt' : '',
                    event.shiftKey ? 'Shift' : '',
                    event.key === ' '
                      ? 'Space'
                      : event.code.startsWith('Key')
                        ? event.code.slice(3)
                        : event.key,
                  ].filter(Boolean);
                  const binding = normaliseShortcut(parts.join('+'));
                  if (!binding) {
                    setNotice(
                      'Use a modifier and key. Standard editing, window and workspace shortcuts are reserved.',
                    );
                    return;
                  }
                  const conflict = shortcutConflict(shortcut.id, binding, overrides);
                  if (conflict) {
                    setNotice(`Already used by ${conflict}. Choose another combination.`);
                    return;
                  }
                  persist({ ...overrides, [shortcut.id]: binding });
                }}
                data-shortcut-recorder
                aria-label={`Change shortcut for ${shortcut.label}`}
              >
                {recording === shortcut.id
                  ? 'Press keys…'
                  : formatShortcut(shortcutFor(shortcut.id, overrides), mac)}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={shortcutFor(shortcut.id, overrides) === ''}
                onClick={() => persist({ ...overrides, [shortcut.id]: '' })}
              >
                Disable
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Button variant="secondary" size="sm" onClick={() => persist({})}>
        Restore default shortcuts
      </Button>
      <p className="text-xs text-text-secondary">
        Ctrl+1 through Ctrl+9 switches workspaces. In Chat, / focuses the composer. In Settings,{' '}
        {mac ? '⌘F' : 'Ctrl+F'} searches settings.
      </p>
      {notice && (
        <p role="status" aria-live="polite" className="text-sm text-text-secondary">
          {notice}
        </p>
      )}
    </SettingsPanel>
  );
}
