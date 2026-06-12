import { useState } from 'react';
import {
  Bug,
  BookOpen,
  Lightbulb,
  CheckSquare,
  Layers,
  ChevronRight,
  ChevronDown,
  FileText,
  Wrench,
  MessageSquare,
  ExternalLink,
  GitCompareArrows,
} from 'lucide-react';
import type { WorkItem } from '../../../shared/types';

const PRIORITY_COLOURS: Record<number, string> = {
  1: 'bg-error',
  2: 'bg-warning',
  3: 'bg-info',
  4: 'bg-text-tertiary',
};

const TYPE_ICONS: Record<string, React.ReactNode> = {
  Bug: <Bug size={12} />,
  'User Story': <BookOpen size={12} />,
  Feature: <Lightbulb size={12} />,
  Task: <CheckSquare size={12} />,
  Epic: <Layers size={12} />,
};

const TYPE_COLOURS: Record<string, string> = {
  Bug: 'border-error/50 text-error',
  'User Story': 'border-info/50 text-info',
  Feature: 'border-accent/50 text-accent',
  Task: 'border-success/50 text-success',
  Epic: 'border-warning/50 text-warning',
};

const TYPE_BORDER_COLOURS: Record<string, string> = {
  Bug: 'border-l-error',
  'User Story': 'border-l-info',
  Feature: 'border-l-accent',
  Task: 'border-l-success',
  Epic: 'border-l-warning',
};

interface WorkItemCardProps {
  item: WorkItem;
  depth: number;
  activeId?: string;
  impactAssessmentEnabled: boolean;
  onAction: (item: WorkItem, action: 'plan' | 'fix' | 'ba' | 'impact') => void;
}

export function WorkItemCard({
  item,
  depth,
  activeId,
  impactAssessmentEnabled,
  onAction,
}: WorkItemCardProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = item.children && item.children.length > 0;
  const canAssessImpact = item.type === 'Epic' || item.type === 'Feature';

  return (
    <div>
      <div
        className={`flex items-center gap-3 border-l-2 px-4 py-3 transition-colors hover:bg-bg-tertiary ${
          TYPE_BORDER_COLOURS[item.type] ?? 'border-l-border'
        } ${activeId === item.id ? 'bg-bg-tertiary' : ''}`}
        style={{ paddingLeft: `${16 + depth * 20}px` }}
      >
        {/* Expand/collapse toggle */}
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? 'Collapse children' : 'Expand children'}
            className="shrink-0 rounded p-1 text-text-tertiary hover:text-text-primary"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-[18px] shrink-0" /> // spacer
        )}

        {/* Priority dot */}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${PRIORITY_COLOURS[item.priority] ?? 'bg-text-tertiary'}`}
        />

        {/* ID */}
        <span className="shrink-0 font-mono text-sm text-text-secondary">#{item.id}</span>

        {/* Type badge */}
        <span
          className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-sm ${TYPE_COLOURS[item.type] ?? 'border-border text-text-tertiary'}`}
        >
          {TYPE_ICONS[item.type]}
          {item.type}
        </span>

        {/* Title */}
        <span className="flex-1 truncate text-base text-text-primary">{item.title}</span>

        {/* Tags */}
        {item.tags && item.tags.length > 0 && (
          <div className="flex shrink-0 gap-1">
            {item.tags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-border px-2 py-1 text-sm text-text-secondary"
              >
                {tag}
              </span>
            ))}
            {item.tags.length > 2 && (
              <span className="text-sm text-text-secondary">+{item.tags.length - 2}</span>
            )}
          </div>
        )}

        {/* State */}
        <span className="shrink-0 text-sm text-text-secondary">{item.state}</span>

        {/* Actions */}
        <div className="flex shrink-0 gap-1">
          {canAssessImpact && (
            <button
              onClick={() => onAction(item, 'impact')}
              disabled={!impactAssessmentEnabled}
              className="rounded-md px-2.5 py-1.5 text-sm text-warning hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-40"
              title={
                impactAssessmentEnabled
                  ? 'Launch impact assessment'
                  : 'Index repositories to unlock impact assessment'
              }
              aria-label="Launch impact assessment"
            >
              <GitCompareArrows size={14} />
            </button>
          )}
          <button
            onClick={() => onAction(item, 'plan')}
            className="rounded-md px-2.5 py-1.5 text-sm text-info hover:bg-info/10"
            title="Generate plan"
            aria-label="Generate plan"
          >
            <FileText size={14} />
          </button>
          <button
            onClick={() => onAction(item, 'fix')}
            className="rounded-md px-2.5 py-1.5 text-sm text-success hover:bg-success/10"
            title="Generate fix prompt"
            aria-label="Generate fix prompt"
          >
            <Wrench size={14} />
          </button>
          <button
            onClick={() => onAction(item, 'ba')}
            className="rounded-md px-2.5 py-1.5 text-sm text-accent hover:bg-accent/10"
            title="BA Chat"
            aria-label="BA Chat"
          >
            <MessageSquare size={14} />
          </button>
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md px-2.5 py-1.5 text-sm text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
              title="Open in browser"
              aria-label="Open in browser"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      </div>

      {item.extras &&
        Object.keys(item.extras).filter((k) => k !== 'originalType' && item.extras![k] != null)
          .length > 0 && (
          <div
            className="flex flex-wrap gap-x-4 gap-y-1 border-l-2 border-l-transparent px-4 pb-2 text-sm text-text-secondary"
            style={{ paddingLeft: `${36 + depth * 20}px` }}
          >
            {item.extras.estimate != null && <span>Estimate: {String(item.extras.estimate)}</span>}
            {item.extras.storyPoints != null && (
              <span>Story Points: {String(item.extras.storyPoints)}</span>
            )}
            {item.extras.cycle != null && <span>Cycle: {String(item.extras.cycle)}</span>}
            {item.extras.sprint != null && <span>Sprint: {String(item.extras.sprint)}</span>}
            {item.extras.project != null && <span>Project: {String(item.extras.project)}</span>}
            {Array.isArray(item.extras.components) && item.extras.components.length > 0 && (
              <span>Components: {item.extras.components.map(String).join(', ')}</span>
            )}
          </div>
        )}

      {/* Children */}
      {hasChildren && expanded && (
        <div>
          {item.children!.map((child) => (
            <WorkItemCard
              key={child.id}
              item={child}
              depth={depth + 1}
              activeId={activeId}
              impactAssessmentEnabled={impactAssessmentEnabled}
              onAction={onAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}
