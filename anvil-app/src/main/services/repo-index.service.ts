import type { RepoIndexProgress, RepoSummary, ModuleSummary } from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { analyseRepo, type IndexResult } from './indexer.service.js';
import { summariseModule, summariseRepo } from './foundry.service.js';
import { readFileContent } from '../utils/file-walker.js';
import { onRepoIndexed } from './repobase.service.js';
import { notifyIfUnfocused } from './notification.service.js';
import { getSettings } from './settings.service.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { getCurrentCommitSha } from './code-review-git.service.js';
import { buildRepositoryMapInWorker } from './repository-map-worker.service.js';

interface DbRepoRow {
  id: string;
  name: string;
  path: string;
  remote_url: string | null;
}

export async function indexRepo(
  repoId: string,
  onProgress?: (
    message: string,
    percent: number,
    stage: RepoIndexProgress['stage'],
    detail?: string,
  ) => void,
): Promise<void> {
  const db = getDb();
  const repoRow = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId) as
    | DbRepoRow
    | undefined;
  if (!repoRow) throw new Error(`Repo not found: ${repoId}`);
  const indexedCommitSha = getCurrentCommitSha(repoRow.path);
  const existingMapPreferences = db
    .prepare('SELECT map_refresh_mode FROM repo_summaries WHERE repo_id = ?')
    .get(repoId) as { map_refresh_mode: string | null } | undefined;
  const mapRefreshMode =
    existingMapPreferences?.map_refresh_mode === 'on_commit' ? 'on_commit' : 'manual';

  const sendProgress = (
    message: string,
    percent: number,
    stage: RepoIndexProgress['stage'],
    detail?: string,
  ) => {
    onProgress?.(message, percent, stage, detail);
  };

  try {
    db.prepare(
      "UPDATE repos SET status = 'indexing', updated_at = datetime('now') WHERE id = ?",
    ).run(repoId);
    sendProgress('Queued for indexing...', 0, 'queued');

    sendProgress('Discovering files...', 5, 'discovering');
    const analysis = await analyseRepo(repoRow.path);
    sendProgress(
      `Discovered ${analysis.files.length} files across ${analysis.modules.length} module${analysis.modules.length === 1 ? '' : 's'}.`,
      15,
      'discovering',
    );

    db.prepare("UPDATE repos SET file_count = ?, updated_at = datetime('now') WHERE id = ?").run(
      analysis.files.length,
      repoId,
    );

    const moduleSummaries: ModuleSummary[] = [];
    const modulePercentSpan = analysis.modules.length > 0 ? 70 / analysis.modules.length : 0;
    const llmConcurrency = getSettings().llmProvider === 'codex' ? 1 : 2;
    let completedModules = 0;

    const summarisedModules = await mapWithConcurrency(
      analysis.modules,
      llmConcurrency,
      async (mod, index) => {
        const progressPercent = () => Math.round(15 + modulePercentSpan * completedModules);
        const message = `Analysing module ${index + 1} of ${analysis.modules.length}: ${mod.path}`;
        sendProgress(message, progressPercent(), 'analysing-module');

        const keyFileContents = mod.keyFiles
          .slice(0, 5)
          .map((filePath) => {
            const content = readFileContent(repoRow.path, filePath, 30_000);
            return `### ${filePath}\n\`\`\`\n${content}\n\`\`\``;
          })
          .join('\n\n');

        try {
          const summary = await summariseModule(
            repoRow.name,
            mod.path,
            mod.directoryTree,
            keyFileContents,
            repoRow.path,
            {
              onProgress: (detail) =>
                sendProgress(message, progressPercent(), 'analysing-module', detail),
            },
          );
          summary.fileCount = mod.files.length;
          return summary;
        } catch (err) {
          console.error(`[Indexer] Failed to summarise module ${mod.path}:`, err);
          sendProgress(
            `Using fallback for module ${index + 1} of ${analysis.modules.length}: ${mod.path}`,
            progressPercent(),
            'analysing-module',
            shortErrorMessage(err),
          );
          return {
            path: mod.path,
            purpose: 'Analysis failed',
            fileCount: mod.files.length,
            keyFiles: mod.keyFiles,
            dependencies: [],
          };
        } finally {
          completedModules += 1;
          sendProgress(
            `Analysed ${completedModules} of ${analysis.modules.length} module${analysis.modules.length === 1 ? '' : 's'}...`,
            progressPercent(),
            'analysing-module',
          );
        }
      },
    );
    moduleSummaries.push(...summarisedModules);

    const configContents = analysis.configFiles
      .slice(0, 5)
      .map((filePath) => {
        const content = readFileContent(repoRow.path, filePath, 10_000);
        return `### ${filePath}\n\`\`\`\n${content}\n\`\`\``;
      })
      .join('\n\n');

    let repoSummary: Omit<RepoSummary, 'repoId' | 'modules'>;
    sendProgress('Generating repository overview...', 90, 'generating-summary');
    try {
      repoSummary = await summariseRepo(
        moduleSummaries,
        analysis.fileTree,
        configContents,
        repoRow.path,
        {
          onProgress: (detail) =>
            sendProgress('Generating repository overview...', 90, 'generating-summary', detail),
        },
      );
      repoSummary = {
        ...repoSummary,
        indexMode: 'light',
        indexProvider: 'local-llm',
        indexWarnings: [],
      };
    } catch (err) {
      console.error('[Indexer] Failed to generate repo summary, using fallback:', err);
      sendProgress(
        'Codex summary failed, building a fallback overview...',
        92,
        'generating-summary',
        shortErrorMessage(err),
      );
      repoSummary = buildFallbackRepoSummary(repoRow.name, analysis, moduleSummaries);
    }

    sendProgress('Saving results...', 97, 'saving');

    const repositoryMapGraph = await buildRepositoryMapInWorker({
      repoId,
      repositoryName: repoRow.name,
      repoPath: repoRow.path,
      indexedCommitSha,
      files: analysis.files,
      modules: moduleSummaries,
    });

    const insertModule = db.prepare(`
      INSERT OR REPLACE INTO module_summaries (repo_id, path, purpose, file_count, key_files, dependencies, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    for (const mod of moduleSummaries) {
      insertModule.run(
        repoId,
        mod.path,
        mod.purpose,
        mod.fileCount,
        JSON.stringify(mod.keyFiles),
        JSON.stringify(mod.dependencies),
      );
    }

    db.prepare(
      `INSERT OR REPLACE INTO repository_map_graphs (
        repo_id, schema_version, indexed_commit_sha, graph_json, generated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      repoId,
      repositoryMapGraph.schemaVersion,
      indexedCommitSha ?? null,
      JSON.stringify(repositoryMapGraph),
      repositoryMapGraph.generatedAt,
    );

    db.prepare(
      `
      INSERT OR REPLACE INTO repo_summaries (
        repo_id,
        overview,
        architecture_description,
        mermaid_diagram,
        patterns,
        frameworks,
        entry_points,
        config_files,
        language_breakdown,
        generated_at,
        model_version,
        index_mode,
        index_provider,
        index_warnings,
        map_refresh_mode,
        generated_commit_sha
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      repoId,
      repoSummary.overview,
      repoSummary.overview,
      repoSummary.mermaidDiagram,
      JSON.stringify(repoSummary.patterns),
      JSON.stringify([...new Set([...analysis.frameworks, ...repoSummary.frameworks])]),
      JSON.stringify(repoSummary.entryPoints),
      JSON.stringify(repoSummary.configFiles),
      JSON.stringify(analysis.languages),
      repoSummary.indexProvider === 'local-llm' ? 'gpt-5.3-codex' : 'local-structural',
      repoSummary.indexMode ?? 'light',
      repoSummary.indexProvider ?? 'local-fallback',
      JSON.stringify(repoSummary.indexWarnings ?? []),
      mapRefreshMode,
      indexedCommitSha ?? null,
    );

    db.prepare(
      "UPDATE repos SET status = 'indexed', last_indexed = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    ).run(repoId);

    onRepoIndexed(repoRow.remote_url).catch(() => {});
    sendProgress('Indexing complete', 100, 'complete');
    notifyIfUnfocused('Indexing Complete', `${repoRow.name} has been indexed.`);
  } catch (err) {
    db.prepare("UPDATE repos SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(
      repoId,
    );
    sendProgress('Indexing failed', 0, 'error', shortErrorMessage(err));
    throw err;
  }
}

function shortErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 220 ? `${message.slice(0, 217)}...` : message;
}

function buildFallbackRepoSummary(
  repoName: string,
  analysis: IndexResult,
  moduleSummaries: ModuleSummary[],
): Omit<RepoSummary, 'repoId' | 'modules'> {
  const topLanguages = analysis.languages
    .slice(0, 3)
    .map((lang) => `${lang.language} (${lang.percentage}%)`)
    .join(', ');
  const moduleList = moduleSummaries
    .slice(0, 3)
    .map((mod) => (mod.path === '.' ? 'the repository root' : mod.path))
    .join(', ');
  const entryPoints = moduleSummaries.flatMap((mod) => mod.keyFiles).slice(0, 8);

  const moduleNodes = moduleSummaries.slice(0, 8);
  const mermaidLines = [
    'graph TD',
    `  R["${escapeMermaidLabel(repoName)}"]`,
    ...moduleNodes.flatMap((mod, index) => [
      `  M${index}["${escapeMermaidLabel(mod.path === '.' ? 'root' : mod.path)}"]`,
      '  R --> M' + index,
    ]),
  ];

  if (moduleSummaries.length > moduleNodes.length) {
    mermaidLines.push(`  MORE["${moduleSummaries.length - moduleNodes.length} more modules"]`);
    mermaidLines.push('  R --> MORE');
  }

  return {
    overview: [
      `${repoName} contains ${analysis.files.length} files grouped into ${analysis.modules.length} top-level module${analysis.modules.length === 1 ? '' : 's'}.`,
      analysis.frameworks.length > 0
        ? `Detected frameworks: ${analysis.frameworks.join(', ')}.`
        : 'No frameworks were confidently detected from config files.',
      topLanguages
        ? `Primary languages: ${topLanguages}.`
        : 'Primary languages could not be determined from file extensions.',
      moduleList ? `Key areas include ${moduleList}.` : 'No significant modules were detected.',
      'This fallback summary was generated from repository structure because the LLM summary step did not complete successfully.',
    ].join(' '),
    patterns: analysis.modules.length > 1 ? ['Top-level module separation'] : [],
    frameworks: analysis.frameworks,
    entryPoints,
    configFiles: analysis.configFiles.slice(0, 10),
    mermaidDiagram: mermaidLines.join('\n'),
    indexMode: 'light',
    indexProvider: 'local-fallback',
    indexWarnings: [],
  };
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/"/g, '\\"');
}
