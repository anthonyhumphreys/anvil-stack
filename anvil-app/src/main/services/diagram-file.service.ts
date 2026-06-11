import {
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { callLlm } from './llm.service.js';
import { loadPromptTemplate } from '../utils/prompt-templates.js';
import type { DiagramFile } from '../../shared/types.js';

const DIAGRAMS_DIR = 'docs/diagrams';

function diagramsPath(repoPath: string): string {
  return join(repoPath, DIAGRAMS_DIR);
}

function filenameToTitle(filename: string): string {
  return basename(filename, '.drawio');
}

export function listDiagramFiles(repoPath: string): DiagramFile[] {
  const dir = diagramsPath(repoPath);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith('.drawio'))
    .map((filename) => {
      const filePath = join(dir, filename);
      const xml = readFileSync(filePath, 'utf-8');
      const stat = statSync(filePath);
      return {
        filename,
        title: filenameToTitle(filename),
        xml,
        mtime: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function readDiagramFile(repoPath: string, filename: string): DiagramFile | null {
  const filePath = join(diagramsPath(repoPath), filename);
  if (!existsSync(filePath)) return null;
  const xml = readFileSync(filePath, 'utf-8');
  const stat = statSync(filePath);
  return {
    filename,
    title: filenameToTitle(filename),
    xml,
    mtime: stat.mtimeMs,
  };
}

export function writeDiagramFile(repoPath: string, filename: string, xml: string): void {
  const dir = diagramsPath(repoPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), xml, 'utf-8');
}

export function deleteDiagramFile(repoPath: string, filename: string): void {
  const filePath = join(diagramsPath(repoPath), filename);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

export function sanitizeFilename(title: string): string {
  const sanitized = title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized || 'untitled';
}

export function resolveFilenameConflict(repoPath: string, filename: string): string {
  const dir = diagramsPath(repoPath);
  if (!existsSync(join(dir, filename))) return filename;

  const base = basename(filename, '.drawio');
  let counter = 1;
  while (existsSync(join(dir, `${base}-${counter}.drawio`))) {
    counter++;
  }
  return `${base}-${counter}.drawio`;
}

export function diagramsDirExists(repoPath: string): boolean {
  return existsSync(diagramsPath(repoPath));
}

// LLM generation helpers

interface DiagramGenerationResult {
  title: string;
  drawioXml: string;
}

export function parseDiagramResponse(raw: string): DiagramGenerationResult {
  if (!raw || !raw.trim()) {
    throw new Error('LLM returned empty response — no diagram could be generated');
  }
  const fenced = raw.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = fenced ? fenced[1].trim() : raw.trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('Failed to parse diagram response as JSON');
  }
  if (!parsed.drawioXml || typeof parsed.drawioXml !== 'string') {
    throw new Error('Response missing required drawioXml field');
  }
  return {
    title: typeof parsed.title === 'string' ? parsed.title : 'Untitled Diagram',
    drawioXml: parsed.drawioXml,
  };
}

export function truncateContext(context: string, maxWords = 4000): string {
  const words = context.split(/\s+/);
  if (words.length <= maxWords) return context;
  return words.slice(-maxWords).join(' ');
}

let activeAbortController: AbortController | null = null;

export async function generateDiagram(
  context: string,
  existingXml?: string,
): Promise<DiagramGenerationResult> {
  const truncated = truncateContext(context);
  const templateName = existingXml ? 'diagram-iterate.md' : 'diagram-generate.md';
  const template = loadPromptTemplate(templateName, {
    context: truncated,
    existing_xml: existingXml ?? '',
  });
  activeAbortController = new AbortController();
  try {
    const raw = await callLlm(template, 4096, 0.3, 3, { taskClass: 'long-context' });
    return parseDiagramResponse(raw);
  } finally {
    activeAbortController = null;
  }
}

export function cancelGeneration(): void {
  activeAbortController?.abort();
  activeAbortController = null;
}

export async function initializeDiagrams(
  repoPath: string,
  repoContext: string,
): Promise<DiagramFile[]> {
  const diagramTypes = [
    'Architecture Overview — show the high-level components, layers, and their relationships',
    'Key Data Flows — show the primary data/request flows through the system',
    'C4 Context Diagram — show the system in its environment with external actors and systems',
  ];

  const results: DiagramFile[] = [];
  for (const diagramType of diagramTypes) {
    const context = `${repoContext}\n\nGenerate a ${diagramType}`;
    const result = await generateDiagram(context);
    const filename = resolveFilenameConflict(repoPath, `${sanitizeFilename(result.title)}.drawio`);
    writeDiagramFile(repoPath, filename, result.drawioXml);
    const diagram = readDiagramFile(repoPath, filename);
    if (diagram) results.push(diagram);
  }
  return results;
}
