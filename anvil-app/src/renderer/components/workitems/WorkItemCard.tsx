import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { WorkItem } from '../../../shared/types';

interface WorkItemCardProps {
  item: WorkItem;
  depth: number;
  activeId?: string;
  onSelect(item: WorkItem): void;
}
export function WorkItemCard({ item, depth, activeId, onSelect }: WorkItemCardProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = Boolean(item.children?.length);
  return (
    <div>
      <div
        className={`flex items-start gap-1 px-3 py-2 ${activeId === item.id ? 'bg-accent/10' : 'hover:bg-bg-tertiary'}`}
        style={{ paddingLeft: 12 + Math.min(depth, 5) * 16 }}
      >
        {hasChildren ? (
          <button
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.id}`}
            className="mt-1 rounded p-1 text-text-secondary focus-visible:outline-2 focus-visible:outline-accent"
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        ) : (
          <span className="w-6 shrink-0" />
        )}
        <button
          onClick={() => onSelect(item)}
          aria-pressed={activeId === item.id}
          className="min-w-0 flex-1 rounded py-1 text-left focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
            <span>{item.id}</span>
            <span>{item.type}</span>
            <span className="ml-auto">{item.state}</span>
          </span>
          <span className="mt-1 block break-words text-sm font-medium leading-6 text-text-primary">
            {item.title}
          </span>
          <span className="mt-1 flex flex-wrap gap-x-3 text-xs text-text-tertiary">
            <span>{item.assignee || 'Unassigned'}</span>
            {item.iterationPath ? <span>{item.iterationPath}</span> : null}
          </span>
        </button>
      </div>
      {expanded && hasChildren
        ? item.children!.map((child) => (
            <WorkItemCard
              key={child.id}
              item={child}
              depth={depth + 1}
              activeId={activeId}
              onSelect={onSelect}
            />
          ))
        : null}
    </div>
  );
}
