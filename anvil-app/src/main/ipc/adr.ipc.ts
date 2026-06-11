import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/database.js';
import type { AdrEntry, RepoAdrs } from '../../shared/types.js';

/** Common directory names where ADRs live */
const ADR_DIR_CANDIDATES = [
  'docs/adr',
  'docs/adrs',
  'docs/architecture/decisions',
  'docs/architecture-decisions',
  'docs/decisions',
  'adr',
  'adrs',
  'architecture-decisions',
  'doc/adr',
  'doc/adrs',
  '.adr',
];

/** Try to extract the title from the first markdown heading */
function extractTitle(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : filename.replace(/\.md$/i, '');
}

/** Try to extract ADR status from content (e.g. "Status: Accepted") */
function extractStatus(content: string): string | undefined {
  // Match "Status: <value>" or "## Status\n\n<value>"
  const inlineMatch = content.match(/^\*?\*?Status\*?\*?\s*[:]\s*(.+)$/im);
  if (inlineMatch) return inlineMatch[1].trim();

  const sectionMatch = content.match(/^##\s+Status\s*\n+\s*(.+)$/im);
  if (sectionMatch) return sectionMatch[1].trim();

  return undefined;
}

/** Directories to skip when walking the repo tree */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'target',
  'bin',
  'obj',
]);

/** Build an ADR entry from a file on disk */
function buildAdrEntry(repoPath: string, relativePath: string): AdrEntry | null {
  const fullPath = path.join(repoPath, relativePath);
  try {
    if (!fs.statSync(fullPath).isFile()) return null;
  } catch {
    return null;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const filename = path.basename(relativePath);

  return {
    relativePath,
    filename,
    title: extractTitle(content, filename),
    content,
    status: extractStatus(content),
  };
}

/** Read ADR-prefixed markdown files from a known directory */
function readAdrsFromDir(repoPath: string, adrDir: string): AdrEntry[] {
  const fullDir = path.join(repoPath, adrDir);
  if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) return [];

  const entries: AdrEntry[] = [];

  for (const file of fs.readdirSync(fullDir).sort()) {
    if (!file.toLowerCase().endsWith('.md')) continue;

    const entry = buildAdrEntry(repoPath, path.join(adrDir, file));
    if (entry) entries.push(entry);
  }

  return entries;
}

/**
 * Recursively walk the repo looking for markdown files whose name starts
 * with "ADR" (case-insensitive). This catches ADRs that live outside the
 * conventional directory candidates — the filename convention is the
 * primary signal.
 */
function findAdrFilesByName(repoPath: string): AdrEntry[] {
  const entries: AdrEntry[] = [];

  function walk(dir: string): void {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission denied, symlink loop, etc.
    }

    for (const item of items) {
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) {
          walk(path.join(dir, item.name));
        }
      } else if (
        item.isFile() &&
        item.name.toLowerCase().startsWith('adr') &&
        item.name.toLowerCase().endsWith('.md')
      ) {
        const relativePath = path.relative(repoPath, path.join(dir, item.name));
        const entry = buildAdrEntry(repoPath, relativePath);
        if (entry) entries.push(entry);
      }
    }
  }

  walk(repoPath);
  return entries;
}

/** Scan a repo for ADR entries using both directory candidates and filename convention */
function scanRepoForAdrs(repoPath: string): AdrEntry[] {
  const allAdrs: AdrEntry[] = [];
  const seen = new Set<string>();

  const addUnique = (adr: AdrEntry): void => {
    if (!seen.has(adr.relativePath)) {
      seen.add(adr.relativePath);
      allAdrs.push(adr);
    }
  };

  // 1. Check well-known ADR directories (reads all .md files in them)
  for (const candidate of ADR_DIR_CANDIDATES) {
    for (const adr of readAdrsFromDir(repoPath, candidate)) {
      addUnique(adr);
    }
  }

  // 2. Walk the repo for any file whose name starts with "ADR"
  for (const adr of findAdrFilesByName(repoPath)) {
    addUnique(adr);
  }

  // Sort by filename for a stable, predictable order
  allAdrs.sort((a, b) => a.filename.localeCompare(b.filename));

  return allAdrs;
}

export function registerAdrHandlers(): void {
  ipcMain.handle(
    'adr:list-by-workspace',
    async (_event, workspaceId: string): Promise<RepoAdrs[]> => {
      const db = getDb();

      const repos = db
        .prepare(
          `SELECT r.id, r.name, r.path
           FROM repos r
           JOIN workspace_repos wr ON wr.repo_id = r.id
           WHERE wr.workspace_id = ?`,
        )
        .all(workspaceId) as Array<{ id: string; name: string; path: string }>;

      const results: RepoAdrs[] = [];

      for (const repo of repos) {
        const adrs = scanRepoForAdrs(repo.path);
        if (adrs.length > 0) {
          results.push({ repoId: repo.id, repoName: repo.name, adrs });
        }
      }

      return results;
    },
  );
}
