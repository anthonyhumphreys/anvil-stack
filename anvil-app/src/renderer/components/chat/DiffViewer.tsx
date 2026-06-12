import { useState } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';

interface DiffViewerProps {
  filePath: string;
  diff: string;
}

type ViewMode = 'unified' | 'split';

/** Parse a unified diff string into old and new content */
function parseDiff(diff: string): { oldValue: string; newValue: string } {
  const lines = diff.split('\n');
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of lines) {
    if (
      line.startsWith('@@') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('diff ')
    ) {
      continue;
    }
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      newLines.push(line.slice(1));
    } else {
      // Context line (starts with space or is empty)
      const content = line.startsWith(' ') ? line.slice(1) : line;
      oldLines.push(content);
      newLines.push(content);
    }
  }

  return {
    oldValue: oldLines.join('\n'),
    newValue: newLines.join('\n'),
  };
}

const diffStyles = {
  variables: {
    dark: {
      diffViewerBackground: 'var(--color-bg-tertiary)',
      diffViewerColor: 'var(--color-text-primary)',
      addedBackground: 'var(--diff-added-bg)',
      addedColor: 'var(--color-text-primary)',
      removedBackground: 'var(--diff-removed-bg)',
      removedColor: 'var(--color-text-primary)',
      wordAddedBackground: 'color-mix(in srgb, transparent 70%, var(--color-success))',
      wordRemovedBackground: 'color-mix(in srgb, transparent 70%, var(--color-error))',
      addedGutterBackground: 'var(--diff-added-gutter-bg)',
      removedGutterBackground: 'var(--diff-removed-gutter-bg)',
      gutterBackground: 'var(--color-bg-secondary)',
      gutterBackgroundDark: 'var(--color-bg-primary)',
      gutterColor: 'var(--color-text-tertiary)',
      codeFoldBackground: 'var(--color-bg-elevated)',
      codeFoldGutterBackground: 'var(--color-bg-elevated)',
      codeFoldContentColor: 'var(--color-text-tertiary)',
      emptyLineBackground: 'var(--color-bg-secondary)',
    },
  },
  line: {
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
  },
  contentText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    lineHeight: '1.6',
  },
  gutter: {
    minWidth: '40px',
    padding: '0 8px',
  },
};

export function DiffViewer({ filePath, diff }: DiffViewerProps) {
  void filePath;
  const [viewMode, setViewMode] = useState<ViewMode>('unified');
  const { oldValue, newValue } = parseDiff(diff);

  return (
    <div className="diff-viewer overflow-auto text-xs">
      {/* View mode toggle */}
      <div className="flex items-center justify-end gap-1 bg-bg-elevated px-3 py-1">
        <button
          onClick={() => setViewMode('unified')}
          className={`rounded px-2 py-0.5 text-xs transition-colors ${
            viewMode === 'unified'
              ? 'bg-bg-tertiary text-text-primary'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          Unified
        </button>
        <button
          onClick={() => setViewMode('split')}
          className={`rounded px-2 py-0.5 text-xs transition-colors ${
            viewMode === 'split'
              ? 'bg-bg-tertiary text-text-primary'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          Split
        </button>
      </div>

      <ReactDiffViewer
        oldValue={oldValue}
        newValue={newValue}
        splitView={viewMode === 'split'}
        useDarkTheme
        styles={diffStyles}
        compareMethod={DiffMethod.WORDS}
      />
    </div>
  );
}
