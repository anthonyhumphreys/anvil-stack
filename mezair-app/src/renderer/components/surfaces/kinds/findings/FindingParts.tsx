import { Check, CircleDashed, EyeOff, Ticket, Wrench } from 'lucide-react';
import {
  FINDING_STATUS_LABELS,
  findingLocation,
  type FindingStatus,
  type FindingsSurfaceData,
  type SurfaceFinding,
} from '../../../../../shared/surfaces/kinds/findings';
import { Button, cx } from '../../../ui';
import { SeverityBadge } from '../../shared-ui/SeverityGlyph';

const STATUS_ICON: Record<FindingStatus, typeof Check> = {
  open: CircleDashed,
  'fix-requested': Wrench,
  fixed: Check,
  dismissed: EyeOff,
};

export function FindingStatusLabel({ status }: { status: FindingStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 text-xs',
        status === 'fixed'
          ? 'text-success'
          : status === 'dismissed'
            ? 'text-text-tertiary'
            : 'text-text-secondary',
      )}
    >
      <Icon size={12} aria-hidden="true" />
      {FINDING_STATUS_LABELS[status]}
    </span>
  );
}

export function FindingLocation({ finding }: { finding: SurfaceFinding }) {
  const location = findingLocation(finding);
  if (!location) return null;
  return <code className="break-all font-mono text-xs text-text-secondary">{location}</code>;
}

export function AuditProgress({ data }: { data: FindingsSurfaceData }) {
  if (data.auditStatus !== 'running') return null;
  const percent = Math.round(data.progress?.percent ?? 0);
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="progressbar"
        aria-label="Security audit progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1 w-full overflow-hidden rounded-full bg-bg-tertiary"
      >
        <div
          className="h-full bg-info transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-xs text-text-tertiary">
        {data.progress?.message ?? 'Starting audit…'} · {percent}%
      </p>
    </div>
  );
}

export interface FindingActionHandlers {
  onAskFix: (ids: string[]) => void;
  onDismiss: (ids: string[]) => void;
  onCreateWorkItems: (ids: string[]) => void;
  /** False in read-only threads: work item creation is a mutation. */
  canCreateWorkItems: boolean;
  onComment: (finding: SurfaceFinding) => void;
  pending: string | null;
}

export function FindingDetail({
  finding,
  handlers,
}: {
  finding: SurfaceFinding;
  handlers: FindingActionHandlers;
}) {
  const closed = finding.status === 'dismissed' || finding.status === 'fixed';
  return (
    <article aria-label={`Finding: ${finding.title}`} className="flex flex-col gap-3">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <SeverityBadge severity={finding.severity} />
          <FindingStatusLabel status={finding.status} />
          {finding.category && (
            <span className="text-xs text-text-tertiary">{finding.category}</span>
          )}
        </div>
        <h3 className="text-sm font-semibold text-text-primary">{finding.title}</h3>
        <FindingLocation finding={finding} />
        {finding.package && !finding.filePath && (
          <code className="font-mono text-xs text-text-secondary">{finding.package}</code>
        )}
      </header>
      {finding.detail && (
        <p className="max-w-[72ch] whitespace-pre-wrap break-words text-sm leading-relaxed text-text-secondary">
          {finding.detail}
        </p>
      )}
      {finding.recommendation && (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-text-tertiary">Recommendation</h4>
          <p className="max-w-[72ch] whitespace-pre-wrap break-words text-sm leading-relaxed text-text-secondary">
            {finding.recommendation}
          </p>
        </section>
      )}
      {(finding.refs?.length || finding.workItemId) && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {finding.refs?.length ? (
            <>
              <dt className="text-text-tertiary">References</dt>
              <dd className="break-words font-mono text-text-secondary">
                {finding.refs.join(' · ')}
              </dd>
            </>
          ) : null}
          {finding.workItemId && (
            <>
              <dt className="text-text-tertiary">Work item</dt>
              <dd className="inline-flex items-center gap-1 font-mono text-text-secondary">
                <Ticket size={12} aria-hidden="true" />
                {finding.workItemId}
              </dd>
            </>
          )}
        </dl>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={closed || handlers.pending !== null}
          onClick={() => handlers.onAskFix([finding.id])}
        >
          Ask agent to fix
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={finding.status === 'dismissed' || handlers.pending !== null}
          onClick={() => handlers.onDismiss([finding.id])}
        >
          Dismiss
        </Button>
        {handlers.canCreateWorkItems && (
          <Button
            size="sm"
            variant="secondary"
            disabled={Boolean(finding.workItemId) || handlers.pending !== null}
            onClick={() => handlers.onCreateWorkItems([finding.id])}
          >
            Create work item
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => handlers.onComment(finding)}>
          Comment
        </Button>
      </div>
    </article>
  );
}
