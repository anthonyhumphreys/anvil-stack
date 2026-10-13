import { Hourglass } from 'lucide-react';
import { DECISION_LABEL, verdictHeadline } from '../../../../../shared/surfaces/kinds/review/model';
import type { ReviewSurfaceData } from '../../../../../shared/surfaces/kinds/review/types';
import { cx } from '../../../ui';
import { DecisionGlyph, DiffStat } from './ReviewGlyphs';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** True while findings are still arriving and the verdict is only Anvil's running tally. */
export function isProvisionalVerdict(data: ReviewSurfaceData, streaming: boolean): boolean {
  return streaming && data.verdict.source !== 'agent';
}

export function ReviewFacts({ data, className }: { data: ReviewSurfaceData; className?: string }) {
  return (
    <p
      className={cx('flex flex-wrap items-center gap-x-1.5 text-xs text-text-tertiary', className)}
    >
      <span>{plural(data.stats.files, 'file')}</span>
      <span aria-hidden="true">·</span>
      <DiffStat additions={data.stats.additions} deletions={data.stats.deletions} />
      <span aria-hidden="true">·</span>
      <span>{plural(data.risks.length, 'risk')}</span>
      <span aria-hidden="true">·</span>
      <span>{plural(data.findings.length, 'finding')}</span>
    </p>
  );
}

/** The verdict: one sentence plus three facts, with a decision glyph and label. */
export function ReviewVerdictLine({
  data,
  streaming,
  compact = false,
}: {
  data: ReviewSurfaceData;
  streaming: boolean;
  compact?: boolean;
}) {
  const provisional = isProvisionalVerdict(data, streaming);
  const decision = data.verdict.decision;
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      {provisional ? (
        <span className="mt-0.5 inline-flex shrink-0 text-text-tertiary">
          <Hourglass size={compact ? 16 : 18} aria-hidden="true" />
        </span>
      ) : (
        <DecisionGlyph decision={decision} size={compact ? 16 : 18} className="mt-0.5" />
      )}
      <div className="min-w-0">
        <p
          className={cx(
            'max-w-[72ch] text-sm leading-[1.65] text-text-secondary',
            compact && 'truncate',
          )}
        >
          {provisional ? (
            <>
              <span className="font-semibold text-text-primary">Reviewing</span>
              <span className="text-text-tertiary"> · </span>
              {plural(data.findings.length, 'finding')} so far
            </>
          ) : (
            <>
              <span className="font-semibold text-text-primary">
                {verdictHeadline(decision, data.findings)}
              </span>
              <span className="sr-only"> ({DECISION_LABEL[decision]})</span>
              <span className="text-text-tertiary"> · </span>
              {data.verdict.summary}
            </>
          )}
        </p>
        {compact ? null : <ReviewFacts data={data} className="mt-0.5" />}
      </div>
    </div>
  );
}
