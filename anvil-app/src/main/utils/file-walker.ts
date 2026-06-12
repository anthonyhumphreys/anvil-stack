import { globby } from 'globby';
import fs from 'node:fs';
import path from 'node:path';

export interface FileEntry {
  relativePath: string;
  extension: string;
  sizeBytes: number;
}

const ALWAYS_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'bin',
  'obj',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '.parcel-cache',
  'target', // Rust/Java
  '.gradle',
  '.idea',
  '.vs',
];

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.mp3',
  '.mp4',
  '.wav',
  '.avi',
  '.mov',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.lock',
]);

export async function walkRepo(repoPath: string): Promise<FileEntry[]> {
  const ignorePatterns = ALWAYS_IGNORE.map((d) => `**/${d}/**`);

  const files = await globby('**/*', {
    cwd: repoPath,
    gitignore: true,
    ignore: ignorePatterns,
    dot: false,
    onlyFiles: true,
  });

  const entries: FileEntry[] = [];
  for (const relativePath of files) {
    const ext = path.extname(relativePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;

    try {
      const stat = fs.statSync(path.join(repoPath, relativePath));
      entries.push({
        relativePath,
        extension: ext,
        sizeBytes: stat.size,
      });
    } catch {
      // skip files we can't stat
    }
  }

  return entries;
}

export function readFileContent(repoPath: string, relativePath: string, maxBytes = 50_000): string {
  const fullPath = path.join(repoPath, relativePath);
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    if (content.length > maxBytes) {
      return content.slice(0, maxBytes) + '\n... [truncated]';
    }
    return content;
  } catch {
    return '';
  }
}

export function buildDirectoryTree(files: FileEntry[], maxDepth = 4): string {
  const tree: Record<string, boolean> = {};

  for (const file of files) {
    const parts = file.relativePath.split('/');
    // Add directories up to maxDepth
    for (let i = 0; i < Math.min(parts.length, maxDepth); i++) {
      const dirPath = parts.slice(0, i + 1).join('/');
      tree[dirPath] = i === parts.length - 1; // true if leaf (file)
    }
  }

  const sorted = Object.keys(tree).sort();
  const lines: string[] = [];
  for (const entry of sorted) {
    const depth = entry.split('/').length - 1;
    const indent = '  '.repeat(depth);
    const name = path.basename(entry);
    const suffix = tree[entry] ? '' : '/';
    lines.push(`${indent}${name}${suffix}`);
  }

  return lines.join('\n');
}
