import { useState, type ReactNode } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  CircleDot,
  Clock3,
  ExternalLink,
  FileText,
  FolderGit2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Info,
  Layers,
  Lightbulb,
  Link2,
  Loader2,
  MessageSquare,
  MinusCircle,
  PauseCircle,
  ShieldAlert,
  StickyNote,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { AutomationRunStatus, ChatThreadAttentionState } from '../../../shared/types';
import {
  visibleColumns,
  type OverviewActivityEventType,
  type OverviewActivityRow,
  type OverviewAutomationRunRow,
  type OverviewDocumentRow,
  type OverviewFindingRow,
  type OverviewIdeaRow,
  type OverviewModuleInstance,
  type OverviewModuleResult,
  type OverviewPinnedLink,
  type OverviewPullRequestRow,
  type OverviewRepositoryRow,
  type OverviewScope,
  type OverviewSessionRow,
  type OverviewTarget,
  type OverviewTicketRow,
  type OverviewTone,
  type OverviewWorkspaceRow,
} from '../../../shared/overview';
import { Button, cx } from '../ui';
import { formatRelativeTime, plural, TONE_TEXT_CLASSES } from './overview-format';

interface ContentProps {
  module: OverviewModuleInstance;
  result: OverviewModuleResult;
  scope: OverviewScope;
  now: number;
  onOpen: (target: OverviewTarget) => void;
}

export function OverviewModuleContent(props: ContentProps) {
  const { result } = props;
  switch (result.type) {
    case 'activity':
      return <ActivityTable {...props} rows={result.rows as OverviewActivityRow[]} />;
    case 'pull-requests':
      return <PullRequestTable {...props} rows={result.rows as OverviewPullRequestRow[]} />;
    case 'findings':
      return <FindingList {...props} rows={result.rows as OverviewFindingRow[]} />;
    case 'workspaces':
      return <WorkspaceTable {...props} rows={result.rows as OverviewWorkspaceRow[]} />;
    case 'repositories':
      return <RepositoryTable {...props} rows={result.rows as OverviewRepositoryRow[]} />;
    case 'tickets':
      return <TicketTable {...props} rows={result.rows as OverviewTicketRow[]} />;
    case 'ideas':
      return <IdeaTable {...props} rows={result.rows as OverviewIdeaRow[]} />;
    case 'sessions':
      return <SessionTable {...props} rows={result.rows as OverviewSessionRow[]} />;
    case 'automation-runs':
      return <AutomationRunTable {...props} rows={result.rows as OverviewAutomationRunRow[]} />;
    case 'documentation':
      return <DocumentTable {...props} rows={result.rows as OverviewDocumentRow[]} />;
    case 'pinned-links':
      return <PinnedLinkList {...props} rows={result.rows as OverviewPinnedLink[]} />;
  }
}

// ---------------------------------------------------------------------------
// Table primitives
// ---------------------------------------------------------------------------

interface Column {
  id: string;
  label: string;
  className?: string;
}

function Table({
  columns,
  visible,
  label,
  children,
}: {
  columns: Column[];
  visible: Set<string>;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-0 table-auto border-collapse text-left" aria-label={label}>
        <thead>
          <tr className="text-xs text-text-tertiary">
            {columns
              .filter((column) => visible.has(column.id))
              .map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className={cx(
                    'whitespace-nowrap px-4 pb-1.5 pt-0.5 font-medium first:pl-4',
                    column.className,
                  )}
                >
                  {column.label}
                </th>
              ))}
          </tr>
        </thead>
        <tbody className="text-sm">{children}</tbody>
      </table>
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <tr className="group border-t border-border-subtle transition-colors hover:bg-bg-tertiary/40">
      {children}
    </tr>
  );
}

