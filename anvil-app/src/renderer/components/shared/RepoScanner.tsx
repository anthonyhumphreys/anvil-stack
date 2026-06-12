import { useState } from 'react';
import { Loader2 } from 'lucide-react';

interface RepoScannerProps {
  onSelectionChange: (paths: Set<string>) => void;
}

export function RepoScanner({ onSelectionChange }: RepoScannerProps) {
  const [scanning, setScanning] = useState(false);
  const [foundRepos, setFoundRepos] = useState<Array<{ path: string; name: string }>>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [scanFolder, setScanFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateSelection = (next: Set<string>) => {
    setSelectedPaths(next);
    onSelectionChange(next);
  };

  const handleSelectFolder = async () => {
    try {
      setError(null);
      const folderPath = await window.anvil.repo.selectDirectory();
      if (!folderPath) return;

      setScanFolder(folderPath);
      setScanning(true);
      setFoundRepos([]);
      updateSelection(new Set());

      const repos = await window.anvil.repo.scan(folderPath, 4);
      setFoundRepos(repos);
      const allPaths = new Set(repos.map((r) => r.path));
      updateSelection(allPaths);
    } catch (err) {
      console.error('[RepoScanner] Scan failed:', err);
      setError('Failed to scan folder for repositories.');
    } finally {
      setScanning(false);
    }
  };

  const toggleRepo = (repoPath: string) => {
    const next = new Set(selectedPaths);
    if (next.has(repoPath)) {
      next.delete(repoPath);
    } else {
      next.add(repoPath);
    }
    updateSelection(next);
  };

  const selectAll = () => updateSelection(new Set(foundRepos.map((r) => r.path)));
  const deselectAll = () => updateSelection(new Set());

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={handleSelectFolder}
        disabled={scanning}
        className="rounded-md border border-border px-4 py-2 text-sm text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
      >
        {scanning ? 'Scanning...' : 'Select a folder'}
      </button>

      {scanFolder && !scanning && (
        <p className="text-xs text-text-tertiary truncate">Scanned: {scanFolder}</p>
      )}

      {scanning && (
        <div className="flex items-center gap-2 text-sm text-text-tertiary">
          <Loader2 size={16} className="animate-spin text-accent" />
          Scanning for repositories...
        </div>
      )}

      {!scanning && foundRepos.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-tertiary">
              {foundRepos.length} {foundRepos.length === 1 ? 'repo' : 'repos'} found &middot;{' '}
              {selectedPaths.size} selected
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={selectAll}
                className="text-xs text-accent hover:underline"
              >
                Select All
              </button>
              <button
                type="button"
                onClick={deselectAll}
                className="text-xs text-accent hover:underline"
              >
                Deselect All
              </button>
            </div>
          </div>

          <div className="max-h-60 overflow-y-auto space-y-1">
            {foundRepos.map((repo) => (
              <label
                key={repo.path}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-bg-tertiary cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedPaths.has(repo.path)}
                  onChange={() => toggleRepo(repo.path)}
                  className="accent-accent"
                />
                <span className="flex-1 min-w-0">
                  <span className="font-medium text-text-primary">{repo.name}</span>
                  <span className="ml-2 text-xs text-text-tertiary truncate">{repo.path}</span>
                </span>
              </label>
            ))}
          </div>
        </>
      )}

      {!scanning && scanFolder && foundRepos.length === 0 && (
        <p className="text-sm text-text-tertiary">No repositories found in the selected folder.</p>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
