import { AlertTriangle, Info, XCircle } from 'lucide-react';
import {
  upstreamNodes,
  type PipelineIssue,
  type PipelineNode,
  type PipelineSurfaceData,
} from '../../../../../shared/surfaces/kinds/pipeline';
import { Button, cx } from '../../../ui';
import { STATUS_META } from './model';

export function IssueLine({ issue, nodeLabel }: { issue: PipelineIssue; nodeLabel?: string }) {
  const Icon =
    issue.severity === 'error' ? XCircle : issue.severity === 'warning' ? AlertTriangle : Info;
  return (
    <li className="flex items-start gap-2 py-1 text-xs">
      <Icon
        size={13}
        aria-hidden="true"
        className={cx(
          'mt-0.5 shrink-0',
          issue.severity === 'error'
            ? 'text-error'
            : issue.severity === 'warning'
              ? 'text-warning'
              : 'text-info',
        )}
      />
      <span className="min-w-0 text-text-secondary">
        <span className="sr-only">{issue.severity}: </span>
        {issue.message}
        <span className="block break-all font-mono text-text-tertiary">
          {issue.filePath}
          {nodeLabel ? ` · ${nodeLabel}` : ''}
        </span>
      </span>
    </li>
  );
}

export function PipelineFacts({ data }: { data: PipelineSurfaceData }) {
  const errors = data.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = data.issues.filter((issue) => issue.severity === 'warning').length;
  const jobs = data.nodes.filter((node) => node.type === 'job').length;
  const facts = [
    `${data.files.length} file${data.files.length === 1 ? '' : 's'}`,
    data.providers.length ? data.providers.join(', ') : undefined,
    `${jobs} job${jobs === 1 ? '' : 's'}`,
    `${errors} error${errors === 1 ? '' : 's'}`,
    `${warnings} warning${warnings === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return <p className="text-sm text-text-secondary">{facts.join(' · ')}</p>;
}

export function NodeDetail({
  data,
  node,
  issues,
  onAskFix,
  onComment,
  busy,
}: {
  data: PipelineSurfaceData;
  node: PipelineNode;
  issues: PipelineIssue[];
  onAskFix: () => void;
  onComment: () => void;
  busy: boolean;
}) {
  const meta = STATUS_META[node.status];
  const upstream = upstreamNodes(data, node.id);
  const downstream = data.edges
    .filter((edge) => edge.from === node.id)
    .map((edge) => data.nodes.find((candidate) => candidate.id === edge.to))
    .filter((candidate): candidate is PipelineNode => Boolean(candidate));
  const excerptLines = node.excerpt?.split('\n') ?? [];
  const firstLine = node.excerptStartLine ?? 1;
  return (
    <article aria-label={`Node ${node.label}`} className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <p className={cx('text-xs font-medium', meta.textClass)}>
          {meta.label} · {node.type}
        </p>
        <h3 className="break-words text-sm font-semibold text-text-primary">{node.label}</h3>
        {node.subtitle && <p className="text-xs text-text-secondary">{node.subtitle}</p>}
        <code className="break-all font-mono text-xs text-text-tertiary">
          {node.filePath}
          {node.excerptStartLine ? `:${node.excerptStartLine}` : ''}
        </code>
      </header>
      {issues.length > 0 && (
        <section className="flex flex-col">
          <h4 className="text-xs font-medium text-text-tertiary">Validation</h4>
          <ul>
            {issues.map((issue) => (
              <IssueLine key={issue.id} issue={issue} />
            ))}
          </ul>
        </section>
      )}
      {excerptLines.length > 0 && (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-text-tertiary">YAML</h4>
          <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-bg-secondary p-2 font-mono text-xs leading-relaxed text-text-secondary">
            {excerptLines.map((line, index) => (
              <span key={index} className="block">
                <span
                  aria-hidden="true"
                  className="mr-3 inline-block w-8 select-none text-right text-text-muted"
                >
                  {firstLine + index}
                </span>
                {line || ' '}
              </span>
            ))}
          </pre>
        </section>
      )}
      {(upstream.length > 0 || downstream.length > 0) && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {upstream.length > 0 && (
            <>
              <dt className="text-text-tertiary">Upstream</dt>
              <dd className="text-text-secondary">
                {upstream.map((entry) => entry.label).join(', ')}
              </dd>
            </>
          )}
          {downstream.length > 0 && (
            <>
              <dt className="text-text-tertiary">Downstream</dt>
              <dd className="text-text-secondary">
                {downstream.map((entry) => entry.label).join(', ')}
              </dd>
            </>
          )}
        </dl>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={onAskFix}>
          Ask agent to fix
        </Button>
        <Button size="sm" variant="ghost" onClick={onComment}>
          Comment
        </Button>
      </div>
    </article>
  );
}
