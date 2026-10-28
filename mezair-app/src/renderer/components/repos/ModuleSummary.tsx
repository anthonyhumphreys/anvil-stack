import { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, File } from 'lucide-react';
import type { ModuleSummary as ModuleSummaryType } from '../../../shared/types';

interface ModuleSummaryProps {
  module: ModuleSummaryType;
}

export function ModuleSummaryCard({ module }: ModuleSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md border border-border-subtle bg-bg-secondary">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Folder size={14} className="text-info" />
        <span className="flex-1 text-base font-medium text-text-primary">{module.path}</span>
        <span className="text-sm text-text-tertiary">{module.fileCount} files</span>
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-border-subtle px-3 py-3">
          <p className="text-base leading-relaxed text-text-secondary">{module.purpose}</p>

          {module.keyFiles.length > 0 && (
            <div>
              <p className="text-sm font-medium text-text-tertiary">Key Files</p>
              <div className="mt-1 space-y-0.5">
                {module.keyFiles.map((f) => (
                  <div key={f} className="flex items-center gap-1.5 text-sm text-text-secondary">
                    <File size={12} className="text-text-tertiary" />
                    <span className="font-mono">{f}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {module.dependencies.length > 0 && (
            <div>
              <p className="text-sm font-medium text-text-tertiary">Dependencies</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {module.dependencies.map((d) => (
                  <span
                    key={d}
                    className="rounded bg-bg-elevated px-2 py-1 text-sm text-text-secondary"
                  >
                    {d}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
