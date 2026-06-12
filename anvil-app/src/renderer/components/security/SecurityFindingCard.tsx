import { useState } from 'react';
import type { SecurityFinding } from '../../../shared/types';
import {
  ChevronDown,
  ChevronRight,
  TicketPlus,
  EyeOff,
  ExternalLink,
  MessageSquarePlus,
  SquareTerminal,
} from 'lucide-react';

interface Props {
  finding: SecurityFinding;
  selected: boolean;
  onToggleSelect: () => void;
  onDismiss: () => void;
  onCreateWorkItem: () => void;
  onInspectPath?: (path: string) => void;
  onAskChat?: () => void;
}

const severityColors: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400 border-red-500/30',
  high: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  medium: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  low: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  info: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
};

export function SecurityFindingCard({
  finding,
  selected,
  onToggleSelect,
  onDismiss,
  onCreateWorkItem,
  onInspectPath,
  onAskChat,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`rounded-lg border bg-bg-secondary transition-colors ${
        finding.dismissed ? 'opacity-50 border-border-subtle' : 'border-border'
      } ${selected ? 'ring-1 ring-accent' : ''}`}
    >
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="rounded"
          disabled={finding.dismissed}
          aria-label={`Select finding: ${finding.description.split('\n')[0].substring(0, 60)}`}
        />
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex flex-1 items-center gap-2 text-left"
          aria-label={expanded ? 'Collapse finding details' : 'Expand finding details'}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span
            className={`inline-block rounded border px-1.5 py-0.5 text-xs font-bold uppercase ${
              severityColors[finding.severity] || severityColors.info
            }`}
          >
            {finding.severity}
          </span>
          <span className="flex-1 text-sm text-text-primary">
            {finding.description.split('\n')[0].substring(0, 120)}
          </span>
          {finding.owaspRef && (
            <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-xs text-text-tertiary">
              {finding.owaspRef}
            </span>
          )}
          {finding.cweRef && (
            <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-xs text-text-tertiary">
              {finding.cweRef}
            </span>
          )}
        </button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border-subtle px-4 py-3">
          <p className="mb-3 whitespace-pre-line text-sm text-text-secondary">
            {finding.description}
          </p>

          {finding.affectedFiles.length > 0 && (
            <div className="mb-3">
              <p className="mb-1 text-sm font-medium text-text-tertiary">Affected Files</p>
              <div className="flex flex-wrap gap-1">
                {finding.affectedFiles.map((f) => (
                  <button
                    key={f}
                    onClick={() => onInspectPath?.(f)}
                    className="rounded bg-bg-elevated px-2 py-0.5 font-mono text-xs text-text-secondary transition-colors hover:bg-info/10 hover:text-info"
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          )}

          {finding.remediation && (
            <div className="mb-3">
              <p className="mb-1 text-sm font-medium text-text-tertiary">Remediation</p>
              <p className="whitespace-pre-line text-sm text-text-secondary">
                {finding.remediation}
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2">
            {finding.affectedFiles.length > 0 && onInspectPath && (
              <button
                onClick={() => onInspectPath(finding.affectedFiles[0])}
                className="flex items-center gap-1 rounded-md bg-info/10 px-2.5 py-1 text-sm text-info transition-colors hover:bg-info/20"
                aria-label="Inspect first affected file"
              >
                <SquareTerminal size={12} />
                Inspect
              </button>
            )}
            {!finding.dismissed && onAskChat && (
              <button
                onClick={onAskChat}
                className="flex items-center gap-1 rounded-md bg-success/10 px-2.5 py-1 text-sm text-success transition-colors hover:bg-success/20"
                aria-label="Ask Chat to fix finding"
              >
                <MessageSquarePlus size={12} />
                Ask Chat
              </button>
            )}
            {!finding.workItemId && !finding.dismissed && (
              <button
                onClick={onCreateWorkItem}
                className="flex items-center gap-1 rounded-md bg-accent/10 px-2.5 py-1 text-sm text-accent transition-colors hover:bg-accent/20"
                aria-label="Create work item from finding"
              >
                <TicketPlus size={12} />
                Create Work Item
              </button>
            )}
            {finding.workItemId && (
              <span className="flex items-center gap-1 text-xs text-success">
                <ExternalLink size={12} />
                {finding.workItemId}
              </span>
            )}
            {!finding.dismissed && (
              <button
                onClick={onDismiss}
                className="flex items-center gap-1 rounded-md px-2.5 py-1 text-sm text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-secondary"
                aria-label="Dismiss finding"
              >
                <EyeOff size={12} />
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
