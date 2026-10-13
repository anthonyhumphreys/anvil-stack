import { FileMinus2, FilePen, FilePlus2, type LucideIcon } from 'lucide-react';
import { TURN_FILE_STATUS_LABEL, type TurnFileStatus } from '../chat-turn-changes';

const STATUS_ICON: Record<TurnFileStatus, LucideIcon> = {
  added: FilePlus2,
  modified: FilePen,
  deleted: FileMinus2,
};

const STATUS_TONE: Record<TurnFileStatus, string> = {
  added: 'text-success',
  modified: 'text-info',
  deleted: 'text-error',
};

/**
 * Status shown by shape plus label, never colour alone: each status has its
 * own icon, and the label is visible (`showLabel`) or announced (sr-only).
 */
export function TurnFileStatusGlyph({
  status,
  showLabel = false,
  count,
}: {
  status: TurnFileStatus;
  showLabel?: boolean;
  /** When set, renders "N added" style copy. */
  count?: number;
}) {
  const Icon = STATUS_ICON[status];
  const label = TURN_FILE_STATUS_LABEL[status];
  const text = count !== undefined ? `${count} ${label.toLowerCase()}` : label;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs">
      <Icon size={12} className={STATUS_TONE[status]} aria-hidden="true" />
      {showLabel ? (
        <span className="text-text-tertiary">{text}</span>
      ) : (
        <span className="sr-only">{text}</span>
      )}
    </span>
  );
}
