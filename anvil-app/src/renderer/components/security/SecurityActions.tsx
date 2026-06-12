import { TicketPlus, CheckSquare } from 'lucide-react';

interface Props {
  selectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onCreateWorkItems: () => void;
}

export function SecurityActions({
  selectedCount,
  totalCount,
  onSelectAll,
  onCreateWorkItems,
}: Props) {
  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-accent/30 bg-accent-glow px-4 py-2">
      <button
        onClick={onSelectAll}
        className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary"
      >
        <CheckSquare size={14} />
        {selectedCount === totalCount ? 'Deselect all' : 'Select all'}
      </button>
      <span className="text-sm text-text-secondary">
        {selectedCount} of {totalCount} selected
      </span>
      <div className="flex-1" />
      <button
        onClick={onCreateWorkItems}
        className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        <TicketPlus size={14} />
        Create Work Items ({selectedCount})
      </button>
    </div>
  );
}
