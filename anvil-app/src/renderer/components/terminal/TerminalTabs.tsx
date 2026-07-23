import { TerminalSquare, X } from 'lucide-react';
import type { RepoInfo } from '../../../shared/types';

interface TerminalTabsProps {
  repos: RepoInfo[];
  activeRepoId: string | null;
  openRepoIds: string[];
  onSelectTab: (repoId: string) => void;
  onCloseTab: (repoId: string) => void;
}

export function TerminalTabs({
  repos,
  activeRepoId,
  openRepoIds,
  onSelectTab,
  onCloseTab,
}: TerminalTabsProps) {
  return (
    <div className="flex items-center gap-0.5 border-b border-border-subtle bg-bg-secondary px-2">
      {repos.map((repo) => {
        const active = activeRepoId === repo.id;
        return (
          <div
            key={repo.id}
            className={`group flex items-center border-b-2 transition-colors ${
              active ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary'
            }`}
          >
            <button
              onClick={() => onSelectTab(repo.id)}
              className="flex items-center gap-1.5 py-1.5 pl-3 pr-1 text-xs hover:text-text-primary"
            >
              <TerminalSquare size={12} />
              <span className="max-w-[120px] truncate">{repo.name}</span>
            </button>
            {openRepoIds.includes(repo.id) && (
              <button
                type="button"
                aria-label={`Close ${repo.name} terminal`}
                title="Close terminal process"
                onClick={() => onCloseTab(repo.id)}
                className={`mr-1 rounded p-1 transition-opacity hover:bg-bg-tertiary hover:text-text-primary ${
                  active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70 focus:opacity-70'
                }`}
              >
                <X size={11} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
