import { useState, type DragEvent } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { Button, cx } from '../ui';

interface RepoScannerProps {
  onSelectionChange: (paths: Set<string>) => void;
  /** Paths already in this workspace — shown disabled (RM2). */
  existingPaths?: Set<string>;
}

/**
 * Folder → repo picker (RM2):
 * - If the chosen folder is itself a repo, it is added directly.
 * - Otherwise only top-level repos are pre-selected (nested/vendored finds
 *   stay opt-in).
 * - Repos already in the workspace render disabled.
 * - A folder can be dropped onto the picker (Electron exposes `file.path`).
 */
export function RepoScanner({ onSelectionChange, existingPaths }: RepoScannerProps) {
  const [scanning, setScanning] = useState(false);
  const [foundRepos, setFoundRepos] = useState<Array<{ path: string; name: string }>>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [scanFolder, setScanFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const updateSelection = (next: Set<string>) => {
    setSelectedPaths(next);
    onSelectionChange(next);
  };

  const scanFolderPath = async (folderPath: string) => {
    setScanFolder(folderPath);
    setScanning(true);
    setFoundRepos([]);
    updateSelection(new Set());
    setError(null);

    try {
      const repos = await window.anvil.repo.scan(folderPath, 4);
      setFoundRepos(repos);

      const isRepoItself = repos.length === 1 && repos[0].path === folderPath;
      if (isRepoItself) {
        // The folder itself is a repo — select it directly, no checklist.
        updateSelection(new Set([folderPath]));
      } else {
        // Pre-select only top-level repos (direct children of the scanned
        // folder); deeper finds are opt-in to avoid vendored/nested pulls.
        const topLevel = new Set(
          repos
            .filter((repo) => parentDir(repo.path) === trimTrailingSep(folderPath))
            .map((repo) => repo.path),
        );
        updateSelection(topLevel);
      }
    } catch (err) {
      console.error('[RepoScanner] Scan failed:', err);
      setError('Failed to scan folder for repositories.');
    } finally {
      setScanning(false);
    }
  };

  const handleSelectFolder = async () => {
    try {
      setError(null);
      const folderPath = await window.anvil.repo.selectDirectory();
      if (!folderPath) return;
      await scanFolderPath(folderPath);
    } catch (err) {
      console.error('[RepoScanner] Folder pick failed:', err);
      setError('Failed to pick a folder.');
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropActive(false);
    const file = event.dataTransfer.files?.[0];
    // Electron exposes the absolute path on dropped File objects.
    const droppedPath = (file as (File & { path?: string }) | undefined)?.path;
    if (droppedPath) void scanFolderPath(droppedPath);
  };

  const toggleRepo = (repoPath: string) => {
    if (existingPaths?.has(repoPath)) return;
    const next = new Set(selectedPaths);
    if (next.has(repoPath)) {
      next.delete(repoPath);
    } else {
      next.add(repoPath);
    }
    updateSelection(next);
  };

  const selectableRepos = foundRepos.filter((repo) => !existingPaths?.has(repo.path));
  const selectAll = () => updateSelection(new Set(selectableRepos.map((r) => r.path)));
  const deselectAll = () => updateSelection(new Set());

  return (
    <div
      className={cx(
        'space-y-3 rounded-lg border border-dashed p-3 transition-colors',
        dropActive ? 'border-accent bg-accent/5' : 'border-border-subtle',
      )}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDropActive(true);
        }
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={handleDrop}
    >
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleSelectFolder()}
          disabled={scanning}
        >
          <FolderOpen size={14} aria-hidden="true" />
          {scanning ? 'Scanning…' : 'Select a folder'}
        </Button>
        <span className="text-xs text-text-tertiary">…or drop a folder here</span>
      </div>

      {scanFolder && !scanning && (
        <p className="truncate text-xs text-text-tertiary">Scanned: {scanFolder}</p>
      )}

      {scanning && (
        <div className="flex items-center gap-2 text-sm text-text-tertiary">
          <Loader2 size={16} className="animate-spin text-accent" aria-hidden="true" />
          Scanning for repositories…
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
                Select all
              </button>
              <button
                type="button"
                onClick={deselectAll}
                className="text-xs text-accent hover:underline"
              >
                Deselect all
              </button>
            </div>
          </div>

          <div className="max-h-60 space-y-1 overflow-y-auto">
            {foundRepos.map((repo) => {
              const alreadyInWorkspace = existingPaths?.has(repo.path) ?? false;
              return (
                <label
                  key={repo.path}
                  className={cx(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                    alreadyInWorkspace
                      ? 'cursor-not-allowed opacity-50'
                      : 'cursor-pointer hover:bg-bg-tertiary',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selectedPaths.has(repo.path)}
                    onChange={() => toggleRepo(repo.path)}
                    disabled={alreadyInWorkspace}
                    className="accent-accent"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-text-primary">{repo.name}</span>
                    <span className="ml-2 truncate text-xs text-text-tertiary">{repo.path}</span>
                  </span>
                  {alreadyInWorkspace && (
                    <span className="shrink-0 text-eyebrow uppercase text-text-tertiary">
                      Already in workspace
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </>
      )}

      {!scanning && scanFolder && foundRepos.length === 0 && (
        <p className="text-sm text-text-tertiary">No repositories found in the selected folder.</p>
      )}

      {error && <p className="text-sm text-error">{error}</p>}
    </div>
  );
}

function trimTrailingSep(value: string): string {
  return value.replace(/[\\/]+$/, '');
}

function parentDir(value: string): string {
  const trimmed = trimTrailingSep(value);
  const idx = trimmed.lastIndexOf('/');
  const idxBack = trimmed.lastIndexOf('\\');
  const cut = Math.max(idx, idxBack);
  return cut > 0 ? trimmed.slice(0, cut) : trimmed;
}
