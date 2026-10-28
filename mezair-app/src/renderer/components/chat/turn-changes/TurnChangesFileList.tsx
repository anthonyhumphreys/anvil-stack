import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight, SquareArrowOutUpRight } from 'lucide-react';
import { IconButton, cx } from '../../ui';
import { DiffViewer } from '../DiffViewer';
import { splitDisplayPath, type TurnFileChange } from '../chat-turn-changes';
import { TurnFileStatusGlyph } from './TurnFileStatusGlyph';
import { nextFileListIndex } from './file-list-navigation';

export interface TurnChangesFileListProps {
  files: readonly TurnFileChange[];
  /** Display path per file (repo-relative when the repo is known). */
  displayPath: (file: TurnFileChange) => string;
  expandedPaths: ReadonlySet<string>;
  onToggleFile: (filePath: string) => void;
  onOpenInEditor?: (file: TurnFileChange) => void;
  agentLabel?: string;
  /** Registers each row's toggle so the footer can focus a requested file. */
  toggleRef?: (filePath: string, element: HTMLButtonElement | null) => void;
}

/**
 * The per-turn file list: one row per file with status glyph, mono path and
 * +/− stats. Rows expand in place to the turn's unified diff. ArrowUp/Down,
 * Home and End move between rows (roving tab stop); Enter/Space toggle.
 */
export function TurnChangesFileList({
  files,
  displayPath,
  expandedPaths,
  onToggleFile,
  onOpenInEditor,
  agentLabel = 'The agent',
  toggleRef,
}: TurnChangesFileListProps) {
  const baseId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const rovingIndex = Math.min(activeIndex, Math.max(files.length - 1, 0));

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextFileListIndex(event.key, index, files.length);
    if (next === null) return;
    event.preventDefault();
    setActiveIndex(next);
    buttonsRef.current[next]?.focus();
  };

  return (
    <ul className="divide-y divide-border-subtle" aria-label="Files changed in this turn">
      {files.map((file, index) => {
        const path = displayPath(file);
        const { dir, name } = splitDisplayPath(path);
        const expanded = expandedPaths.has(file.filePath);
        const panelId = `${baseId}-diff-${index}`;
        return (
          <li key={file.filePath}>
            <div className="flex items-center gap-1 pr-2">
              <button
                ref={(element) => {
                  buttonsRef.current[index] = element;
                  toggleRef?.(file.filePath, element);
                }}
                type="button"
                tabIndex={index === rovingIndex ? 0 : -1}
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => {
                  setActiveIndex(index);
                  onToggleFile(file.filePath);
                }}
                onFocus={() => setActiveIndex(index)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                title={path}
              >
                <ChevronRight
                  size={12}
                  aria-hidden="true"
                  className={cx(
                    'shrink-0 text-text-tertiary motion-safe:transition-transform',
                    expanded && 'rotate-90',
                  )}
                />
                <TurnFileStatusGlyph status={file.status} />
                <span className="min-w-0 flex-1 truncate font-mono">
                  {dir && <span className="text-text-tertiary">{dir}</span>}
                  <span className="text-text-primary">{name}</span>
                </span>
                <span className="shrink-0 font-mono tabular-nums">
                  <span aria-hidden="true">
                    <span className="text-success">+{file.additions}</span>{' '}
                    <span className="text-error">−{file.deletions}</span>
                  </span>
                  <span className="sr-only">
                    {file.additions} addition{file.additions === 1 ? '' : 's'}, {file.deletions}{' '}
                    deletion{file.deletions === 1 ? '' : 's'}
                  </span>
                </span>
              </button>
              {onOpenInEditor && file.status !== 'deleted' && (
                <IconButton
                  icon={SquareArrowOutUpRight}
                  label={`Open ${name} in editor`}
                  onClick={() => onOpenInEditor(file)}
                />
              )}
            </div>
            {expanded && (
              <div
                id={panelId}
                role="region"
                aria-label={`Diff for ${path}`}
                className="max-h-96 overflow-auto border-t border-border-subtle"
              >
                {file.diff.trim() && file.patch !== 'raw' ? (
                  <DiffViewer filePath={path} diff={file.diff} />
                ) : (
                  <p className="px-4 py-3 text-xs text-text-tertiary">
                    Change applied, but {agentLabel} did not provide a line-level patch for this
                    file.
                  </p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
