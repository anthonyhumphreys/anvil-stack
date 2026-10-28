import { MessageSquarePlus, Wrench, EyeOff } from 'lucide-react';
import {
  countBySeverity,
  isActiveFinding,
  type SurfaceFinding,
} from '../../../../../shared/surfaces/kinds/findings';
import { Button, IconButton } from '../../../ui';
import type { SurfaceViewProps } from '../../types';
import { SeverityBadge, SeveritySummaryBar } from '../../shared-ui/SeverityGlyph';
import { ActionStatusLine, SurfaceSkeleton } from '../../shared-ui/useSurfaceActions';
import { AuditProgress, FindingLocation } from './FindingParts';
import { readFindingsData, topActiveFindings } from './model';
import { useFindingsActions } from './useFindingsActions';

const INLINE_TOP = 5;

function InlineFindingRow({
  finding,
  onOpen,
  onAskFix,
  onDismiss,
  onComment,
  busy,
}: {
  finding: SurfaceFinding;
  onOpen: () => void;
  onAskFix: () => void;
  onDismiss: () => void;
  onComment: () => void;
  busy: boolean;
}) {
  return (
    <li className="group flex items-start gap-3 border-b border-border-subtle py-2 last:border-b-0 motion-safe:animate-[fadeIn_160ms_ease-out]">
      <SeverityBadge severity={finding.severity} compact className="mt-1" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button
          type="button"
          onClick={onOpen}
          className="text-left text-sm text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded-sm"
        >
          {finding.title}
        </button>
        <FindingLocation finding={finding} />
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none">
        <IconButton icon={Wrench} label="Ask agent to fix" disabled={busy} onClick={onAskFix} />
        <IconButton icon={EyeOff} label="Dismiss" disabled={busy} onClick={onDismiss} />
        <IconButton icon={MessageSquarePlus} label="Comment" onClick={onComment} />
      </div>
    </li>
  );
}

export function FindingsInline(props: SurfaceViewProps) {
  const { intent, onOpenStage } = props;
  const data = readFindingsData(intent.payload.data);
  const { handlers, status, confirmDialog } = useFindingsActions(props, data.findings);
  const active = data.findings.filter(isActiveFinding);
  const top = topActiveFindings(data.findings, INLINE_TOP);
  const streaming = intent.payload.streaming;

  if (streaming && data.findings.length === 0 && data.auditStatus !== 'running') {
    return <SurfaceSkeleton label="Loading findings" />;
  }

  return (
    <section aria-label={intent.payload.title} className="flex flex-col gap-3">
      <AuditProgress data={data} />
      {data.auditStatus === 'failed' && (
        <p className="text-sm text-error">{data.summary ?? 'The audit failed.'}</p>
      )}
      {data.summary && data.auditStatus !== 'failed' && (
        <p className="max-w-[72ch] text-sm leading-relaxed text-text-secondary">{data.summary}</p>
      )}
      {data.findings.length > 0 && (
        <SeveritySummaryBar counts={countBySeverity(active)} label="Active findings by severity" />
      )}
      {top.length > 0 ? (
        <ul aria-label="Top findings" className="flex flex-col">
          {top.map((finding) => (
            <InlineFindingRow
              key={finding.id}
              finding={finding}
              busy={handlers.pending !== null}
              onOpen={() => onOpenStage(finding.id)}
              onAskFix={() => handlers.onAskFix([finding.id])}
              onDismiss={() => handlers.onDismiss([finding.id])}
              onComment={() => handlers.onComment(finding)}
            />
          ))}
        </ul>
      ) : (
        data.auditStatus !== 'running' &&
        !streaming && (
          <p className="text-sm text-text-tertiary">
            {data.findings.length === 0
              ? 'No findings.'
              : 'No active findings. Everything is dismissed or fixed.'}
          </p>
        )
      )}
      <div className="flex flex-wrap items-center gap-2">
        {active.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            disabled={handlers.pending !== null}
            onClick={() => handlers.onAskFix(top.map((finding) => finding.id))}
          >
            Ask agent to fix top {top.length}
          </Button>
        )}
        {data.findings.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onOpenStage()}>
            {data.findings.length > top.length
              ? `Open all ${data.findings.length} findings`
              : 'Open findings'}
          </Button>
        )}
      </div>
      <ActionStatusLine status={status} />
      {confirmDialog}
    </section>
  );
}