function Cell({
  show = true,
  className,
  children,
}: {
  show?: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (!show) return null;
  return <td className={cx('px-4 py-2 align-middle', className)}>{children}</td>;
}

/** The row's primary cell: a real button so rows are keyboard reachable. */
function OpenCell({
  icon: Icon,
  iconClassName,
  title,
  detail,
  target,
  onOpen,
  external,
}: {
  icon?: LucideIcon;
  iconClassName?: string;
  title: string;
  detail?: string;
  target: OverviewTarget;
  onOpen: (target: OverviewTarget) => void;
  external?: boolean;
}) {
  return (
    <td className="max-w-0 px-4 py-2 align-middle">
      <button
        type="button"
        onClick={() => onOpen(target)}
        className="flex w-full min-w-0 items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        title={detail ? `${title}\n${detail}` : title}
      >
        {Icon && (
          <Icon
            size={15}
            className={cx('shrink-0 text-text-tertiary', iconClassName)}
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-text-primary group-hover:underline group-hover:decoration-text-tertiary group-hover:underline-offset-2">
            {title}
          </span>
          {detail && <span className="block truncate text-xs text-text-tertiary">{detail}</span>}
        </span>
        {external && (
          <ArrowUpRight
            size={13}
            className="shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100"
            aria-label="Opens in browser"
          />
        )}
      </button>
    </td>
  );
}

function Status({
  icon: Icon,
  tone,
  label,
  spin = false,
}: {
  icon: LucideIcon;
  tone: OverviewTone;
  label: string;
  spin?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-text-secondary">
      <Icon
        size={14}
        className={cx('shrink-0', TONE_TEXT_CLASSES[tone], spin && 'motion-safe:animate-spin')}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: OverviewTone }) {
  return (
    <span
      className={cx(
        'inline-flex max-w-full items-center truncate rounded-md px-1.5 py-0.5 text-xs font-medium',
        tone === 'neutral' && 'bg-bg-tertiary text-text-secondary',
        tone === 'info' && 'bg-info/12 text-info',
        tone === 'success' && 'bg-success/12 text-success',
        tone === 'warning' && 'bg-warning/12 text-warning',
        tone === 'error' && 'bg-error/12 text-error',
        tone === 'accent' && 'bg-accent/12 text-accent',
      )}
    >
      {children}
    </span>
  );
}

function When({ value, now }: { value?: string; now: number }) {
  return (
    <time
      dateTime={value}
      title={value ? new Date(value).toLocaleString() : undefined}
      className="whitespace-nowrap tabular-nums text-text-tertiary"
    >
      {formatRelativeTime(value, now)}
    </time>
  );
}

function WorkspaceLabel({ name }: { name?: string }) {
  return <span className="block max-w-[14rem] truncate text-text-secondary">{name ?? '—'}</span>;
}

const TONE_ICON: Record<OverviewTone, LucideIcon> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
  info: CircleDot,
  neutral: MinusCircle,
  accent: CircleDot,
};

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

const ACTIVITY_ICON: Record<OverviewActivityEventType, LucideIcon> = {
  'pull-request': GitPullRequest,
  session: MessageSquare,
  automation: Bot,
  finding: ShieldAlert,
  note: StickyNote,
};

function ActivityTable({
  module,
  scope,
  now,
  onOpen,
  rows,
}: ContentProps & { rows: OverviewActivityRow[] }) {
  const visible = visibleColumns(module);
  if (scope.kind === 'workspace') visible.delete('workspace');
  return (
    <Table
      label="Recent activity"
      visible={visible}
      columns={[
        { id: 'event', label: 'Change', className: 'w-full' },
        { id: 'workspace', label: 'Workspace' },
        { id: 'outcome', label: 'Outcome' },
        { id: 'when', label: 'When', className: 'text-right' },
      ]}
    >
      {rows.map((row) => (
        <Row key={row.id}>
          <OpenCell
            icon={ACTIVITY_ICON[row.kind]}
            title={row.title}
            detail={row.detail}
            target={row.target}
            onOpen={onOpen}
            external={Boolean(row.target.url)}
          />
          <Cell show={visible.has('workspace')}>
            <WorkspaceLabel name={row.workspaceName} />
          </Cell>
          <Cell show={visible.has('outcome')}>
            <Status icon={TONE_ICON[row.tone]} tone={row.tone} label={row.outcome} />
          </Cell>
          <Cell show={visible.has('when')} className="text-right">
            <When value={row.occurredAt} now={now} />
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

function pullRequestStatus(row: OverviewPullRequestRow) {
  if (row.state === 'merged') return { icon: GitMerge, tone: 'success' as const, label: 'Merged' };
  if (row.state === 'closed')
    return { icon: GitPullRequestClosed, tone: 'neutral' as const, label: 'Closed, unmerged' };
  if (row.isDraft) return { icon: GitPullRequestDraft, tone: 'neutral' as const, label: 'Draft' };
  return { icon: GitPullRequest, tone: 'info' as const, label: 'Open' };
}

function PullRequestTable({
  module,
  scope,
  now,
  onOpen,
  rows,
}: ContentProps & { rows: OverviewPullRequestRow[] }) {
  const visible = visibleColumns(module);
  const showWorkspace = scope.kind === 'global';
  return (
    <Table
      label="Pull requests"
      visible={visible}
      columns={[
        { id: 'number', label: '#' },
        { id: 'title', label: 'Title', className: 'w-full' },
        { id: 'repository', label: showWorkspace ? 'Repository · Workspace' : 'Repository' },
        { id: 'author', label: 'Author' },
        { id: 'status', label: 'Status' },
        { id: 'updated', label: 'Updated', className: 'text-right' },
      ]}
    >
      {rows.map((row) => {
        const status = pullRequestStatus(row);
        return (
          <Row key={row.id}>
            <Cell show={visible.has('number')} className="tabular-nums text-text-tertiary">
              #{row.number}
            </Cell>
            <OpenCell title={row.title} target={row.target} onOpen={onOpen} external />
            <Cell show={visible.has('repository')}>
              <span className="block max-w-[14rem] truncate text-text-secondary">
                {row.repoName}
                {showWorkspace && (
                  <span className="text-text-tertiary"> · {row.workspaceName}</span>
                )}
              </span>
            </Cell>
            <Cell show={visible.has('author')}>
              <span className="block max-w-[10rem] truncate text-text-secondary">
                {row.author ?? '—'}
              </span>
            </Cell>
            <Cell show={visible.has('status')}>
              <Status {...status} />
            </Cell>
            <Cell show={visible.has('updated')} className="text-right">
              <When value={row.updatedAt} now={now} />
            </Cell>
          </Row>
        );
      })}
    </Table>
  );
}

function FindingList({ scope, now, onOpen, rows }: ContentProps & { rows: OverviewFindingRow[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <ul
      className="divide-y divide-border-subtle border-t border-border-subtle"
      aria-label="Findings"
    >
      {rows.map((row) => {
        const open = expanded === row.id;
        const SeverityIcon =
          row.tone === 'error' ? AlertOctagon : row.tone === 'warning' ? AlertTriangle : Info;
        const evidenceId = `finding-evidence-${row.id.replace(/[^a-zA-Z0-9-]/g, '-')}`;
        const where =
          scope.kind === 'global' ? `${row.repoName} · ${row.workspaceName}` : row.repoName;
        return (
          <li key={row.id} className="px-4 py-3">
            <div className="flex items-start gap-3">
              <SeverityIcon
                size={16}
                className={cx('mt-0.5 shrink-0', TONE_TEXT_CLASSES[row.tone])}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary" title={row.title}>
                  {row.title}
                </p>
                <p className="truncate text-xs text-text-secondary" title={row.description}>
                  {row.description}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-text-tertiary">
                  <span className="capitalize">{row.severity}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{where}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {row.workItemId ? `Logged as ${row.workItemId}` : 'Suspected · Not logged'}
                  </span>
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                aria-expanded={open}
                aria-controls={evidenceId}
                onClick={() => setExpanded(open ? null : row.id)}
                className="shrink-0"
              >
                Evidence
                <ChevronDown
                  size={12}
                  className={cx('transition-transform', open && 'rotate-180')}
                  aria-hidden="true"
                />
              </Button>
            </div>
            {open && (
              <div id={evidenceId} className="mt-3 space-y-2 pl-7 text-xs leading-relaxed">
                <p className="max-w-[72ch] whitespace-pre-wrap break-words text-text-secondary">
                  {row.description}
                </p>
                {row.files.length > 0 && (
                  <ul className="space-y-0.5 font-mono text-text-tertiary">
                    {row.files.slice(0, 6).map((file) => (
                      <li key={file} className="truncate" title={file}>
                        {file}
                      </li>
                    ))}
                    {row.files.length > 6 && <li>+{row.files.length - 6} more</li>}
                  </ul>
                )}
                {row.remediation && (
                  <p className="max-w-[72ch] text-text-secondary">
                    <span className="font-medium text-text-primary">Suggested fix: </span>
                    {row.remediation}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button variant="primary" size="sm" onClick={() => onOpen(row.target)}>
                    {row.source === 'security' ? 'Review in Security' : 'Review in Code Review'}
                  </Button>
                  <span className="text-text-tertiary">
                    Log, link or dismiss it there.
                    {row.detectedAt &&
                      ` Detected ${formatRelativeTime(row.detectedAt, now).toLowerCase()}.`}
                    {row.alsoIn.length > 0 && ` Also in ${row.alsoIn.join(', ')}.`}
                  </span>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function WorkspaceTable({
  module,
  now,
  onOpen,
  rows,
}: ContentProps & { rows: OverviewWorkspaceRow[] }) {
  const visible = visibleColumns(module);
  return (
    <Table
      label="Workspaces"
      visible={visible}
      columns={[
        { id: 'workspace', label: 'Workspace', className: 'w-full' },
        { id: 'repositories', label: 'Repositories' },
        { id: 'activity', label: 'Latest activity' },
        { id: 'findings', label: 'Findings' },
      ]}
    >
      {rows.map((row) => (
        <Row key={row.workspaceId}>
          <OpenCell
            icon={Layers}
            title={row.name}
            detail={
              row.needsAttention > 0 ? `${plural(row.needsAttention, 'item')} need you` : undefined
            }
            target={row.target}
            onOpen={onOpen}
          />
          <Cell
            show={visible.has('repositories')}
            className="whitespace-nowrap tabular-nums text-text-secondary"
          >
            {plural(row.repoCount, 'repo')}
          </Cell>
          <Cell show={visible.has('activity')}>
            {row.latestActivityAt ? (
              <When value={row.latestActivityAt} now={now} />
            ) : (
              <span className="text-text-tertiary">No activity yet</span>
            )}
          </Cell>
          <Cell show={visible.has('findings')} className="whitespace-nowrap">
            {row.findingsToReview > 0 ? (
              <span className="font-medium text-warning">{row.findingsToReview} to review</span>
            ) : (
              <span className="text-text-tertiary">None to review</span>
            )}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

function RepositoryTable({
  module,
  now,
  onOpen,
  rows,
}: ContentProps & { rows: OverviewRepositoryRow[] }) {
  const visible = visibleColumns(module);
  return (
    <Table
      label="Repositories"
      visible={visible}
      columns={[
        { id: 'repository', label: 'Repository', className: 'w-full' },
        { id: 'branch', label: 'Branch' },
        { id: 'tree', label: 'Working tree' },
        { id: 'indexed', label: 'Indexed', className: 'text-right' },
      ]}
    >
      {rows.map((row) => (
        <Row key={row.repoId}>
          <OpenCell icon={FolderGit2} title={row.name} target={row.target} onOpen={onOpen} />
          <Cell show={visible.has('branch')}>
            {row.branch ? (
              <span className="inline-flex max-w-[12rem] items-center gap-1.5 text-text-secondary">
                <GitBranch size={13} className="shrink-0 text-text-tertiary" aria-hidden="true" />
                <span className="truncate font-mono text-xs">{row.branch}</span>
              </span>
            ) : (
              <span className="text-text-tertiary">—</span>
            )}
          </Cell>
          <Cell show={visible.has('tree')}>
            {row.gitError ? (
              <Status icon={AlertTriangle} tone="warning" label="Unavailable" />
            ) : row.changedFiles === undefined ? (
              <span className="text-text-tertiary">—</span>
            ) : row.changedFiles === 0 ? (
              <Status icon={CheckCircle2} tone="success" label="Clean" />
            ) : (
              <Status
                icon={FileText}
                tone="warning"
                label={`${plural(row.changedFiles, 'changed file')}`}
              />
            )}
          </Cell>
          <Cell show={visible.has('indexed')} className="text-right">
            {row.indexStatus === 'indexing' ? (
              <Status icon={Loader2} tone="info" label="Indexing" spin />
            ) : row.indexStatus === 'error' ? (
              <Status icon={XCircle} tone="error" label="Failed" />
            ) : row.lastIndexed ? (
              <When value={row.lastIndexed} now={now} />
            ) : (
              <span className="text-text-tertiary">Not yet</span>
            )}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

function TicketTable({ module, onOpen, rows }: ContentProps & { rows: OverviewTicketRow[] }) {
  const visible = visibleColumns(module);
  return (
    <Table
      label="Tickets"
      visible={visible}
      columns={[
        { id: 'id', label: 'ID' },
        { id: 'title', label: 'Title', className: 'w-full' },
        { id: 'type', label: 'Type' },
        { id: 'assignee', label: 'Assignee' },
        { id: 'status', label: 'Status' },
      ]}
    >
      {rows.map((row) => (
        <Row key={row.id}>
          <Cell
            show={visible.has('id')}
            className="whitespace-nowrap font-mono text-xs text-text-secondary"
          >
            {row.id}
          </Cell>
          <OpenCell
            title={row.title}
            target={row.target}
            onOpen={onOpen}
            external={Boolean(row.target.url)}
          />
          <Cell show={visible.has('type')} className="whitespace-nowrap text-text-secondary">
            {row.type}
          </Cell>
          <Cell show={visible.has('assignee')}>
            <span className="block max-w-[10rem] truncate text-text-secondary">
              {row.assignee ?? 'Unassigned'}
            </span>
          </Cell>
          <Cell show={visible.has('status')}>
            {/* The source system's own state, not an Anvil lifecycle. */}
            <Chip>{row.state}</Chip>
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

function IdeaTable({
  module,
  scope,
  now,
  onOpen,
  rows,
}: ContentProps & { rows: OverviewIdeaRow[] }) {
  const visible = visibleColumns(module);
  if (scope.kind === 'workspace') visible.delete('workspace');
  return (
    <Table
      label="Ideas and decisions"
      visible={visible}
      columns={[
        { id: 'idea', label: 'Idea', className: 'w-full' },
        { id: 'workspace', label: 'Workspace' },
        { id: 'type', label: 'Type' },
        { id: 'added', label: 'Added', className: 'text-right' },
      ]}
    >
      {rows.map((row) => (
        <Row key={row.id}>
          <OpenCell
            icon={row.kind === 'note' ? Lightbulb : BookOpen}
            title={row.title}
            detail={row.repoName}
            target={row.target}
            onOpen={onOpen}
          />
          <Cell show={visible.has('workspace')}>
            <WorkspaceLabel name={row.workspaceName} />
          </Cell>
          <Cell show={visible.has('type')}>
            <Chip tone={row.kind === 'decision' ? 'info' : 'neutral'}>
              {row.kind === 'decision'
                ? row.status
                  ? `Decision · ${row.status}`
                  : 'Decision'
                : 'Note'}
            </Chip>
          </Cell>
          <Cell show={visible.has('added')} className="text-right">
            <When value={row.createdAt} now={now} />
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

const SESSION_STATUS: Record<
  ChatThreadAttentionState,
  { icon: LucideIcon; tone: OverviewTone; label: string; spin?: boolean }
> = {
  idle: { icon: PauseCircle, tone: 'neutral', label: 'Idle' },
  working: { icon: Loader2, tone: 'info', label: 'Running', spin: true },
  approval: { icon: AlertTriangle, tone: 'warning', label: 'Needs approval' },
  input: { icon: AlertTriangle, tone: 'warning', label: 'Needs input' },
  failed: { icon: XCircle, tone: 'error', label: 'Failed' },
  complete: { icon: CheckCircle2, tone: 'success', label: 'Finished' },
};

function SessionTable({
  module,
  scope,
  now,
  onOpen,
  rows,
}: ContentProps & { rows: OverviewSessionRow[] }) {
  const visible = visibleColumns(module);
  if (scope.kind === 'workspace') visible.delete('workspace');
  visible.add('action');
  return (
    <Table
      label="Recent sessions"
      visible={visible}
      columns={[
        { id: 'session', label: 'Session', className: 'w-full' },
        { id: 'workspace', label: 'Workspace' },
        { id: 'status', label: 'Status' },
        { id: 'when', label: 'When', className: 'text-right' },
        { id: 'action', label: 'Action', className: 'sr-only' },
      ]}
    >
      {rows.map((row) => {
        const status = SESSION_STATUS[row.state];
        const resumable = row.state === 'idle' || row.state === 'approval' || row.state === 'input';
        return (
          <Row key={row.threadId}>
            <OpenCell icon={MessageSquare} title={row.title} target={row.target} onOpen={onOpen} />
            <Cell show={visible.has('workspace')}>
              <WorkspaceLabel name={row.workspaceName} />
            </Cell>
            <Cell show={visible.has('status')}>
              <Status {...status} />
            </Cell>
            <Cell show={visible.has('when')} className="text-right">
              <When value={row.lastActivityAt} now={now} />
            </Cell>
            <td className="py-1.5 pr-3 text-right">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onOpen(row.target)}
                aria-label={`${resumable ? 'Resume' : 'Open'} ${row.title}`}
              >
                {resumable ? 'Resume' : 'Open'}
              </Button>
            </td>
          </Row>
        );
      })}
    </Table>
  );
}

const RUN_STATUS: Record<
  AutomationRunStatus,
  { icon: LucideIcon; tone: OverviewTone; label: string; spin?: boolean }
> = {
  completed: { icon: CheckCircle2, tone: 'success', label: 'Completed' },
  failed: { icon: XCircle, tone: 'error', label: 'Failed' },
  cancelled: { icon: MinusCircle, tone: 'neutral', label: 'Cancelled' },
  running: { icon: Loader2, tone: 'info', label: 'Running', spin: true },
  queued: { icon: Clock3, tone: 'neutral', label: 'Queued' },
};

function AutomationRunTable({
  module,
  scope,
  now,
  onOpen,
  rows,
}: ContentProps & { rows: OverviewAutomationRunRow[] }) {
  const visible = visibleColumns(module);
  if (scope.kind === 'workspace') visible.delete('workspace');
  return (
    <Table
      label="Automation runs"
      visible={visible}
      columns={[
        { id: 'automation', label: 'Automation', className: 'w-full' },
        { id: 'workspace', label: 'Workspace' },
        { id: 'outcome', label: 'Outcome' },
        { id: 'when', label: 'When', className: 'text-right' },
      ]}
    >
      {rows.map((row) => (
        <Row key={row.runId}>
          <OpenCell
            icon={Bot}
            title={row.automationName}
            detail={
              row.summary ??
              (row.changedFileCount > 0 ? plural(row.changedFileCount, 'changed file') : undefined)
            }
            target={row.target}
            onOpen={onOpen}
          />
          <Cell show={visible.has('workspace')}>
            <WorkspaceLabel name={row.workspaceName} />
          </Cell>
          <Cell show={visible.has('outcome')}>
            <Status {...RUN_STATUS[row.status]} />
          </Cell>
          <Cell show={visible.has('when')} className="text-right">
            <When value={row.completedAt ?? row.startedAt} now={now} />
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

function DocumentTable({
  module,
  now,
  onOpen,
  rows,
}: ContentProps & { rows: OverviewDocumentRow[] }) {
  const visible = visibleColumns(module);
  return (
    <Table
      label="Documentation"
      visible={visible}
      columns={[
        { id: 'page', label: 'Page', className: 'w-full' },
        { id: 'review', label: 'Review' },
        { id: 'updated', label: 'Updated', className: 'text-right' },
      ]}
    >
      {rows.map((row) => (
        <Row key={row.id}>
          <OpenCell
            icon={FileText}
            title={row.title}
            detail={row.evidence ?? row.lastUpdatedBy}
            target={row.target}
            onOpen={onOpen}
            external
          />
          <Cell show={visible.has('review')}>
            {row.review === 'needs-review' ? (
              <span title={row.evidence}>
                <Status icon={AlertTriangle} tone="warning" label="Review suggested" />
              </span>
            ) : row.review === 'current' ? (
              <Status icon={CheckCircle2} tone="success" label="Current" />
            ) : (
              <Status icon={CircleDashed} tone="neutral" label="Unknown" />
            )}
          </Cell>
          <Cell show={visible.has('updated')} className="text-right">
            <When value={row.lastUpdated} now={now} />
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

function PinnedLinkList({ onOpen, rows }: ContentProps & { rows: OverviewPinnedLink[] }) {
  return (
    <ul className="border-t border-border-subtle" aria-label="Pinned links">
      {rows.map((link) => {
        const external = !link.target.startsWith('/');
        return (
          <li key={link.id} className="border-b border-border-subtle last:border-b-0">
            <button
              type="button"
              onClick={() => onOpen(external ? { url: link.target } : { route: link.target })}
              className="group flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
            >
              {external ? (
                <ExternalLink
                  size={14}
                  className="shrink-0 text-text-tertiary"
                  aria-hidden="true"
                />
              ) : (
                <Link2 size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate text-text-primary">{link.label}</span>
              <span className="max-w-[45%] truncate text-xs text-text-tertiary">{link.target}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
