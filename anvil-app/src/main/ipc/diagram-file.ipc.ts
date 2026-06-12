import { ipcMain } from 'electron';
import {
  listDiagramFiles,
  readDiagramFile,
  writeDiagramFile,
  deleteDiagramFile,
  generateDiagram,
  cancelGeneration,
  initializeDiagrams,
  diagramsDirExists,
} from '../services/diagram-file.service.js';
import {
  openInDrawio,
  checkDrawioAvailability,
  cleanupDrawioMcp,
} from '../services/drawio-mcp.service.js';
import { getDb } from '../db/database.js';

function resolveRepoPath(repoId: string): string {
  const db = getDb();
  const row = db.prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
    | { path: string }
    | undefined;
  if (!row) throw new Error(`Repo not found: ${repoId}`);
  return row.path;
}

function getRepoContext(repoId: string): string {
  const db = getDb();
  const summary = db
    .prepare(
      'SELECT overview, architecture_description, mermaid_diagram, patterns, frameworks, entry_points, config_files, language_breakdown FROM repo_summaries WHERE repo_id = ?',
    )
    .get(repoId) as
    | {
        overview: string | null;
        architecture_description: string | null;
        mermaid_diagram: string | null;
        patterns: string | null;
        frameworks: string | null;
        entry_points: string | null;
        config_files: string | null;
        language_breakdown: string | null;
      }
    | undefined;
  if (!summary) return '';

  const modules = db
    .prepare(
      'SELECT path, purpose, key_files, dependencies FROM module_summaries WHERE repo_id = ?',
    )
    .all(repoId) as Array<{
    path: string;
    purpose: string;
    key_files: string | null;
    dependencies: string | null;
  }>;

  const sections: string[] = [];

  if (summary.overview) {
    sections.push(`## Project Overview\n${summary.overview}`);
  }

  if (summary.language_breakdown) {
    try {
      const langs = JSON.parse(summary.language_breakdown) as Array<{
        language: string;
        percentage: number;
      }>;
      if (langs.length > 0) {
        sections.push(
          `## Languages\n${langs.map((l) => `- ${l.language}: ${l.percentage}%`).join('\n')}`,
        );
      }
    } catch {
      /* skip */
    }
  }

  if (summary.frameworks) {
    try {
      const fw = JSON.parse(summary.frameworks) as string[];
      if (fw.length > 0) {
        sections.push(`## Frameworks & Libraries\n${fw.join(', ')}`);
      }
    } catch {
      /* skip */
    }
  }

  if (summary.patterns) {
    try {
      const pats = JSON.parse(summary.patterns) as string[];
      if (pats.length > 0) {
        sections.push(`## Patterns\n${pats.join(', ')}`);
      }
    } catch {
      /* skip */
    }
  }

  if (summary.entry_points) {
    try {
      const eps = JSON.parse(summary.entry_points) as string[];
      if (eps.length > 0) {
        sections.push(`## Entry Points\n${eps.join(', ')}`);
      }
    } catch {
      /* skip */
    }
  }

  if (modules.length > 0) {
    const moduleLines = modules.map((m) => {
      let line = `- **${m.path}**: ${m.purpose}`;
      if (m.key_files) {
        try {
          const files = JSON.parse(m.key_files) as string[];
          if (files.length > 0) line += `\n  Key files: ${files.join(', ')}`;
        } catch {
          /* skip */
        }
      }
      if (m.dependencies) {
        try {
          const deps = JSON.parse(m.dependencies) as string[];
          if (deps.length > 0) line += `\n  Dependencies: ${deps.join(', ')}`;
        } catch {
          /* skip */
        }
      }
      return line;
    });
    sections.push(`## Modules\n${moduleLines.join('\n')}`);
  }

  if (summary.mermaid_diagram) {
    sections.push(
      `## Existing Architecture Diagram (Mermaid)\n\`\`\`mermaid\n${summary.mermaid_diagram}\n\`\`\``,
    );
  }

  return sections.join('\n\n');
}

export function registerDiagramFileHandlers(): void {
  ipcMain.handle('diagram:list', (_event, repoId: string) => {
    return listDiagramFiles(resolveRepoPath(repoId));
  });

  ipcMain.handle('diagram:read', (_event, repoId: string, filename: string) => {
    return readDiagramFile(resolveRepoPath(repoId), filename);
  });

  ipcMain.handle('diagram:write', (_event, repoId: string, filename: string, xml: string) => {
    writeDiagramFile(resolveRepoPath(repoId), filename, xml);
  });

  ipcMain.handle('diagram:delete', (_event, repoId: string, filename: string) => {
    deleteDiagramFile(resolveRepoPath(repoId), filename);
  });

  ipcMain.handle(
    'diagram:generate',
    async (_event, repoId: string, context: string, existingXml?: string) => {
      const repoContext = getRepoContext(repoId);
      const fullContext = repoContext ? `${repoContext}\n\n${context}` : context;
      return generateDiagram(fullContext, existingXml);
    },
  );

  ipcMain.handle('diagram:cancel-generate', () => {
    cancelGeneration();
  });

  ipcMain.handle('diagram:initialize', async (_event, repoId: string) => {
    const repoPath = resolveRepoPath(repoId);
    const repoContext = getRepoContext(repoId);
    return initializeDiagrams(repoPath, repoContext);
  });

  ipcMain.handle('diagram:dir-exists', (_event, repoId: string) => {
    return diagramsDirExists(resolveRepoPath(repoId));
  });

  ipcMain.handle('diagram:open-editor', async (_event, repoId: string, filename: string) => {
    const repoPath = resolveRepoPath(repoId);
    const diagram = readDiagramFile(repoPath, filename);
    if (!diagram) throw new Error(`Diagram not found: ${filename}`);
    await openInDrawio(diagram.xml);
  });

  ipcMain.handle('diagram:check-drawio', async () => {
    const available = await checkDrawioAvailability();
    return { available };
  });
}

export function cleanupDiagramServices(): void {
  cleanupDrawioMcp();
}
