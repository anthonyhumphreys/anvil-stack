import { createHash } from 'node:crypto';
import type { RepoIndexProgress, RepoSummary, ModuleSummary } from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { analyseRepo, type IndexResult, type ModuleInfo } from './indexer.service.js';
import { summariseModule, summariseRepo } from './foundry.service.js';
import { readFileContent, buildDirectoryTree } from '../utils/file-walker.js';
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
  index_tier?: string | null;
}

interface DbModuleSummaryRow {
  path: string;
  purpose: string | null;
  file_count: number | null;
  key_files: string | null;
  dependencies: string | null;
  content_hash: string | null;
}

interface DbSummaryRow {
  overview: string | null;
  mermaid_diagram: string | null;
  patterns: string | null;
  frameworks: string | null;
  entry_points: string | null;
  config_files: string | null;
  map_refresh_mode: string | null;
}

export class RepoIndexCancelledError extends Error {
  constructor(repoId: string) {
    super(`Index job cancelled for repo ${repoId}`);
    this.name = 'RepoIndexCancelledError';
  }
}

export interface RepoIndexRunOptions {
  /** Cooperative cancellation hook, checked between units of work. */
  shouldCancel?: () => boolean;
}

export interface EnrichRepoOptions extends RepoIndexRunOptions {
  /**
   * LLM pool gate injected by the index queue so enrichment calls across repos
   * share one bounded pool. Defaults to a local semaphore sized from settings.
   */
  acquireLlmSlot?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface EnrichRepoResult {
  summarised: number;
  skipped: number;
  failed: number;
}

export type RepoIndexProgressFn = (
  message: string,
  percent: number,
  stage: RepoIndexProgress['stage'],
  detail?: string,
) => void;

// ---------------------------------------------------------------------------
// Status helpers — `status` stays for back-compat and is derived from tier.
// ---------------------------------------------------------------------------

function deriveStatusForTier(tier: string | null | undefined): 'connected' | 'indexed' {
  return tier === 'mapped' || tier === 'enriched' ? 'indexed' : 'connected';
}

function currentIndexTier(db: ReturnType<typeof getDb>, repoId: string): string {
  const row = db.prepare('SELECT index_tier FROM repos WHERE id = ?').get(repoId) as
    | { index_tier: string | null }
    | undefined;
  return row?.index_tier ?? 'connected';
}

function markIndexing(db: ReturnType<typeof getDb>, repoId: string): void {
  db.prepare("UPDATE repos SET status = 'indexing', updated_at = datetime('now') WHERE id = ?").run(
    repoId,
  );
}

function markTierReached(
  db: ReturnType<typeof getDb>,
  repoId: string,
  tier: 'mapped' | 'enriched',
): void {
  // Never downgrade: a mapped refresh on an enriched repo keeps 'enriched'.
  db.prepare(
    `UPDATE repos
     SET index_tier = CASE WHEN index_tier = 'enriched' THEN 'enriched' ELSE ? END,
         status = 'indexed',
         last_indexed = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(tier, repoId);
}

function markJobEnded(db: ReturnType<typeof getDb>, repoId: string, cancelled: boolean): void {
  const tier = currentIndexTier(db, repoId);
  db.prepare("UPDATE repos SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
    cancelled ? deriveStatusForTier(tier) : tier === 'connected' ? 'error' : 'indexed',
    repoId,
  );
}

function throwIfCancelled(repoId: string, options?: RepoIndexRunOptions): void {
  if (options?.shouldCancel?.()) throw new RepoIndexCancelledError(repoId);
}

// ---------------------------------------------------------------------------
// mapped tier — structural pass, no LLM
// ---------------------------------------------------------------------------

/**
 * Structural index: walk, languages, frameworks, module split, repository map
 * graph and a fallback summary. Fast (seconds) and unlocks all repo features.
 */
export async function mapRepo(
  repoId: string,
  onProgress?: RepoIndexProgressFn,
  options?: RepoIndexRunOptions,
): Promise<void> {
  const db = getDb();
  const repoRow = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId) as
    | DbRepoRow
    | undefined;
  if (!repoRow) throw new Error(`Repo not found: ${repoId}`);
  const existingSummary = db
    .prepare('SELECT * FROM repo_summaries WHERE repo_id = ?')
    .get(repoId) as DbSummaryRow | undefined;
  const mapRefreshMode = existingSummary?.map_refresh_mode === 'on_commit' ? 'on_commit' : 'manual';

  const sendProgress: RepoIndexProgressFn = (message, percent, stage, detail) => {
    onProgress?.(message, percent, stage, detail);
  };

  try {
    markIndexing(db, repoId);
    sendProgress('Queued for indexing...', 0, 'queued');
    const indexedCommitSha = await getCurrentCommitSha(repoRow.path);

    sendProgress('Discovering files...', 5, 'discovering');
    const analysis = await analyseRepo(repoRow.path);
    throwIfCancelled(repoId, options);
    sendProgress(
      `Discovered ${analysis.files.length} files across ${analysis.modules.length} module${analysis.modules.length === 1 ? '' : 's'}.`,
      15,
      'discovering',
    );

    db.prepare("UPDATE repos SET file_count = ?, updated_at = datetime('now') WHERE id = ?").run(
      analysis.files.length,
      repoId,
    );

    // Reconcile module rows with the structural split: drop stale paths, insert
    // placeholders for new ones, and keep existing purposes for enrichment.
    const existingModules = new Map(
      (
        db
          .prepare('SELECT * FROM module_summaries WHERE repo_id = ?')
          .all(repoId) as DbModuleSummaryRow[]
      ).map((row) => [row.path, row]),
    );
    const modulePaths = new Set(analysis.modules.map((mod) => mod.path));
    db.prepare(
      `DELETE FROM module_summaries WHERE repo_id = ? AND path NOT IN (${
        [...modulePaths].map(() => '?').join(',') || "''"
      })`,
    ).run(repoId, ...modulePaths);
    const insertModuleStub = db.prepare(
      `INSERT OR IGNORE INTO module_summaries (repo_id, path, file_count, key_files, generated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    );
    const moduleSummaries: ModuleSummary[] = analysis.modules.map((mod) => {
      insertModuleStub.run(repoId, mod.path, mod.files.length, JSON.stringify(mod.keyFiles));
      const existing = existingModules.get(mod.path);
      return {
        path: mod.path,
        purpose: existing?.purpose ?? '',
        fileCount: mod.files.length,
        keyFiles: existing ? safeParseJson(existing.key_files, mod.keyFiles) : mod.keyFiles,
        dependencies: existing ? safeParseJson(existing.dependencies, []) : [],
      };
    });

    sendProgress('Building repository map...', 40, 'saving');
    throwIfCancelled(repoId, options);
    const repositoryMapGraph = await buildRepositoryMapInWorker({
      repoId,
      repositoryName: repoRow.name,
      repoPath: repoRow.path,
      indexedCommitSha,
      files: analysis.files,
      modules: moduleSummaries,
    });

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

    sendProgress('Saving results...', 80, 'saving');
    if (existingSummary) {
      // Mapped refresh on an already-summarised repo: refresh the structural
      // fields but keep the LLM-authored overview/diagram.
      const mergedFrameworks = [
        ...new Set([...analysis.frameworks, ...safeParseJson(existingSummary.frameworks, [])]),
      ];
      db.prepare(
        `UPDATE repo_summaries SET
          frameworks = ?,
          language_breakdown = ?,
          generated_commit_sha = ?,
          generated_at = datetime('now')
         WHERE repo_id = ?`,
      ).run(
        JSON.stringify(mergedFrameworks),
        JSON.stringify(analysis.languages),
        indexedCommitSha ?? null,
        repoId,
      );
    } else {
      const fallback = buildFallbackRepoSummary(repoRow.name, analysis, moduleSummaries);
      db.prepare(
        `INSERT INTO repo_summaries (
          repo_id, overview, architecture_description, mermaid_diagram, patterns, frameworks,
          entry_points, config_files, language_breakdown, generated_at, model_version,
          index_mode, index_provider, index_warnings, map_refresh_mode, generated_commit_sha
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)`,
      ).run(
        repoId,
        fallback.overview,
        fallback.overview,
        fallback.mermaidDiagram,
        JSON.stringify(fallback.patterns),
        JSON.stringify(fallback.frameworks),
        JSON.stringify(fallback.entryPoints),
        JSON.stringify(fallback.configFiles),
        JSON.stringify(analysis.languages),
        'local-structural',
        fallback.indexMode ?? 'light',
        fallback.indexProvider ?? 'local-fallback',
        JSON.stringify(fallback.indexWarnings ?? []),
        mapRefreshMode,
        indexedCommitSha ?? null,
      );
    }

    markTierReached(db, repoId, 'mapped');
    onRepoIndexed(repoRow.remote_url).catch(() => {});
    sendProgress('Repository map ready', 100, 'complete');
  } catch (err) {
    markJobEnded(db, repoId, err instanceof RepoIndexCancelledError);
    if (!(err instanceof RepoIndexCancelledError)) {
      sendProgress('Indexing failed', 0, 'error', shortErrorMessage(err));
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// enriched tier — LLM module summaries + overview
// ---------------------------------------------------------------------------

/**
 * Content hash for one module: sorted (relativePath, size, mtime) of its files
 * plus the contents of its key files. A matching hash means the module is
 * unchanged and its LLM summary can be reused (§4.3).
 */
export function computeModuleContentHash(module: ModuleInfo, repoPath: string): string {
  const hash = createHash('sha256');
  const manifest = module.files
    .map((file) => `${file.relativePath}:${file.sizeBytes}:${Math.round(file.mtimeMs ?? 0)}`)
    .sort();
  for (const line of manifest) hash.update(line).update('\n');
  for (const keyFile of module.keyFiles.slice(0, 5)) {
    hash.update('key:').update(keyFile).update('\n');
    hash.update(readFileContent(repoPath, keyFile, 30_000));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Enrichment pass: per-module LLM summaries (incremental via content hashes,
 * smaller modules first, each written as it completes) plus an LLM overview
 * generated from module purposes only.
 */
export async function enrichRepo(
  repoId: string,
  onProgress?: RepoIndexProgressFn,
  options?: EnrichRepoOptions,
): Promise<EnrichRepoResult> {
  const db = getDb();
  const repoRow = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId) as
    | DbRepoRow
    | undefined;
  if (!repoRow) throw new Error(`Repo not found: ${repoId}`);

  const sendProgress: RepoIndexProgressFn = (message, percent, stage, detail) => {
    onProgress?.(message, percent, stage, detail);
  };
  const acquireLlmSlot = options?.acquireLlmSlot ?? defaultAcquireLlmSlot;
  const result: EnrichRepoResult = { summarised: 0, skipped: 0, failed: 0 };

  try {
    markIndexing(db, repoId);
    const indexedCommitSha = await getCurrentCommitSha(repoRow.path);

    sendProgress('Discovering files...', 5, 'discovering');
    const analysis = await analyseRepo(repoRow.path);
    throwIfCancelled(repoId, options);

    db.prepare("UPDATE repos SET file_count = ?, updated_at = datetime('now') WHERE id = ?").run(
      analysis.files.length,
      repoId,
    );

    // Drop module rows whose path no longer exists in the current split.
    const liveModulePaths = new Set(analysis.modules.map((mod) => mod.path));
    db.prepare(
      `DELETE FROM module_summaries WHERE repo_id = ? AND path NOT IN (${
        [...liveModulePaths].map(() => '?').join(',') || "''"
      })`,
    ).run(repoId, ...liveModulePaths);

    const existingModules = new Map(
      (
        db
          .prepare('SELECT * FROM module_summaries WHERE repo_id = ?')
          .all(repoId) as DbModuleSummaryRow[]
      ).map((row) => [row.path, row]),
    );

    // Smaller-first so progress moves early and the overview can start sooner.
    const sortedModules = [...analysis.modules].sort((a, b) => a.files.length - b.files.length);
    const total = sortedModules.length;
    const modulePercentSpan = total > 0 ? 75 / total : 0;
    let completedModules = 0;
    const summarisedByPath = new Map<string, ModuleSummary>();
    const warnings: string[] = [];

    const upsertModule = db.prepare(`
      INSERT OR REPLACE INTO module_summaries
        (repo_id, path, purpose, file_count, key_files, dependencies, content_hash, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    await mapWithConcurrency(sortedModules, Math.min(sortedModules.length, 8), async (mod) => {
      throwIfCancelled(repoId, options);
      const contentHash = computeModuleContentHash(mod, repoRow.path);
      const existing = existingModules.get(mod.path);

      const progressPercent = () => Math.round(15 + modulePercentSpan * completedModules);
      const message = `Analysing module: ${mod.path}`;

      // Content-hash skip: unchanged modules keep their existing summary.
      if (existing?.content_hash === contentHash && existing.purpose) {
        summarisedByPath.set(mod.path, {
          path: mod.path,
          purpose: existing.purpose,
          fileCount: mod.files.length,
          keyFiles: safeParseJson(existing.key_files, mod.keyFiles),
          dependencies: safeParseJson(existing.dependencies, []),
        });
        result.skipped += 1;
        completedModules += 1;
        sendProgress(
          `Analysed ${completedModules} of ${total} module${total === 1 ? '' : 's'}...`,
          progressPercent(),
          'analysing-module',
        );
        return;
      }

      sendProgress(message, progressPercent(), 'analysing-module');
      const keyFileContents = mod.keyFiles
        .slice(0, 5)
        .map((filePath) => {
          const content = readFileContent(repoRow.path, filePath, 30_000);
          return `### ${filePath}\n\`\`\`\n${content}\n\`\`\``;
        })
        .join('\n\n');

      try {
        const summary = await acquireLlmSlot(() =>
          summariseModule(
            repoRow.name,
            mod.path,
            mod.directoryTree,
            keyFileContents,
            repoRow.path,
            {
              onProgress: (detail) =>
                sendProgress(message, progressPercent(), 'analysing-module', detail),
            },
          ),
        );
        summary.fileCount = mod.files.length;
        // Write each module summary as it completes so RepoDetail and persona
        // context improve progressively.
        upsertModule.run(
          repoId,
          mod.path,
          summary.purpose,
          summary.fileCount,
          JSON.stringify(summary.keyFiles),
          JSON.stringify(summary.dependencies),
          contentHash,
        );
        summarisedByPath.set(mod.path, summary);
        result.summarised += 1;
      } catch (err) {
        if (err instanceof RepoIndexCancelledError) throw err;
        console.error(`[Indexer] Failed to summarise module ${mod.path}:`, err);
        sendProgress(
          `Using fallback for module ${mod.path}`,
          progressPercent(),
          'analysing-module',
          shortErrorMessage(err),
        );
        // Fallback row without a content_hash so the next run retries it.
        upsertModule.run(
          repoId,
          mod.path,
          existing?.purpose ?? 'Analysis failed',
          mod.files.length,
          JSON.stringify(mod.keyFiles),
          JSON.stringify(existing ? safeParseJson(existing.dependencies, []) : []),
          null,
        );
        summarisedByPath.set(mod.path, {
          path: mod.path,
          purpose: existing?.purpose ?? 'Analysis failed',
          fileCount: mod.files.length,
          keyFiles: mod.keyFiles,
          dependencies: existing ? safeParseJson(existing.dependencies, []) : [],
        });
        result.failed += 1;
      } finally {
        completedModules += 1;
        sendProgress(
          `Analysed ${completedModules} of ${total} module${total === 1 ? '' : 's'}...`,
          progressPercent(),
          'analysing-module',
        );
      }
    });

    throwIfCancelled(repoId, options);

    const moduleSummaries = sortedModules.map(
      (mod) =>
        summarisedByPath.get(mod.path) ?? {
          path: mod.path,
          purpose: 'No description available',
          fileCount: mod.files.length,
          keyFiles: mod.keyFiles,
          dependencies: [],
        },
    );

    const configContents = analysis.configFiles
      .slice(0, 5)
      .map((filePath) => {
        const content = readFileContent(repoRow.path, filePath, 10_000);
        return `### ${filePath}\n\`\`\`\n${content}\n\`\`\``;
      })
      .join('\n\n');

    let repoSummary: Omit<RepoSummary, 'repoId' | 'modules'>;
    sendProgress('Generating repository overview...', 92, 'generating-summary');
    try {
      // Overview prompt is built from module purposes only — the depth-1 tree
      // keeps a little shape context without the largest prompt input.
      repoSummary = await acquireLlmSlot(() =>
        summariseRepo(
          moduleSummaries,
          buildDirectoryTree(analysis.files, 1),
          configContents,
          repoRow.path,
          {
            onProgress: (detail) =>
              sendProgress('Generating repository overview...', 92, 'generating-summary', detail),
          },
        ),
      );
      repoSummary = {
        ...repoSummary,
        indexMode: 'light',
        indexProvider: 'local-llm',
        indexWarnings: warnings,
      };
    } catch (err) {
      if (err instanceof RepoIndexCancelledError) throw err;
      console.error('[Indexer] Failed to generate repo summary, using fallback:', err);
      sendProgress(
        'Summary generation failed, building a fallback overview...',
        94,
        'generating-summary',
        shortErrorMessage(err),
      );
      repoSummary = {
        ...buildFallbackRepoSummary(repoRow.name, analysis, moduleSummaries),
        indexWarnings: [shortErrorMessage(err)],
      };
    }

    sendProgress('Saving results...', 97, 'saving');

    db.prepare(
      `INSERT INTO repo_summaries (
        repo_id, overview, architecture_description, mermaid_diagram, patterns, frameworks,
        entry_points, config_files, language_breakdown, generated_at, model_version,
        index_mode, index_provider, index_warnings, generated_commit_sha
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)
      ON CONFLICT(repo_id) DO UPDATE SET
        overview = excluded.overview,
        architecture_description = excluded.architecture_description,
        mermaid_diagram = excluded.mermaid_diagram,
        patterns = excluded.patterns,
        frameworks = excluded.frameworks,
        entry_points = excluded.entry_points,
        config_files = excluded.config_files,
        language_breakdown = excluded.language_breakdown,
        generated_at = excluded.generated_at,
        model_version = excluded.model_version,
        index_mode = excluded.index_mode,
        index_provider = excluded.index_provider,
        index_warnings = excluded.index_warnings,
        generated_commit_sha = excluded.generated_commit_sha`,
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
      indexedCommitSha ?? null,
    );

    markTierReached(db, repoId, 'enriched');
    sendProgress('Indexing complete', 100, 'complete');
    notifyIfUnfocused('Indexing Complete', `${repoRow.name} has been indexed.`);
    return result;
  } catch (err) {
    markJobEnded(db, repoId, err instanceof RepoIndexCancelledError);
    if (!(err instanceof RepoIndexCancelledError)) {
      sendProgress('Indexing failed', 0, 'error', shortErrorMessage(err));
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Back-compat wrapper: full refresh = mapped then enriched.
// ---------------------------------------------------------------------------

export async function indexRepo(repoId: string, onProgress?: RepoIndexProgressFn): Promise<void> {
  await mapRepo(repoId, onProgress);
  await enrichRepo(repoId, onProgress);
}

// ---------------------------------------------------------------------------
// Local LLM semaphore — used when the queue doesn't inject a shared pool.
// ---------------------------------------------------------------------------

let fallbackLlmActive = 0;
const fallbackLlmWaiters: Array<() => void> = [];

function fallbackLlmPoolSize(): number {
  return getSettings().llmProvider === 'codex' ? 1 : 2;
}

async function defaultAcquireLlmSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (fallbackLlmActive >= fallbackLlmPoolSize()) {
    await new Promise<void>((resolve) => fallbackLlmWaiters.push(resolve));
  }
  fallbackLlmActive += 1;
  try {
    return await fn();
  } finally {
    fallbackLlmActive = Math.max(0, fallbackLlmActive - 1);
    for (const waiter of fallbackLlmWaiters.splice(0)) waiter();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 220 ? `${message.slice(0, 217)}...` : message;
}

function safeParseJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
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
