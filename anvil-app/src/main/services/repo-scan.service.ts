import fs from 'node:fs';
import path from 'node:path';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  '__pycache__',
  '.venv',
  'build',
  'dist',
  '.trash',
  '.cache',
  '.npm',
  '.yarn',
]);

const MAX_RESULTS = 500;

let currentScanAbort: AbortController | null = null;

export function cancelScan(): void {
  currentScanAbort?.abort();
  currentScanAbort = null;
}

export function scanForRepos(
  folderPath: string,
  maxDepth: number = 4,
): Array<{ path: string; name: string }> {
  const results: Array<{ path: string; name: string }> = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth || results.length >= MAX_RESULTS) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) {
        return;
      }

      if (!entry.isDirectory()) {
        continue;
      }

      if (EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      // Check if this directory contains a .git subdirectory
      const gitPath = path.join(fullPath, '.git');
      try {
        const stat = fs.statSync(gitPath);
        if (stat.isDirectory()) {
          results.push({ path: fullPath, name: entry.name });
          // Do not descend further into this subtree
          continue;
        }
      } catch {
        // .git doesn't exist here, keep walking
      }

      walk(fullPath, depth + 1);
    }
  }

  // Check if the selected folder itself is a git repo
  try {
    const rootGit = path.join(folderPath, '.git');
    const stat = fs.statSync(rootGit);
    if (stat.isDirectory()) {
      results.push({ path: folderPath, name: path.basename(folderPath) });
      return results;
    }
  } catch {
    // Not a repo at root level — scan children
  }

  walk(folderPath, 0);
  return results;
}

export async function scanForReposAsync(
  folderPath: string,
  maxDepth: number = 4,
  onFound?: (repo: { path: string; name: string }) => void,
): Promise<Array<{ path: string; name: string }>> {
  currentScanAbort = new AbortController();
  const signal = currentScanAbort.signal;
  const results: Array<{ path: string; name: string }> = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (signal.aborted || depth > maxDepth || results.length >= MAX_RESULTS) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (signal.aborted || results.length >= MAX_RESULTS) {
        return;
      }

      if (!entry.isDirectory()) {
        continue;
      }

      if (EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      // Check if this directory contains a .git subdirectory
      const gitPath = path.join(fullPath, '.git');
      try {
        const stat = await fs.promises.stat(gitPath);
        if (stat.isDirectory()) {
          const repo = { path: fullPath, name: entry.name };
          results.push(repo);
          onFound?.(repo);
          // Do not descend further into this subtree
          continue;
        }
      } catch {
        // .git doesn't exist here, keep walking
      }

      await walk(fullPath, depth + 1);
    }
  }

  // Check if the selected folder itself is a git repo
  try {
    const rootGit = path.join(folderPath, '.git');
    const stat = await fs.promises.stat(rootGit);
    if (stat.isDirectory()) {
      const repo = { path: folderPath, name: path.basename(folderPath) };
      results.push(repo);
      onFound?.(repo);
      currentScanAbort = null;
      return results;
    }
  } catch {
    // Not a repo at root level — scan children
  }

  await walk(folderPath, 0);
  currentScanAbort = null;
  return results;
}
