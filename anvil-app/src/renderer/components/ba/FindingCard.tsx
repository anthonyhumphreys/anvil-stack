import { ArrowUpRight, TicketPlus, X } from 'lucide-react';
import type { BaFinding } from '../../../shared/types';

const TYPE_STYLES: Record<string, { bg: string; border: string; text: string; label: string }> = {
  compliance: {
    bg: 'bg-warning/5',
    border: 'border-warning/20',
    text: 'text-warning',
    label: 'Compliance',
  },
  feasibility: {
    bg: 'bg-info/5',
    border: 'border-info/20',
    text: 'text-info',
    label: 'Feasibility',
  },
  dependency: {
    bg: 'bg-warning/10',
    border: 'border-warning/25',
    text: 'text-warning',
    label: 'Dependency',
  },
  question: {
    bg: 'bg-text-tertiary/5',
    border: 'border-text-tertiary/20',
    text: 'text-text-tertiary',
    label: 'Question',
  },
  risk: {
    bg: 'bg-error/5',
    border: 'border-error/20',
    text: 'text-error',
    label: 'Risk',
  },
};

interface FindingCardProps {
  finding: BaFinding;
  onDismiss: (id: string) => void;
  onCreateWorkItem: (finding: BaFinding) => void;
}

export function FindingCard({ finding, onDismiss, onCreateWorkItem }: FindingCardProps) {
  if (finding.status !== 'open') return null;

  const style = TYPE_STYLES[finding.type] ?? TYPE_STYLES.question;

  return (
    <div className={`rounded-lg border ${style.border} ${style.bg} px-3 py-3`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <span
            className={`inline-block rounded-full px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide ${style.text}`}
          >
            {style.label}
          </span>
          <p className="mt-2 text-base leading-relaxed text-text-secondary">{finding.content}</p>
        </div>
        <button
          onClick={() => onDismiss(finding.id)}
          className="shrink-0 rounded-md p-1 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
          title="Dismiss finding"
        >
          <X size={14} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {finding.followUpWorkItemId ? (
          <>
            {finding.followUpWorkItemUrl ? (
              <a
                href={finding.followUpWorkItemUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium text-success transition-colors hover:bg-success/15"
              >
                {finding.followUpWorkItemTitle ?? finding.followUpWorkItemId}
                <ArrowUpRight size={12} />
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
                {finding.followUpWorkItemTitle ?? finding.followUpWorkItemId}
              </span>
            )}
            <span className="text-xs uppercase tracking-wide text-text-tertiary">
              {finding.followUpWorkItemProvider}
            </span>
          </>
        ) : (
          <button
            onClick={() => onCreateWorkItem(finding)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-primary px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-accent/35 hover:bg-accent/8 hover:text-text-primary"
          >
            <TicketPlus size={12} />
            Create work item
          </button>
        )}
      </div>
    </div>
  );
}
