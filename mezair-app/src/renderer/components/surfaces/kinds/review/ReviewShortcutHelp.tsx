import { Dialog } from '../../../ui';
import { REVIEW_SHORTCUTS } from './review-model';

export function ReviewShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Review shortcuts" size="md">
      <dl className="mt-3 divide-y divide-border-subtle text-sm">
        {REVIEW_SHORTCUTS.map((shortcut) => (
          <div key={shortcut.label} className="flex items-center justify-between gap-4 py-1.5">
            <dt className="text-text-secondary">{shortcut.label}</dt>
            <dd className="flex shrink-0 gap-1">
              {shortcut.keys.map((key) => (
                <kbd
                  key={key}
                  className="rounded-md border border-border bg-bg-secondary px-1.5 py-px font-mono text-xs text-text-primary"
                >
                  {key}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
