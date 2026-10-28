import { Fragment, useMemo, type ReactNode } from 'react';
import {
  numberHunkLines,
  type NumberedDiffLine,
} from '../../../../../shared/surfaces/kinds/review/diff';
import type { ReviewFinding, ReviewHunk } from '../../../../../shared/surfaces/kinds/review/types';
import { cx } from '../../../ui';
import { SEVERITY_ICON, SEVERITY_TONE } from './ReviewGlyphs';
import { pairSplitRows, type LineSelection } from './review-model';
import { useHighlightedLines } from './useHighlightedLines';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  json: 'json',
  css: 'css',
  html: 'html',
  htm: 'html',
  sql: 'sql',
};

export function languageForPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXTENSION[extension] ?? 'text';
}

export interface ReviewDiffProps {
  filePath: string;
  hunks: readonly ReviewHunk[];
  /** Findings in this file: gutter markers and callouts. */
  findings: readonly ReviewFinding[];
  /** Deleted files anchor on old-side lines. */
  anchorOldSide?: boolean;
  focusedId?: string | null;
  split?: boolean;
  lineSelection?: LineSelection | null;
  /** Enables line-range selection (click, shift-click to extend). */
  onSelectLine?: (line: number, extend: boolean) => void;
  renderCallout?: (finding: ReviewFinding) => ReactNode;
  className?: string;
  /** Accessible name for the diff table. */
  label?: string;
}

function anchorLineOf(line: NumberedDiffLine, oldSide: boolean): number | null {
  return oldSide ? line.oldLine : line.newLine;
}

function findingAt(
  findings: readonly ReviewFinding[],
  line: number | null,
  focusedId?: string | null,
): { marker: ReviewFinding | null; inRange: ReviewFinding[] } {
  if (line === null) return { marker: null, inRange: [] };
  const inRange = findings.filter(
    (finding) => line >= finding.lineStart && line <= finding.lineEnd,
  );
  const marker =
    inRange.find((finding) => finding.lineStart === line && finding.id === focusedId) ??
    inRange.find((finding) => finding.lineStart === line) ??
    null;
  return { marker, inRange };
}

function CodeCell({ line, html }: { line: NumberedDiffLine; html: string | null | undefined }) {
  return html ? (
    <span dangerouslySetInnerHTML={{ __html: html || ' ' }} />
  ) : (
    <span>{line.text || ' '}</span>
  );
}

function LineNumber({
  value,
  selectable,
  selected,
  inRange,
  focused,
  onSelect,
}: {
  value: number | null;
  selectable: boolean;
  selected: boolean;
  inRange: boolean;
  focused: boolean;
  onSelect?: (extend: boolean) => void;
}) {
  const tone = cx(
    'w-[1%] select-none whitespace-nowrap px-2 text-right align-top tabular-nums',
    focused ? 'text-accent' : inRange ? 'text-text-primary' : 'text-text-tertiary',
    inRange && !selected && 'bg-bg-tertiary',
    selected && 'bg-accent-glow',
  );
  if (!selectable || value === null || !onSelect) return <td className={tone}>{value ?? ''}</td>;
  return (
    <td className={tone}>
      <button
        type="button"
        className="rounded-sm hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        aria-label={`Line ${value}${selected ? ', selected' : ''}. Shift-click to extend.`}
        aria-pressed={selected}
        onClick={(event) => onSelect(event.shiftKey)}
      >
        {value}
      </button>
    </td>
  );
}

function Marker({ finding, focused }: { finding: ReviewFinding | null; focused: boolean }) {
  if (!finding) return <td className="w-4 px-0.5" />;
  const Icon = SEVERITY_ICON[finding.severity];
  return (
    <td className="w-4 px-0.5 align-top">
      <span
        className={cx(
          'inline-flex pt-[3px]',
          focused ? 'text-accent' : SEVERITY_TONE[finding.severity],
        )}
        title={`${finding.id}: ${finding.title}`}
      >
        <Icon size={11} aria-hidden="true" strokeWidth={2.5} />
        <span className="sr-only">
          Finding {finding.id} starts here: {finding.title}
        </span>
      </span>
    </td>
  );
}

const ROW_TONE: Record<NumberedDiffLine['kind'], string> = {
  add: 'bg-success/10',
  del: 'bg-error/10',
  context: '',
  note: '',
};

const SIGN: Record<NumberedDiffLine['kind'], string> = {
  add: '+',
  del: '−',
  context: ' ',
  note: ' ',
};
const SIGN_TONE: Record<NumberedDiffLine['kind'], string> = {
  add: 'text-success',
  del: 'text-error',
  context: 'text-text-tertiary',
  note: 'text-text-tertiary',
};

