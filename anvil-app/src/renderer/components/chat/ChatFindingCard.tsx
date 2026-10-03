import { X } from 'lucide-react';
import type { ExtractedFinding } from '../../utils/finding-parser';

/**
 * BA findings sidebar card — extracted from ChatView (Phase 5 split).
 */

const FINDING_TYPE_STYLES: Record<
  string,
  { bg: string; border: string; text: string; label: string }
> = {
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
  risk: { bg: 'bg-error/5', border: 'border-error/20', text: 'text-error', label: 'Risk' },
  security: { bg: 'bg-error/5', border: 'border-error/20', text: 'text-error', label: 'Security' },
};

export function ChatFindingCard({
  finding,
  onFollowUp,
  onDismiss,
}: {
  finding: ExtractedFinding;
  onFollowUp: () => void;
  onDismiss: () => void;
}) {
  const style = FINDING_TYPE_STYLES[finding.type] ?? FINDING_TYPE_STYLES.question;
  return (
    <div className={`rounded-xl border ${style.border} ${style.bg} px-3 py-2.5`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span
            className={`inline-block rounded-full px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide ${style.text}`}
          >
            {style.label}
          </span>
          <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{finding.content}</p>
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 rounded-lg p-1 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
          title="Dismiss finding"
        >
          <X size={13} />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={onFollowUp}
          className="rounded-lg border border-border/70 px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
        >
          Follow up
        </button>
      </div>
    </div>
  );
}

export function buildFindingFollowUpPrompt(finding: ExtractedFinding): string {
  const label = FINDING_TYPE_STYLES[finding.type]?.label ?? 'Finding';

  return [
    `Let's follow up on this BA ${label.toLowerCase()} finding:`,
    finding.content,
    '',
    'Please expand on:',
    '- the evidence in the current repos or requirements that led to this finding',
    '- the concrete implementation or delivery impact',
    '- what has likely been overlooked or needs clarification',
    '- the recommended next action or decision',
  ].join('\n');
}
