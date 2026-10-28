// Repo diagram files for the Diagram surface, following diagram-file.service
// conventions: everything lives in docs/diagrams/. draw.io diagrams are
// `.drawio` (what the Diagrams view lists); Mermaid diagrams are saved as
// raw `.mmd` source next to them.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { DiagramFormat } from '../../../../shared/surfaces/kinds/diagram.js';
import {
  listDiagramFiles,
  readDiagramFile,
  resolveFilenameConflict,
  sanitizeFilename,
  writeDiagramFile,
} from '../../../services/diagram-file.service.js';

export const DIAGRAMS_DIR = 'docs/diagrams';
const EXTENSIONS: Record<DiagramFormat, string> = { mermaid: '.mmd', drawio: '.drawio' };
const SAFE_FILENAME = /^[A-Za-z0-9][\w.-]*\.(?:drawio|mmd)$/;

export interface RepoDiagramEntry {
  filename: string;
  format: DiagramFormat;
  mtime: number;
  bytes: number;
}

export function formatForFilename(filename: string): DiagramFormat | null {
  const extension = extname(filename).toLowerCase();
  if (extension === '.drawio') return 'drawio';
  if (extension === '.mmd') return 'mermaid';
  return null;
}

/** Plain file name inside docs/diagrams (no separators, no traversal), else null. */
export function safeDiagramFilename(filename: unknown): string | null {
  if (typeof filename !== 'string') return null;
  const trimmed = filename.trim();
  if (!trimmed || trimmed !== basename(trimmed) || trimmed.includes('..')) return null;
  return SAFE_FILENAME.test(trimmed) ? trimmed : null;
}

export function listRepoDiagrams(repoPath: string): RepoDiagramEntry[] {
  const entries: RepoDiagramEntry[] = listDiagramFiles(repoPath).map((file) => ({
    filename: file.filename,
    format: 'drawio',
    mtime: file.mtime,
    bytes: Buffer.byteLength(file.xml, 'utf8'),
  }));
  const dir = join(repoPath, DIAGRAMS_DIR);
  if (existsSync(dir)) {
    for (const filename of readdirSync(dir)) {
      if (!filename.endsWith('.mmd') || !safeDiagramFilename(filename)) continue;
      const stat = statSync(join(dir, filename));
      entries.push({ filename, format: 'mermaid', mtime: stat.mtimeMs, bytes: stat.size });
    }
  }
  return entries.sort((a, b) => b.mtime - a.mtime);
}

export function readRepoDiagram(
  repoPath: string,
  filename: string,
): { filename: string; format: DiagramFormat; source: string } | null {
  const safe = safeDiagramFilename(filename);
  const format = safe ? formatForFilename(safe) : null;
  if (!safe || !format) return null;
  const file = readDiagramFile(repoPath, safe);
  return file ? { filename: safe, format, source: file.xml } : null;
}

function uniqueFilename(repoPath: string, stem: string, extension: string): string {
  if (extension === '.drawio') return resolveFilenameConflict(repoPath, `${stem}.drawio`);
  const dir = join(repoPath, DIAGRAMS_DIR);
  if (!existsSync(join(dir, `${stem}${extension}`))) return `${stem}${extension}`;
  let counter = 1;
  while (existsSync(join(dir, `${stem}-${counter}${extension}`))) counter += 1;
  return `${stem}-${counter}${extension}`;
}

/**
 * Writes the diagram into docs/diagrams. Re-saving a surface that already has
 * a `savedPath` there overwrites that file; otherwise a fresh, non-clashing
 * name is derived from the title. Returns the repo-relative path.
 */
export function saveRepoDiagram(
  repoPath: string,
  input: { format: DiagramFormat; title: string; source: string; savedPath?: string },
): string {
  const extension = EXTENSIONS[input.format];
  let filename: string | null = null;
  if (input.savedPath?.startsWith(`${DIAGRAMS_DIR}/`)) {
    const previous = safeDiagramFilename(input.savedPath.slice(DIAGRAMS_DIR.length + 1));
    if (previous && extname(previous) === extension) filename = previous;
  }
  if (!filename) {
    const stem =
      sanitizeFilename(input.title)
        .replace(/^[.-]+|[.-]+$/g, '')
        .slice(0, 80) || 'diagram';
    filename = uniqueFilename(repoPath, stem, extension);
  }
  const content = input.source.endsWith('\n') ? input.source : `${input.source}\n`;
  writeDiagramFile(repoPath, filename, content);
  return `${DIAGRAMS_DIR}/${filename}`;
}
