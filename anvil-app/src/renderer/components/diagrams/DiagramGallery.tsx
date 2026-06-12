import { GitFork, Plus, Sparkles, FileCode } from 'lucide-react';
import type { DiagramFile } from '../../../shared/types';

interface DiagramGalleryProps {
  diagrams: DiagramFile[];
  dirExists: boolean;
  onSelect: (diagram: DiagramFile) => void;
  onInitialize: () => void;
  onCreateNew: () => void;
  initializing: boolean;
}

export function DiagramGallery({
  diagrams,
  dirExists,
  onSelect,
  onInitialize,
  onCreateNew,
  initializing,
}: DiagramGalleryProps) {
  // Empty state: no docs/diagrams folder
  if (!dirExists) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <GitFork size={48} className="text-text-tertiary" />
        <div className="text-center">
          <h3 className="text-lg font-semibold text-text-primary">No diagrams yet</h3>
          <p className="mt-1 text-sm text-text-secondary">
            Initialize the diagrams folder to auto-generate architecture, data flow, and C4
            diagrams.
          </p>
        </div>
        <button
          onClick={onInitialize}
          disabled={initializing}
          className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
        >
          <Sparkles size={16} />
          {initializing ? 'Initializing...' : 'Initialize Diagrams'}
        </button>
      </div>
    );
  }

  // Empty state: folder exists but empty
  if (diagrams.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <GitFork size={48} className="text-text-tertiary" />
        <div className="text-center">
          <h3 className="text-lg font-semibold text-text-primary">No diagrams</h3>
          <p className="mt-1 text-sm text-text-secondary">
            Use the chat below to describe and create your first diagram.
          </p>
        </div>
      </div>
    );
  }

  // Grid of diagram cards
  return (
    <div className="h-full overflow-auto p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {diagrams.map((d) => (
          <button
            key={d.filename}
            onClick={() => onSelect(d)}
            className="group flex flex-col items-center rounded-lg border border-border bg-bg-secondary p-4 transition-colors hover:border-accent hover:bg-bg-tertiary"
          >
            <FileCode size={32} className="text-text-tertiary group-hover:text-accent" />
            <span className="mt-2 truncate text-sm font-medium text-text-primary w-full text-center">
              {d.title}
            </span>
            <span className="mt-1 text-[11px] text-text-tertiary">
              {new Date(d.mtime).toLocaleDateString()}
            </span>
          </button>
        ))}
        {/* Add new card */}
        <button
          onClick={onCreateNew}
          className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-4 transition-colors hover:border-accent hover:bg-bg-tertiary"
        >
          <Plus size={24} className="text-text-tertiary" />
          <span className="mt-2 text-sm text-text-tertiary">New Diagram</span>
        </button>
      </div>
    </div>
  );
}
