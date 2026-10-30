import { splitByFindings } from '../../utils/finding-parser';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import type { BaFindingType } from '../../../shared/types';

const FINDING_STYLES: Record<
  BaFindingType,
  { border: string; bg: string; text: string; label: string }
> = {
  compliance: {
    border: 'border-l-warning',
    bg: 'bg-warning/5',
    text: 'text-warning',
    label: 'Compliance',
  },
  feasibility: {
    border: 'border-l-info',
    bg: 'bg-info/5',
    text: 'text-info',
    label: 'Feasibility',
  },
  dependency: {
    border: 'border-l-warning',
    bg: 'bg-warning/10',
    text: 'text-warning',
    label: 'Dependency',
  },
  question: {
    border: 'border-l-text-tertiary',
    bg: 'bg-text-tertiary/5',
    text: 'text-text-tertiary',
    label: 'Question',
  },
  risk: {
    border: 'border-l-error',
    bg: 'bg-error/5',
    text: 'text-error',
    label: 'Risk',
  },
};

interface BaMessageContentProps {
  content: string;
}

export function BaMessageContent({ content }: BaMessageContentProps) {
  const segments = splitByFindings(content);

  return (
    <div className="space-y-2">
      {segments.map((segment, i) => {
        if (segment.kind === 'text') {
          return <MarkdownRenderer key={i} content={segment.content} />;
        }

        const style = FINDING_STYLES[segment.type] ?? FINDING_STYLES.question;

        return (
          <div
            key={i}
            className={`my-2 rounded-md border-l-2 ${style.border} ${style.bg} px-3 py-3`}
          >
            <span
              className={`mb-1 inline-block text-xs font-semibold uppercase tracking-wider ${style.text}`}
            >
              {style.label}
            </span>
            <div className="text-base leading-relaxed text-text-primary">
              <MarkdownRenderer content={segment.content} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
