import { TerminalSquare } from 'lucide-react';
import type { RepoInfo } from '../../../shared/types';

interface TerminalTabsProps {
  repos: RepoInfo[];
  activeRepoId: string | null;
  onSelectTab: (repoId: string) => void;
}

export function TerminalTabs({ repos, activeRepoId, onSelectTab }: TerminalTabsProps) {
  return (
    <div className="flex items-center gap-0.5 border-b border-border-subtle bg-bg-secondary px-2">
      {repos.map((repo) => (
        <button
          key={repo.id}
          onClick={() => onSelectTab(repo.id)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors ${
            activeRepoId === repo.id
              ? 'border-b-2 border-accent text-text-primary'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <TerminalSquare size={12} />
          <span className="max-w-[120px] truncate">{repo.name}</span>
        </button>
      ))}
    </div>
  );
}
