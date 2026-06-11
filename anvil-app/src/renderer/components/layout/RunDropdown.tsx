// src/renderer/components/layout/RunDropdown.tsx

import { Star } from 'lucide-react';
import type { RunCommand } from '../../../shared/run-types';
import type { RepoInfo } from '../../../shared/types';

interface Props {
  scripts: Record<string, RunCommand[]>;
  repos: RepoInfo[];
  onRun: (repoId: string, command: string, label: string) => void;
  onClose: () => void;
}

function SourceBadge({ source }: { source: string }) {
  return (
    <span className="rounded bg-bg-primary px-1 py-0.5 text-[10px] text-text-tertiary">
      {source}
    </span>
  );
}

export function RunDropdown({ scripts, repos, onRun, onClose: _onClose }: Props) {
  const handlePin = async (e: React.MouseEvent, cmd: RunCommand) => {
    e.preventDefault();
    e.stopPropagation();
    if (cmd.pinned) {
      await window.anvil.run.unpinCommand(cmd.id);
    } else {
      await window.anvil.run.pinCommand(cmd.id);
    }
  };

  return (
    <div className="absolute left-3 right-3 top-full z-50 mt-1 max-h-80 overflow-auto rounded-lg border border-border-subtle bg-bg-secondary shadow-lg">
      {repos.map((repo) => {
        const cmds = scripts[repo.id] || [];
        if (cmds.length === 0) return null;

        // Sort: pinned first, then by label
        const sorted = [...cmds].sort((a, b) => {
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          return a.label.localeCompare(b.label);
        });

        return (
          <div key={repo.id}>
            {/* Repo header */}
            <div className="sticky top-0 border-b border-border-subtle bg-bg-tertiary px-3 py-1.5 text-xs font-semibold text-text-secondary">
              {repo.name}
            </div>

            {/* Scripts */}
            {sorted.map((cmd) => (
              <button
                key={cmd.id}
                onClick={() => onRun(repo.id, cmd.command, cmd.label)}
                onContextMenu={(e) => handlePin(e, cmd)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary"
              >
                {cmd.pinned && <Star size={10} className="shrink-0 fill-warning text-warning" />}
                <span className="font-medium text-text-primary">{cmd.label}</span>
                <span className="flex-1 truncate text-xs text-text-tertiary">{cmd.command}</span>
                <SourceBadge source={cmd.source} />
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
