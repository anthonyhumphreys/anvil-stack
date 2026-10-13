import { useEffect, useMemo, useReducer, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Columns2,
  GitPullRequest,
  Keyboard,
  ListTodo,
  MessageSquarePlus,
  Rows2,
  Wrench,
  X,
} from 'lucide-react';
import { isActiveFinding, severityRank } from '../../../../../shared/surfaces/kinds/review/model';
import type { ReviewFinding } from '../../../../../shared/surfaces/kinds/review/types';
import { isEditableShortcutTarget } from '../../../../utils/keyboard';
import { Button, IconButton, SegmentedControl, cx } from '../../../ui';
import type { SurfaceViewProps } from '../../types';
import { ReviewDiff } from './ReviewDiff';
import { ReviewFindingDetail } from './ReviewFindingDetail';
import { ReviewFindingRow } from './ReviewFindingRow';
import { DiffStat, SEVERITY_ICON, SEVERITY_TONE, SeverityBadge, StatusChip } from './ReviewGlyphs';
import { ReviewShortcutHelp } from './ReviewShortcutHelp';
import { ReviewFacts, ReviewVerdictLine } from './ReviewVerdict';
import {
  actionTargets,
  diffRangeAnchor,
  findingAnchor,
  findingsForFile,
  hunksForFile,
  initialStageState,
  keyToStageCommand,
  orderedFilePaths,
  readReviewData,
  reduceReviewStage,
  stageFindingOrder,
  type ReviewStageAction,
  type ReviewStageNav,
  type ReviewStageState,
} from './review-model';
import { useReviewActions } from './useReviewActions';

type StageProps = SurfaceViewProps & {
  /** Finding to focus when the host opens the stage from a specific row. */
  focusTargetId?: string;
};

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : '';
}

