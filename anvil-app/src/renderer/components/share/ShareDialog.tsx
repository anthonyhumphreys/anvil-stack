// Owned by the sharing workstream. Contract: open with a target; the dialog
// previews, scans, publishes, copies the link and reports the result.
import type { ShareRecord, ShareTarget } from '../../../shared/shares-ipc';

export interface ShareDialogProps {
  target: ShareTarget;
  title: string;
  open: boolean;
  onClose: () => void;
  onShared?: (record: ShareRecord) => void;
}

export function ShareDialog(_props: ShareDialogProps) {
  return null;
}