function HunkRows({
  hunk,
  props,
  language,
}: {
  hunk: ReviewHunk;
  props: ReviewDiffProps;
  language: string;
}) {
  const lines = useMemo(() => numberHunkLines(hunk), [hunk]);
  const texts = useMemo(
    () => lines.map((line) => (line.kind === 'note' ? '' : line.text)),
    [lines],
  );
  const highlighted = useHighlightedLines(texts, language);
  const oldSide = props.anchorOldSide ?? false;
  const selection = props.lineSelection?.filePath === props.filePath ? props.lineSelection : null;
  const focusedFinding = props.findings.find((finding) => finding.id === props.focusedId);
  const columns = 5;

  const callouts = (line: NumberedDiffLine) => {
    const anchor = anchorLineOf(line, oldSide);
    if (anchor === null || !props.renderCallout) return null;
    const ending = props.findings.filter((finding) => finding.lineEnd === anchor);
    return ending.map((finding) => (
      <tr key={`callout-${finding.id}`}>
        <td colSpan={columns} className="px-3 py-2 font-sans">
          {props.renderCallout?.(finding)}
        </td>
      </tr>
    ));
  };

  const numberCell = (line: NumberedDiffLine | null, side: 'old' | 'new') => {
    const value = line ? (side === 'old' ? line.oldLine : line.newLine) : null;
    const anchorSide = oldSide ? 'old' : 'new';
    const anchor = line ? anchorLineOf(line, oldSide) : null;
    const { inRange } = findingAt(props.findings, side === anchorSide ? anchor : null);
    const selected =
      side === anchorSide &&
      !!selection &&
      anchor !== null &&
      anchor >= selection.start &&
      anchor <= selection.end;
    const focused =
      side === anchorSide &&
      !!focusedFinding &&
      anchor !== null &&
      anchor >= focusedFinding.lineStart &&
      anchor <= focusedFinding.lineEnd;
    return (
      <LineNumber
        value={value}
        selectable={side === anchorSide && !!props.onSelectLine}
        selected={selected}
        inRange={inRange.length > 0}
        focused={focused}
        onSelect={value !== null ? (extend) => props.onSelectLine?.(value, extend) : undefined}
      />
    );
  };

  const header = (
    <tr>
      <td
        colSpan={columns}
        className="border-y border-border-subtle bg-bg-secondary px-3 py-1 text-text-tertiary"
      >
        {hunk.header}
      </td>
    </tr>
  );

  if (props.split) {
    const rows = pairSplitRows(lines);
    return (
      <>
        {header}
        {rows.map((row, index) => {
          const anchorLine = oldSide ? row.left : (row.right ?? null);
          const anchor = anchorLine ? anchorLineOf(anchorLine, oldSide) : null;
          const { marker } = findingAt(props.findings, anchor, props.focusedId);
          return (
            <Fragment key={index}>
              <tr className="align-top">
                {numberCell(row.left, 'old')}
                <td
                  className={cx(
                    'w-1/2 whitespace-pre-wrap break-all pr-3',
                    row.left && ROW_TONE[row.left.kind],
                  )}
                >
                  {row.left ? (
                    <>
                      <span
                        className={cx('inline-block w-4 select-none', SIGN_TONE[row.left.kind])}
                      >
                        {row.left.kind === 'del' ? SIGN.del : ' '}
                      </span>
                      <CodeCell line={row.left} html={highlighted?.[row.left.index]} />
                    </>
                  ) : null}
                </td>
                <Marker finding={marker} focused={marker?.id === props.focusedId} />
                {numberCell(row.right, 'new')}
                <td
                  className={cx(
                    'w-1/2 whitespace-pre-wrap break-all pr-3',
                    row.right && ROW_TONE[row.right.kind],
                  )}
                >
                  {row.right ? (
                    <>
                      <span
                        className={cx('inline-block w-4 select-none', SIGN_TONE[row.right.kind])}
                      >
                        {row.right.kind === 'add' ? SIGN.add : ' '}
                      </span>
                      <CodeCell line={row.right} html={highlighted?.[row.right.index]} />
                    </>
                  ) : null}
                </td>
              </tr>
              {anchorLine ? callouts(anchorLine) : null}
            </Fragment>
          );
        })}
      </>
    );
  }

  return (
    <>
      {header}
      {lines.map((line) => {
        if (line.kind === 'note') {
          return (
            <tr key={line.index}>
              <td colSpan={columns} className="px-3 text-text-tertiary italic">
                {line.text}
              </td>
            </tr>
          );
        }
        const anchor = anchorLineOf(line, oldSide);
        const { marker } = findingAt(props.findings, anchor, props.focusedId);
        return (
          <Fragment key={line.index}>
            <tr className={cx('align-top', ROW_TONE[line.kind])}>
              {numberCell(line, 'old')}
              {numberCell(line, 'new')}
              <Marker finding={marker} focused={marker?.id === props.focusedId} />
              <td
                className={cx('w-4 select-none text-center', SIGN_TONE[line.kind])}
                aria-hidden="true"
              >
                {SIGN[line.kind]}
              </td>
              <td className="whitespace-pre-wrap break-all pr-3">
                <span className="sr-only">
                  {line.kind === 'add' ? 'Added: ' : line.kind === 'del' ? 'Removed: ' : ''}
                </span>
                <CodeCell line={line} html={highlighted?.[line.index]} />
              </td>
            </tr>
            {callouts(line)}
          </Fragment>
        );
      })}
    </>
  );
}

/** Shiki-highlighted hunks with gutter markers, inline finding callouts and line selection. */
export function ReviewDiff(props: ReviewDiffProps) {
  const language = languageForPath(props.filePath);
  if (props.hunks.length === 0) {
    return (
      <p className={cx('px-3 py-2 text-xs text-text-tertiary', props.className)}>
        No textual changes to show for this file.
      </p>
    );
  }
  return (
    <div className={cx('overflow-x-auto', props.className)}>
      <table
        className="w-full border-collapse font-mono text-xs leading-[1.6] text-text-primary"
        aria-label={props.label ?? `Diff of ${props.filePath}`}
      >
        <tbody>
          {props.hunks.map((hunk, index) => (
            <HunkRows
              key={`${hunk.header}-${index}`}
              hunk={hunk}
              props={props}
              language={language}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
