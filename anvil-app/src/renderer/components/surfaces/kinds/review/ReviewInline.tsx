import { useId, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import {
  ChevronRight,
  GitPullRequest,
  ListTodo,
  Maximize2,
  MessageSquarePlus,
  Wrench,
  CheckCheck,
} from 'lucide-react';
import { SEVERITY_LABEL, isActiveFinding } from '../../../../../shared/surfaces/kinds/review/model';
import type {
  ReviewChapter,
  ReviewFinding,
  ReviewSeverity,
  ReviewSurfaceData,
} from '../../../../../shared/surfaces/kinds/review/types';
import { Button, IconButton, cx } from '../../../ui';
import type { SurfaceViewProps } from '../../types';
import { ReviewDiff } from './ReviewDiff';
import { ReviewFindingRow } from './ReviewFindingRow';
import { DiffStat, SeverityBadge } from './ReviewGlyphs';
import { ReviewVerdictLine } from './ReviewVerdict';
import {
  chapterAnchor,
  chapterFindings,
  countFindingsByFile,
  defaultCollapsedGroups,
  findingAnchor,
  findingsForFile,
  groupFindingsBySeverity,
  readReviewData,
  toggleSelection,
} from './review-model';
import { useReviewActions, type ReviewAction } from './useReviewActions';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function SectionHeading({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="text-eyebrow uppercase text-text-tertiary">
      {children}
    </h3>
  );
}

function InlineCallout({
  finding,
  onOpen,
}: {
  finding: ReviewFinding;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      onClick={() => onOpen(finding.id)}
    >
      <SeverityBadge severity={finding.severity} />
      <span className="min-w-0 flex-1 truncate text-text-primary">{finding.title}</span>
      <span className="font-mono text-text-tertiary">{finding.id}</span>
    </button>
  );
}

function ChapterSection({
  chapter,
  data,
  expanded,
  onToggle,
  openFiles,
  onToggleFile,
  onOpenStage,
  onComment,
  sectionId,
}: {
  chapter: ReviewChapter;
  data: ReviewSurfaceData;
  expanded: boolean;
  onToggle: () => void;
  openFiles: ReadonlySet<string>;
  onToggleFile: (path: string) => void;
  onOpenStage: (targetId?: string) => void;
  onComment: SurfaceViewProps['onComment'];
  sectionId: string;
}) {
  const findings = chapterFindings(data, chapter.id).filter(isActiveFinding);
  const counts = countFindingsByFile(data.findings);
  const panelId = `${sectionId}-files`;
  return (
    <li id={sectionId} className="group/chapter py-2.5">
      <div className="flex items-baseline gap-3">
        <span className="w-4 shrink-0 text-right font-mono text-xs tabular-nums text-text-tertiary">
          {chapter.index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-baseline gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={onToggle}
            >
              <span className="font-semibold leading-snug text-text-primary">{chapter.title}</span>
              <span className="shrink-0 text-xs text-text-tertiary">
                {plural(chapter.files.length, 'file')}
                {findings.length ? ` · ${plural(findings.length, 'finding')}` : ''}
              </span>
              <ChevronRight
                size={13}
                aria-hidden="true"
                className={cx(
                  'shrink-0 self-center text-text-tertiary transition-transform motion-reduce:transition-none',
                  expanded && 'rotate-90',
                )}
              />
            </button>
            <IconButton
              icon={MessageSquarePlus}
              label={`Comment on chapter ${chapter.index}`}
              className="opacity-0 group-hover/chapter:opacity-100 focus-visible:opacity-100"
              onClick={() => onComment(chapterAnchor(chapter))}
            />
          </div>
          {chapter.summary ? (
            <p className="mt-0.5 max-w-[72ch] text-sm leading-[1.65] text-text-secondary">
              {chapter.summary}
            </p>
          ) : null}
          {expanded ? (
            <ul
              id={panelId}
              className="mt-2 space-y-1"
              aria-label={`Files in chapter ${chapter.index}`}
            >
              {chapter.files.map((file) => {
                const open = openFiles.has(file.path);
                const count = counts.get(file.path) ?? 0;
                const hunks = data.hunks[file.path] ?? data.fullDiff?.[file.path] ?? [];
                const fileFindings = findingsForFile(data.findings, file.path);
                const deleted =
                  data.files.find((entry) => entry.path === file.path)?.status === 'deleted';
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-bg-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                      aria-expanded={open}
                      onClick={() => onToggleFile(file.path)}
                    >
                      <ChevronRight
                        size={12}
                        aria-hidden="true"
                        className={cx(
                          'shrink-0 text-text-tertiary transition-transform motion-reduce:transition-none',
                          open && 'rotate-90',
                        )}
                      />
                      <span className="min-w-0 flex-1 break-all font-mono text-xs text-text-secondary">
                        {file.path}
                      </span>
                      {count ? (
                        <span className="shrink-0 text-xs text-text-tertiary">
                          {plural(count, 'finding')}
                        </span>
                      ) : null}
                      <DiffStat additions={file.additions} deletions={file.deletions} />
                    </button>
                    {open ? (
                      <div className="mt-1 overflow-hidden rounded-lg border border-border bg-bg-secondary">
                        <ReviewDiff
                          filePath={file.path}
                          hunks={hunks}
                          findings={fileFindings}
                          anchorOldSide={deleted}
                          renderCallout={(finding) => (
                            <InlineCallout finding={finding} onOpen={(id) => onOpenStage(id)} />
                          )}
                        />
                        {!data.hunks[file.path] && !data.fullDiff?.[file.path] ? null : (
                          <div className="border-t border-border-subtle px-3 py-1.5 text-right">
                            <button
                              type="button"
                              className="text-xs text-text-tertiary hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                              onClick={() => onOpenStage(fileFindings[0]?.id)}
                            >
                              Open in workbench
                            </button>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function InlineSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {[72, 56, 64].map((width) => (
        <div key={width} className="flex items-center gap-3">
          <span className="h-3 w-16 rounded bg-bg-tertiary motion-safe:animate-pulse" />
          <span
            className="h-3 rounded bg-bg-tertiary motion-safe:animate-pulse"
            style={{ width: `${width}%` }}
          />
        </div>
      ))}
    </div>
  );
}

export function ReviewInline({ intent, onAction, onComment, onOpenStage }: SurfaceViewProps) {
  const data = useMemo(() => readReviewData(intent), [intent]);
  const streaming = intent.payload.streaming;
  const baseId = useId();
  const groups = useMemo(() => groupFindingsBySeverity(data?.findings ?? []), [data]);
  const [collapsed, setCollapsed] = useState<ReviewSeverity[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [openChapters, setOpenChapters] = useState<Set<string>>(() => new Set());
  const [openFiles, setOpenFiles] = useState<Set<string>>(() => new Set());
  const actions = useReviewActions(data, onAction);

  if (!data) {
    return <p className="max-w-[72ch] text-sm text-text-secondary">{intent.payload.digest}</p>;
  }

  const collapsedGroups = collapsed ?? defaultCollapsedGroups(groups);
  const selectedIds = selected.filter((id) => data.findings.some((finding) => finding.id === id));
  const fixable = selectedIds.filter(
    (id) => data.findings.find((finding) => finding.id === id)?.status !== 'fixed',
  );
  const openIds = data.findings
    .filter((finding) => finding.status === 'open')
    .map((finding) => finding.id);
  const workItemIds = (
    selectedIds.length ? data.findings.filter((f) => selectedIds.includes(f.id)) : data.findings
  )
    .filter((finding) => isActiveFinding(finding) && !finding.workItem)
    .map((finding) => finding.id);
  const busy = actions.pending !== null;

  const toggleSet = (setter: typeof setOpenChapters, key: string) =>
    setter((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const run = (action: ReviewAction, ids: string[]) => actions.request(action, ids);
  const openFinding = (id: string, _event?: MouseEvent) => onOpenStage(id);

  return (
    <section className="space-y-5 text-sm" aria-label={intent.payload.title}>
      <div className="space-y-1.5">
        <ReviewVerdictLine data={data} streaming={streaming} />
        {data.notes?.length ? (
          <ul className="ml-7 space-y-0.5 text-xs text-text-tertiary">
            {data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {data.risks.length ? (
        <ul className="ml-7 flex flex-wrap gap-x-5 gap-y-1.5" aria-label="Top risks">
          {data.risks.slice(0, 3).map((risk) => {
            const chapter = data.chapters.find((entry) => entry.id === risk.chapterId);
            return (
              <li key={risk.id} className="flex min-w-0 items-center gap-1.5 text-xs">
                <SeverityBadge severity={risk.severity} compact />
                <span className="text-text-secondary">{risk.title}</span>
                {chapter ? (
                  <button
                    type="button"
                    className="whitespace-nowrap text-text-tertiary hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    onClick={() => {
                      setOpenChapters((current) => new Set(current).add(chapter.id));
                      document
                        .getElementById(`${baseId}-chapter-${chapter.id}`)
                        ?.scrollIntoView({ block: 'nearest' });
                    }}
                  >
                    {`ch. ${chapter.index}`}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {data.chapters.length ? (
        <section aria-labelledby={`${baseId}-chapters`}>
          <SectionHeading id={`${baseId}-chapters`}>The change</SectionHeading>
          <ol className="mt-1 divide-y divide-border-subtle">
            {[...data.chapters]
              .sort((a, b) => a.index - b.index)
              .map((chapter) => (
                <ChapterSection
                  key={chapter.id}
                  chapter={chapter}
                  data={data}
                  sectionId={`${baseId}-chapter-${chapter.id}`}
                  expanded={openChapters.has(chapter.id)}
                  onToggle={() => toggleSet(setOpenChapters, chapter.id)}
                  openFiles={openFiles}
                  onToggleFile={(path) => toggleSet(setOpenFiles, path)}
                  onOpenStage={onOpenStage}
                  onComment={onComment}
                />
              ))}
          </ol>
        </section>
      ) : null}

      <section aria-labelledby={`${baseId}-findings`}>
        <div className="flex items-center gap-3">
          <SectionHeading id={`${baseId}-findings`}>
            Findings{data.findings.length ? ` · ${data.findings.length}` : ''}
          </SectionHeading>
          {selectedIds.length ? (
            <span className="text-xs text-text-tertiary">
              {selectedIds.length} selected ·{' '}
              <button
                type="button"
                className="hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                onClick={() => setSelected([])}
              >
                Clear
              </button>
            </span>
          ) : null}
        </div>
        {groups.length === 0 ? (
          streaming ? (
            <div className="mt-2">
              <InlineSkeleton />
            </div>
          ) : (
            <p className="mt-1 text-text-secondary">
              No findings. Nothing in this change needs attention.
            </p>
          )
        ) : (
          <div className="mt-1 space-y-1">
            {groups.map((group) => {
              const isCollapsed = collapsedGroups.includes(group.severity);
              const listId = `${baseId}-group-${group.severity}`;
              return (
                <div key={group.severity}>
                  <button
                    type="button"
                    className="flex items-center gap-2 rounded-sm py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    aria-expanded={!isCollapsed}
                    aria-controls={listId}
                    onClick={() =>
                      setCollapsed(
                        isCollapsed
                          ? collapsedGroups.filter((severity) => severity !== group.severity)
                          : [...collapsedGroups, group.severity],
                      )
                    }
                  >
                    <ChevronRight
                      size={13}
                      aria-hidden="true"
                      className={cx(
                        'text-text-tertiary transition-transform motion-reduce:transition-none',
                        !isCollapsed && 'rotate-90',
                      )}
                    />
                    <SeverityBadge severity={group.severity} />
                    <span className="text-xs text-text-tertiary">
                      {group.findings.length}
                      {group.activeCount !== group.findings.length
                        ? ` · ${group.activeCount} open`
                        : ''}
                    </span>
                    <span className="sr-only">{SEVERITY_LABEL[group.severity]} findings</span>
                  </button>
                  {isCollapsed ? null : (
                    <ul id={listId} className="ml-1 space-y-0.5">
                      {group.findings.map((finding) => (
                        <ReviewFindingRow
                          key={finding.id}
                          finding={finding}
                          selected={selectedIds.includes(finding.id)}
                          fadeIn={streaming}
                          disabled={busy}
                          onToggleSelected={(id) =>
                            setSelected((current) => toggleSelection(current, id))
                          }
                          onOpen={openFinding}
                          onAction={run}
                          onComment={(target) => onComment(findingAnchor(target))}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
            {streaming ? (
              <p className="pl-1 pt-1 text-xs text-text-tertiary">More findings on the way…</p>
            ) : null}
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
        <Button
          size="sm"
          disabled={busy || fixable.length === 0}
          title={fixable.length === 0 ? 'Select findings to ask for fixes' : undefined}
          onClick={() => run('ask_fix', fixable)}
        >
          <Wrench size={13} aria-hidden="true" />
          {fixable.length
            ? `Ask agent to fix ${fixable.length} selected`
            : 'Ask agent to fix selected'}
        </Button>
        {openIds.length ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => run('accept', openIds)}>
            <CheckCheck size={13} aria-hidden="true" />
            Accept all
          </Button>
        ) : null}
        {data.scope.type === 'pull-request' && data.scope.pullRequestId ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => run('post_to_pr', selectedIds)}
          >
            <GitPullRequest size={13} aria-hidden="true" />
            Post to PR
          </Button>
        ) : null}
        {workItemIds.length ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => run('create_work_items', workItemIds)}
          >
            <ListTodo size={13} aria-hidden="true" />
            Create work items
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" className="ml-auto" onClick={() => onOpenStage()}>
          <Maximize2 size={13} aria-hidden="true" />
          Open stage
        </Button>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={cx(
          'text-xs',
          !actions.status && 'sr-only',
          actions.status?.tone === 'error' ? 'text-error' : 'text-text-tertiary',
        )}
      >
        {actions.status?.text ?? ''}
      </p>
      {actions.dialogs}
    </section>
  );
}
