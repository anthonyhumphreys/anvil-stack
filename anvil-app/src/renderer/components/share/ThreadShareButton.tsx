import { useState } from 'react';
import { Share2 } from 'lucide-react';
import type { ShareTarget } from '../../../shared/shares-ipc';
import { ShareDialog } from './ShareDialog';

export function ThreadShareButton({ target, title }: { target: ShareTarget; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Share thread or attach it to a ticket"
        aria-label="Share thread"
        className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <Share2 size={14} aria-hidden="true" />
        <span className="hidden sm:inline">Share</span>
      </button>
      {open && <ShareDialog target={target} title={title} open onClose={() => setOpen(false)} />}
    </>
  );
}