function FileButton({
  path,
  active,
  findings,
  onSelect,
}: {
  path: string;
  active: boolean;
  findings: readonly ReviewFinding[];
  onSelect: () => void;
}) {
  const open = findings.filter(isActiveFinding);
  const worst = [...open].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0];
  const WorstIcon = worst ? SEVERITY_ICON[worst.severity] : null;
  return (
    <button
      type="button"
      data-file-path={path}
      aria-current={active ? 'true' : undefined}
      title={path}
      onClick={onSelect}
      className={cx(
        'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        active ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:bg-bg-hover/60',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs">{basename(path)}</span>
        {dirname(path) ? (
          <span className="block truncate text-xs text-text-tertiary" dir="rtl">
            <bdi>{dirname(path)}</bdi>
          </span>
        ) : null}
      </span>
      {worst && WorstIcon ? (
        <span
          className={cx(
            'inline-flex shrink-0 items-center gap-1 text-xs',
            SEVERITY_TONE[worst.severity],
          )}
        >
          <WorstIcon size={11} aria-hidden="true" strokeWidth={2.5} />
          <span className="tabular-nums">{open.length}</span>
          <span className="sr-only">open findings, worst {worst.severity}</span>
        </span>
      ) : null}
    </button>
  );
}

function StageCallout({
  finding,
  focused,
  onFocus,
}: {
  finding: ReviewFinding;
  focused: boolean;
  onFocus: (id: string) => void;
}) {
  return (
    <div
      data-callout={finding.id}
      className={cx(
        'max-w-[80ch] rounded-lg border bg-bg-secondary px-3 py-2',
        focused ? 'border-accent' : 'border-border',
      )}
    >
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        aria-pressed={focused}
        onClick={() => onFocus(finding.id)}
      >
        <SeverityBadge severity={finding.severity} />
        <span className="min-w-0 flex-1 font-medium text-text-primary">{finding.title}</span>
        <StatusChip status={finding.status} />
      </button>
      {focused ? (
        <p className="mt-1.5 line-clamp-4 max-w-[72ch] whitespace-pre-wrap text-sm leading-[1.65] text-text-secondary">
          {finding.rationale}
        </p>
      ) : null}
    </div>
  );
}

export function ReviewStage({ intent, onAction, onComment, focusTargetId }: StageProps) {
  const data = useMemo(() => readReviewData(intent), [intent]);
  const streaming = intent.payload.streaming;
  const nav = useMemo<ReviewStageNav>(
    () => ({
      findings: data ? stageFindingOrder(data) : [],
      files: data ? orderedFilePaths(data) : [],
    }),
    [data],
  );
  const [state, dispatchRaw] = useReducer(
    (current: ReviewStageState, input: { action: ReviewStageAction; nav: ReviewStageNav }) =>
      reduceReviewStage(current, input.action, input.nav),
    undefined,
    () => initialStageState(nav, focusTargetId),
  );
  const dispatch = (action: ReviewStageAction) => dispatchRaw({ action, nav });
  const actions = useReviewActions(data, onAction);
  const rootRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dispatchRaw({ action: { type: 'sync' }, nav });
  }, [nav]);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (focusTargetId) dispatch({ type: 'focus-finding', id: focusTargetId });
  }, [focusTargetId]);

  useEffect(() => {
    if (!state.focusedId || typeof CSS === 'undefined') return;
    diffRef.current
      ?.querySelector(`[data-callout="${CSS.escape(state.focusedId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [state.focusedId, state.activeFile]);

  useEffect(() => {
    if (!state.activeFile || typeof CSS === 'undefined') return;
    navRef.current
      ?.querySelector(`[data-file-path="${CSS.escape(state.activeFile)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [state.activeFile]);

  if (!data) {
    return <p className="p-6 text-sm text-text-secondary">{intent.payload.digest}</p>;
  }

  const findingById = new Map(data.findings.map((finding) => [finding.id, finding]));
  const focused = state.focusedId ? (findingById.get(state.focusedId) ?? null) : null;
  const targets = actionTargets(state.selected, state.focusedId).filter((id) =>
    findingById.has(id),
  );
  const unresolvedTargets = targets.filter((id) => {
    const status = findingById.get(id)?.status;
    return status !== 'fixed' && status !== 'dismissed';
  });
  const activeFile = state.activeFile;
  const activeStat = data.files.find((file) => file.path === activeFile);
  const activeFindings = activeFile ? findingsForFile(data.findings, activeFile) : [];
  const busy = actions.pending !== null;
  const canPost = data.scope.type === 'pull-request' && !!data.scope.pullRequestId;
  const chapterPaths = new Set(
    data.chapters.flatMap((chapter) => chapter.files.map((file) => file.path)),
  );
  const otherFiles = nav.files.filter((path) => !chapterPaths.has(path));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (actions.dialogOpen || state.helpOpen || event.defaultPrevented) return;
    if (isEditableShortcutTarget(event.target)) return;
    const command = keyToStageCommand(event);
    if (!command) return;
    const target = event.target as HTMLElement;
    if (command === 'toggle-select' && target.closest?.('button, input, a, [role="radio"]')) return;
    if (command === 'clear' && state.selected.length === 0 && !state.lineSelection) return;
    event.preventDefault();
    switch (command) {
      case 'next-finding':
      case 'prev-finding':
      case 'next-file':
      case 'prev-file':
        dispatch({ type: command });
        return;
      case 'toggle-select':
        dispatch({ type: 'toggle-select' });
        return;
      case 'clear':
        dispatch({ type: 'clear-selection' });
        return;
      case 'toggle-split':
        dispatch({ type: 'toggle-split' });
        return;
      case 'help':
        dispatch({ type: 'set-help', open: true });
        return;
      case 'accept':
        actions.request(
          'accept',
          targets.filter((id) =>
            ['open', 'fix-requested'].includes(findingById.get(id)?.status ?? ''),
          ),
        );
        return;
      case 'dismiss':
        actions.request('dismiss', unresolvedTargets);
        return;
      case 'ask-fix':
        actions.request('ask_fix', unresolvedTargets);
        return;
      case 'comment':
        if (state.lineSelection) onComment(diffRangeAnchor(state.lineSelection));
        else if (focused) onComment(findingAnchor(focused));
        return;
    }
  };

  const onRowOpen = (id: string, event: MouseEvent) => {
    const mode = event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'replace';
    dispatch({ type: 'focus-finding', id, mode });
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label={`${intent.payload.title} workbench`}
      aria-keyshortcuts="j k ] [ a d f c s ? Space"
      className="flex h-full min-h-[32rem] flex-col bg-bg-primary text-sm text-text-primary outline-none"
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <ReviewVerdictLine data={data} streaming={streaming} compact />
          <ReviewFacts data={data} className="ml-[26px]" />
        </div>
        <SegmentedControl
          label="Diff layout"
          value={state.split ? 'split' : 'unified'}
          onChange={(value) => {
            if ((value === 'split') !== state.split) dispatch({ type: 'toggle-split' });
          }}
          options={[
            { value: 'unified', label: 'Unified', icon: Rows2 },
            { value: 'split', label: 'Split', icon: Columns2 },
          ]}
        />
        <IconButton
          icon={MessageSquarePlus}
          size="md"
          label="Comment on the whole review"
          onClick={() => onComment({ type: 'surface', label: intent.payload.title })}
        />
        <IconButton
          icon={Keyboard}
          size="md"
          label="Keyboard shortcuts (?)"
          onClick={() => dispatch({ type: 'set-help', open: true })}
        />
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(12rem,15rem)_minmax(0,1fr)] xl:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)_minmax(19rem,23rem)]">
        <nav
          ref={navRef}
          aria-label="Chapters and files"
          className="min-h-0 overflow-y-auto border-b border-border bg-bg-secondary py-2 md:border-b-0 md:border-r"
        >
          {[...data.chapters]
            .sort((a, b) => a.index - b.index)
            .map((chapter) => (
              <section
                key={chapter.id}
                className="px-2 pb-2"
                aria-label={`Chapter ${chapter.index}: ${chapter.title}`}
              >
                <p className="flex items-baseline gap-2 px-2 pb-1 pt-1.5">
                  <span className="font-mono text-xs tabular-nums text-text-tertiary">
                    {chapter.index}
                  </span>
                  <span className="text-xs font-semibold leading-snug text-text-primary">
                    {chapter.title}
                  </span>
                </p>
                <ul>
                  {chapter.files.map((file) => (
                    <li key={file.path}>
                      <FileButton
                        path={file.path}
                        active={file.path === activeFile}
                        findings={findingsForFile(data.findings, file.path)}
                        onSelect={() => dispatch({ type: 'select-file', path: file.path })}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          {otherFiles.length ? (
            <section className="px-2 pb-2" aria-label="Other changed files">
              <p className="px-2 pb-1 pt-1.5 text-eyebrow uppercase text-text-tertiary">
                {data.chapters.length ? 'Other files' : 'Files'}
              </p>
              <ul>
                {otherFiles.map((path) => (
                  <li key={path}>
                    <FileButton
                      path={path}
                      active={path === activeFile}
                      findings={findingsForFile(data.findings, path)}
                      onSelect={() => dispatch({ type: 'select-file', path })}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </nav>

        <main ref={diffRef} aria-label="Diff" className="min-h-0 overflow-y-auto">
          {activeFile ? (
            <>
              <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-bg-primary px-4 py-2">
                <span className="min-w-0 flex-1 break-all font-mono text-xs text-text-primary">
                  {activeFile}
                </span>
                {activeStat ? (
                  <DiffStat additions={activeStat.additions} deletions={activeStat.deletions} />
                ) : null}
                {state.lineSelection && state.lineSelection.filePath === activeFile ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      state.lineSelection && onComment(diffRangeAnchor(state.lineSelection))
                    }
                  >
                    <MessageSquarePlus size={13} aria-hidden="true" />
                    {state.lineSelection.end > state.lineSelection.start
                      ? `Comment on lines ${state.lineSelection.start}–${state.lineSelection.end}`
                      : `Comment on line ${state.lineSelection.start}`}
                  </Button>
                ) : null}
                <IconButton
                  icon={ChevronUp}
                  label="Previous file ([)"
                  onClick={() => dispatch({ type: 'prev-file' })}
                />
                <IconButton
                  icon={ChevronDown}
                  label="Next file (])"
                  onClick={() => dispatch({ type: 'next-file' })}
                />
              </div>
              {!data.fullDiff?.[activeFile] && data.fullDiffOmitted ? (
                <p className="px-4 pt-2 text-xs text-text-tertiary">
                  The full diff was too large to embed, so this shows the hunks around findings.
                </p>
              ) : null}
              <ReviewDiff
                className="py-2"
                filePath={activeFile}
                hunks={hunksForFile(data, activeFile)}
                findings={activeFindings}
                anchorOldSide={activeStat?.status === 'deleted'}
                focusedId={state.focusedId}
                split={state.split}
                lineSelection={state.lineSelection}
                onSelectLine={(line, extend) =>
                  dispatch({ type: 'select-lines', filePath: activeFile, line, extend })
                }
                renderCallout={(finding) => (
                  <StageCallout
                    finding={finding}
                    focused={finding.id === state.focusedId}
                    onFocus={(id) => dispatch({ type: 'focus-finding', id })}
                  />
                )}
              />
            </>
          ) : (
            <p className="p-6 text-text-secondary">No changed files in this review.</p>
          )}
        </main>

        <aside
          aria-label="Findings"
          className="min-h-0 overflow-y-auto border-t border-border md:col-span-2 xl:col-span-1 xl:border-l xl:border-t-0"
        >
          {focused ? (
            <ReviewFindingDetail
              finding={focused}
              busy={busy}
              canPostToPullRequest={canPost}
              onAction={actions.request}
              onComment={(finding) => onComment(findingAnchor(finding))}
              onJump={(finding) => dispatch({ type: 'focus-finding', id: finding.id })}
            />
          ) : (
            <p className="px-4 py-3 text-text-secondary">
              {data.findings.length
                ? 'No findings in this file. Press j to jump to the next one.'
                : 'No findings.'}
            </p>
          )}
          {nav.findings.length ? (
            <section className="border-t border-border-subtle px-2 py-2" aria-label="All findings">
              <p className="px-2 pb-1 text-eyebrow uppercase text-text-tertiary">
                All findings · {nav.findings.length}
              </p>
              <ul className="space-y-0.5">
                {nav.findings.map((ref) => {
                  const finding = findingById.get(ref.id);
                  if (!finding) return null;
                  return (
                    <ReviewFindingRow
                      key={finding.id}
                      finding={finding}
                      dense
                      selected={state.selected.includes(finding.id)}
                      focused={finding.id === state.focusedId}
                      fadeIn={streaming}
                      disabled={busy}
                      onToggleSelected={(id, event) =>
                        event?.shiftKey
                          ? dispatch({ type: 'focus-finding', id, mode: 'range' })
                          : dispatch({ type: 'toggle-select', id })
                      }
                      onOpen={onRowOpen}
                      onAction={actions.request}
                      onComment={(target) => onComment(findingAnchor(target))}
                    />
                  );
                })}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2">
        <span className="min-w-[6rem] text-xs text-text-tertiary" aria-live="polite">
          {state.selected.length
            ? `${state.selected.length} selected`
            : focused
              ? `${focused.id} focused`
              : ''}
        </span>
        <Button
          size="sm"
          disabled={busy || !unresolvedTargets.length}
          onClick={() => actions.request('ask_fix', unresolvedTargets)}
        >
          <Wrench size={13} aria-hidden="true" />
          Ask agent to fix
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !targets.length}
          onClick={() =>
            actions.request(
              'accept',
              targets.filter((id) =>
                ['open', 'fix-requested'].includes(findingById.get(id)?.status ?? ''),
              ),
            )
          }
        >
          <Check size={13} aria-hidden="true" />
          Accept
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !unresolvedTargets.length}
          onClick={() => actions.request('dismiss', unresolvedTargets)}
        >
          <X size={13} aria-hidden="true" />
          Dismiss
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !unresolvedTargets.some((id) => !findingById.get(id)?.workItem)}
          onClick={() =>
            actions.request(
              'create_work_items',
              unresolvedTargets.filter((id) => !findingById.get(id)?.workItem),
            )
          }
        >
          <ListTodo size={13} aria-hidden="true" />
          Create work items
        </Button>
        {canPost ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => actions.request('post_to_pr', state.selected)}
          >
            <GitPullRequest size={13} aria-hidden="true" />
            Post to PR
          </Button>
        ) : null}
        <span
          role="status"
          className={cx(
            'text-xs',
            actions.status?.tone === 'error' ? 'text-error' : 'text-text-tertiary',
            !actions.status && 'sr-only',
          )}
        >
          {actions.status?.text ?? ''}
        </span>
        <span className="ml-auto hidden text-xs text-text-tertiary lg:inline">
          <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> findings ·{' '}
          <kbd className="font-mono">]</kbd>/<kbd className="font-mono">[</kbd> files ·{' '}
          <kbd className="font-mono">?</kbd> shortcuts
        </span>
      </footer>

      <ReviewShortcutHelp
        open={state.helpOpen}
        onClose={() => dispatch({ type: 'set-help', open: false })}
      />
      {actions.dialogs}
    </div>
  );
}
