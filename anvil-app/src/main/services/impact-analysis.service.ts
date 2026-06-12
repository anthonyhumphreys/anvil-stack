import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import { getDb } from '../db/database.js';
import { loadPromptTemplate } from '../utils/prompt-templates.js';
import { callLlm } from './llm.service.js';
import { getItem } from './lifecycle.service.js';
import { getBranchDiff, getCommitRangeDiff } from './code-review-git.service.js';
import type {
  ImpactAnalysis,
  ImpactAnalysisScopeType,
  AffectedModule,
  AnalysisProgress,
} from '../../shared/lifecycle-types.js';

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface ImpactAnalysisRow {
  id: string;
  lifecycle_item_id: string;
  scope_type: string;
  scope_ref: string | null;
  status: string;
  executive_summary: string | null;
  risk_rating: string | null;
  affected_modules: string;
  technology_changes: string;
  cross_cutting_concerns: string;
  technical_appendix: string | null;
  started_at: string;
  completed_at: string | null;
}

function mapAnalysis(row: ImpactAnalysisRow): ImpactAnalysis {
  return {
    id: row.id,
    lifecycleItemId: row.lifecycle_item_id,
    scopeType: row.scope_type as ImpactAnalysisScopeType,
    scopeRef: row.scope_ref ?? undefined,
    status: row.status as 'running' | 'completed' | 'failed',
    executiveSummary: row.executive_summary ?? undefined,
    riskRating: (row.risk_rating as 'high' | 'medium' | 'low') ?? undefined,
    affectedModules: JSON.parse(row.affected_modules) as AffectedModule[],
    technologyChanges: JSON.parse(row.technology_changes) as string[],
    crossCuttingConcerns: JSON.parse(row.cross_cutting_concerns) as string[],
    technicalAppendix: row.technical_appendix ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Progress helper
// ---------------------------------------------------------------------------

function emitProgress(data: AnalysisProgress): void {
  const win = BrowserWindow.getAllWindows()[0];
  win?.webContents.send('lifecycle:analysis-progress', data);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runAnalysis(
  lifecycleItemId: string,
  opts: {
    scopeType: ImpactAnalysisScopeType;
    scopeRef?: string;
    repoId?: string;
    selectedModulePaths?: string[];
  },
): Promise<ImpactAnalysis> {
  const db = getDb();
  const id = randomUUID();

  db.prepare(
    `INSERT INTO impact_analyses (id, lifecycle_item_id, scope_type, scope_ref, status, started_at)
     VALUES (?, ?, ?, ?, 'running', datetime('now'))`,
  ).run(id, lifecycleItemId, opts.scopeType, opts.scopeRef ?? null);

  try {
    const item = getItem(lifecycleItemId);
    emitProgress({ lifecycleItemId, message: 'Loading repository context...', percent: 10 });

    // Gather repo context
    const repoIds = opts.repoId ? [opts.repoId] : item.linkedRepoIds;
    const repoContext = buildRepoContext(repoIds);

    let prompt: string;

    if (opts.scopeType === 'manual') {
      emitProgress({ lifecycleItemId, message: 'Building manual scope analysis...', percent: 20 });
      const selectedModules = (opts.selectedModulePaths ?? [])
        .map((p) => repoContext.modules.find((m) => m.path === p))
        .filter(Boolean)
        .map((m) => `- **${m!.path}**: ${m!.purpose} (deps: ${m!.dependencies})`)
        .join('\n');
      const allModules = repoContext.modules
        .map((m) => `- **${m.path}**: ${m.purpose} (deps: ${m.dependencies})`)
        .join('\n');

      prompt = loadPromptTemplate('impact-analysis-manual.md', {
        architectureDescription: repoContext.architectureDescription,
        mermaidDiagram: repoContext.mermaidDiagram,
        patterns: repoContext.patterns,
        selectedModules,
        allModules,
      });
    } else {
      emitProgress({ lifecycleItemId, message: 'Gathering code diff...', percent: 20 });
      const repoPath = getRepoPath(repoIds[0]);
      const scopeRef = opts.scopeRef ? JSON.parse(opts.scopeRef) : {};

      const diffFiles =
        opts.scopeType === 'branch_diff'
          ? getBranchDiff(repoPath, scopeRef.baseBranch, scopeRef.compareBranch)
          : getCommitRangeDiff(repoPath, scopeRef.fromSha, scopeRef.toSha);

      const gitDiff = diffFiles.map((f) => `--- ${f.filePath}\n${f.diff}`).join('\n\n');
      const changedFilesMapping = diffFiles
        .map((f) => {
          const mod = repoContext.modules.find((m) => f.filePath.startsWith(m.path));
          return `${f.filePath} → ${mod?.path ?? '(root)'}`;
        })
        .join('\n');

      const moduleDependencyMap = repoContext.modules
        .map((m) => `- **${m.path}**: ${m.purpose} (deps: ${m.dependencies})`)
        .join('\n');

      prompt = loadPromptTemplate('impact-analysis-diff.md', {
        architectureDescription: repoContext.architectureDescription,
        mermaidDiagram: repoContext.mermaidDiagram,
        patterns: repoContext.patterns,
        moduleDependencyMap,
        gitDiff: gitDiff.slice(0, 50_000), // cap diff size
        changedFilesMapping,
      });
    }

    emitProgress({ lifecycleItemId, message: 'Running AI analysis...', percent: 40 });
    const response = await callLlm(prompt, 4096, 0.2, 3, { taskClass: 'long-context' });

    emitProgress({ lifecycleItemId, message: 'Parsing results...', percent: 85 });
    const parsed = parseAnalysisResponse(response);

    db.prepare(
      `UPDATE impact_analyses SET
        status = 'completed',
        executive_summary = ?,
        risk_rating = ?,
        affected_modules = ?,
        technology_changes = ?,
        cross_cutting_concerns = ?,
        technical_appendix = ?,
        completed_at = datetime('now')
      WHERE id = ?`,
    ).run(
      parsed.executiveSummary,
      parsed.riskRating,
      JSON.stringify(parsed.affectedModules),
      JSON.stringify(parsed.technologyChanges),
      JSON.stringify(parsed.crossCuttingConcerns),
      parsed.technicalAppendix,
      id,
    );

    emitProgress({ lifecycleItemId, message: 'Analysis complete', percent: 100 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(
      "UPDATE impact_analyses SET status = 'failed', executive_summary = ?, completed_at = datetime('now') WHERE id = ?",
    ).run(msg, id);
  }

  const row = db.prepare('SELECT * FROM impact_analyses WHERE id = ?').get(id) as ImpactAnalysisRow;
  return mapAnalysis(row);
}

export function getAnalysis(id: string): ImpactAnalysis {
  const row = getDb().prepare('SELECT * FROM impact_analyses WHERE id = ?').get(id) as
    | ImpactAnalysisRow
    | undefined;
  if (!row) throw new Error(`Impact analysis not found: ${id}`);
  return mapAnalysis(row);
}

export function listAnalyses(lifecycleItemId: string): ImpactAnalysis[] {
  const rows = getDb()
    .prepare('SELECT * FROM impact_analyses WHERE lifecycle_item_id = ? ORDER BY started_at DESC')
    .all(lifecycleItemId) as ImpactAnalysisRow[];
  return rows.map(mapAnalysis);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ModuleInfo {
  path: string;
  purpose: string;
  dependencies: string;
}

interface RepoContext {
  architectureDescription: string;
  mermaidDiagram: string;
  patterns: string;
  modules: ModuleInfo[];
}

function buildRepoContext(repoIds: string[]): RepoContext {
  const db = getDb();
  let architectureDescription = '';
  let mermaidDiagram = '';
  let patterns = '';
  const modules: ModuleInfo[] = [];

  for (const repoId of repoIds) {
    const summary = db
      .prepare(
        'SELECT architecture_description, mermaid_diagram, patterns FROM repo_summaries WHERE repo_id = ?',
      )
      .get(repoId) as
      | {
          architecture_description: string | null;
          mermaid_diagram: string | null;
          patterns: string | null;
        }
      | undefined;

    if (summary) {
      if (summary.architecture_description)
        architectureDescription += summary.architecture_description + '\n\n';
      if (summary.mermaid_diagram) mermaidDiagram += summary.mermaid_diagram + '\n\n';
      if (summary.patterns) {
        const parsed = JSON.parse(summary.patterns) as string[];
        patterns += parsed.join(', ') + '\n';
      }
    }

    const modRows = db
      .prepare('SELECT path, purpose, dependencies FROM module_summaries WHERE repo_id = ?')
      .all(repoId) as Array<{ path: string; purpose: string | null; dependencies: string | null }>;

    for (const m of modRows) {
      const deps = m.dependencies ? (JSON.parse(m.dependencies) as string[]).join(', ') : 'none';
      modules.push({ path: m.path, purpose: m.purpose ?? '', dependencies: deps });
    }
  }

  return {
    architectureDescription: architectureDescription.trim() || 'Not available',
    mermaidDiagram: mermaidDiagram.trim() || 'Not available',
    patterns: patterns.trim() || 'None detected',
    modules,
  };
}

function getRepoPath(repoId: string): string {
  const row = getDb().prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
    | { path: string }
    | undefined;
  if (!row) throw new Error(`Repo not found: ${repoId}`);
  return row.path;
}

interface ParsedAnalysis {
  executiveSummary: string;
  riskRating: 'high' | 'medium' | 'low';
  affectedModules: AffectedModule[];
  technologyChanges: string[];
  crossCuttingConcerns: string[];
  technicalAppendix: string;
}

function parseAnalysisResponse(text: string): ParsedAnalysis {
  const cleaned = text
    .replace(/^```json?\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim();
  const parsed = JSON.parse(cleaned);
  return {
    executiveSummary: parsed.executiveSummary ?? '',
    riskRating: parsed.riskRating ?? 'medium',
    affectedModules: (parsed.affectedModules ?? []).map((m: Record<string, unknown>) => ({
      modulePath: m.modulePath ?? '',
      modulePurpose: m.modulePurpose ?? '',
      impactLevel: m.impactLevel ?? 'medium',
      impactDescription: m.impactDescription ?? '',
      affectedFiles: m.affectedFiles ?? [],
      downstreamDependents: m.downstreamDependents ?? [],
    })),
    technologyChanges: parsed.technologyChanges ?? [],
    crossCuttingConcerns: parsed.crossCuttingConcerns ?? [],
    technicalAppendix: parsed.technicalAppendix ?? '',
  };
}
