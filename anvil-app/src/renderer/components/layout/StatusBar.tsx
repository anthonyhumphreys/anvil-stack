import { pollWhileVisible } from '../../utils/visible-polling';
import { useEffect, useState } from 'react';
import { TerminalSquare, GitBranch } from 'lucide-react';
import { useBrand } from '../../contexts/BrandContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';

interface StatusBarProps {
  connectionStatus: {
    foundry: boolean | null;
    ado: boolean | null;
    confluence: boolean | null;
  };
  onToggleTerminal: () => void;
  terminalOpen: boolean;
}

export function StatusBar({ connectionStatus, onToggleTerminal, terminalOpen }: StatusBarProps) {
  const brand = useBrand();
  const { repos } = useWorkspace();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [activeBranch, setActiveBranch] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    window.anvil.appWindow
      .getVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the first repo's active branch
  useEffect(() => {
    const repo = repos.find((r) => r.status !== 'error');
    if (!repo) {
      setActiveBranch(null);
      return;
    }

    let cancelled = false;
    const fetchBranch = () => {
      return window.anvil.git
        .status(repo.id)
        .then((s) => {
          if (!cancelled) setActiveBranch(s.branch);
        })
        .catch(() => {});
    };
    const stop = pollWhileVisible(fetchBranch, 5000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [repos]);

  const connectedCount = [
    connectionStatus.foundry,
    connectionStatus.ado,
    connectionStatus.confluence,
  ].filter((s) => s === true).length;

  const configuredCount = [
    connectionStatus.foundry,
    connectionStatus.ado,
    connectionStatus.confluence,
  ].filter((s) => s !== null).length;

  return (
    <footer className="flex h-8 items-center justify-between border-t border-border-subtle bg-bg-secondary px-4 text-sm text-text-secondary">
      <div className="flex items-center gap-3">
        <span>
          <BrandName name={brand.appName} />
          {appVersion && ` v${appVersion}`}
        </span>
        {activeBranch && (
          <span className="flex items-center gap-1 text-accent">
            <GitBranch size={12} />
            <span className="max-w-[140px] truncate">{activeBranch}</span>
          </span>
        )}
        <button
          onClick={onToggleTerminal}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-bg-elevated hover:text-text-primary ${
            terminalOpen ? 'text-text-primary' : ''
          }`}
          title={`Toggle Terminal (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+\`)`}
        >
          <TerminalSquare size={14} />
          <span>Terminal</span>
        </button>
      </div>
      <div className="flex items-center gap-3">
        {configuredCount > 0 && (
          <span>
            {connectedCount}/{configuredCount} services connected
          </span>
        )}
        <span>
          {navigator.platform.includes('Mac')
            ? 'macOS'
            : navigator.platform.includes('Win')
              ? 'Windows'
              : 'Linux'}
        </span>
      </div>
    </footer>
  );
}

function BrandName({ name }: { name: string }) {
  return <>{name}</>;
}
