import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Database,
  FileUp,
  Loader2,
  Play,
  Trash2,
  FileCode2,
  FileJson,
  FileText,
  Sparkles,
  MessageSquare,
} from 'lucide-react';
import type {
  DbInsightAnalysis,
  DbInsightArtifact,
  DbInsightArtifactCategory,
  DbInsightFileType,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';

const FILE_TYPE_ICONS: Record<DbInsightFileType, typeof FileCode2> = {
  sql: FileCode2,
  txt: FileText,
  json: FileJson,
  other: FileText,
};

const CATEGORY_LABELS: Record<DbInsightArtifactCategory, string> = {
  schema: 'Schema',
  'stored-procedure': 'Stored Proc',
  mixed: 'Mixed',
  other: 'Other',
};

function formatTimestamp(value?: string): string {
  if (!value) return 'Not run yet';
  return new Date(value).toLocaleString();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DbInsightsView() {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace?.id;

  const [artifacts, setArtifacts] = useState<DbInsightArtifact[]>([]);
  const [analysis, setAnalysis] = useState<DbInsightAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const [nextArtifacts, nextAnalysis] = await Promise.all([
        window.anvil.dbInsights.listArtifacts(workspaceId),
        window.anvil.dbInsights.getLatestAnalysis(workspaceId),
      ]);
      setArtifacts(nextArtifacts);
      setAnalysis(nextAnalysis);
      setRunning(nextAnalysis?.status === 'running');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load DB Insights');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!workspaceId || !running) return;

    const interval = window.setInterval(() => {
      void loadData();
    }, 2500);

    return () => window.clearInterval(interval);
  }, [workspaceId, running, loadData]);

  const handleAddFiles = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      const filePaths = await window.anvil.dbInsights.selectFiles();
      if (filePaths.length === 0) return;
      await Promise.all(
        filePaths.map((filePath) => window.anvil.dbInsights.addArtifact(workspaceId, filePath)),
      );
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add DB exports');
    }
  }, [workspaceId, loadData]);

  const handleRemoveArtifact = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await window.anvil.dbInsights.removeArtifact(id);
        await loadData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to remove DB export');
      }
    },
    [loadData],
  );

  const handleAnalyze = useCallback(async () => {
    if (!workspaceId) return;
    setRunning(true);
    setError(null);
    try {
      const nextAnalysis = await window.anvil.dbInsights.analyze(workspaceId);
      setAnalysis(nextAnalysis);
      setRunning(nextAnalysis.status === 'running');
      const nextArtifacts = await window.anvil.dbInsights.listArtifacts(workspaceId);
      setArtifacts(nextArtifacts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'DB Insights analysis failed');
    } finally {
      setRunning(false);
    }
  }, [workspaceId]);

  const stats = useMemo(
    () => [
      { label: 'Tables', value: analysis?.tableCount ?? 0 },
      { label: 'Stored Procs', value: analysis?.procedureCount ?? 0 },
      { label: 'Views', value: analysis?.viewCount ?? 0 },
      { label: 'Functions', value: analysis?.functionCount ?? 0 },
    ],
    [analysis],
  );

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-secondary">Select a workspace to get started.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-bg-secondary px-4 py-3">
        <div className="flex items-center gap-3">
          <Database size={20} className="text-accent" />
          <div>
            <h2 className="text-xl font-semibold">DB Insights</h2>
            <p className="text-sm text-text-tertiary">
              Import SSMS schema and stored procedure exports, analyse them, then use the results in
              Chat with the DB Expert persona.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleAddFiles}
            className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <FileUp size={14} />
            Add Exports
          </button>
          <button
            onClick={handleAnalyze}
            disabled={running || artifacts.length === 0}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Analyse
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)]">
        <aside className="overflow-auto border-r border-border bg-bg-secondary p-4">
          <div className="rounded-xl border border-border bg-bg-primary/50 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-tertiary">
              Getting Started
            </div>
            <ol className="mt-3 space-y-2 text-sm leading-relaxed text-text-secondary">
              <li>1. Export schema and stored procedure scripts from SSMS as `.sql` files.</li>
              <li>2. Add those exports here.</li>
              <li>3. Run Analyse to build a workspace-level schema summary.</li>
              <li>4. Switch to Chat and choose the `DB Expert` persona.</li>
            </ol>
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">Imported Exports</h3>
              <span className="text-xs text-text-tertiary">{artifacts.length} file(s)</span>
            </div>

            <div className="space-y-2">
              {artifacts.map((artifact) => {
                const FileIcon = FILE_TYPE_ICONS[artifact.fileType];
                return (
                  <div
                    key={artifact.id}
                    className="rounded-xl border border-border bg-bg-elevated/60 p-3"
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 rounded-lg bg-bg-tertiary p-2 text-accent">
                        <FileIcon size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-text-primary">
                          {artifact.fileName}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
                          <span className="rounded-full bg-bg-tertiary px-2 py-0.5">
                            {CATEGORY_LABELS[artifact.category]}
                          </span>
                          <span>{artifact.fileType.toUpperCase()}</span>
                          <span>{formatFileSize(artifact.fileSize)}</span>
                        </div>
                        <div className="mt-2 truncate font-mono text-[11px] text-text-tertiary">
                          {artifact.filePath}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemoveArtifact(artifact.id)}
                        className="rounded-md p-1 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-error"
                        aria-label={`Remove ${artifact.fileName}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}

              {!loading && artifacts.length === 0 && (
                <div className="rounded-xl border border-dashed border-border p-4 text-sm text-text-tertiary">
                  No exports added yet.
                </div>
              )}

              {loading && (
                <div className="flex items-center gap-2 rounded-xl border border-border p-4 text-sm text-text-secondary">
                  <Loader2 size={16} className="animate-spin" />
                  Loading DB Insights...
                </div>
              )}
            </div>
          </div>
        </aside>

        <main className="overflow-auto p-6">
          {error && (
            <div className="mb-4 rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
              {error}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-4">
            {stats.map((stat) => (
              <div
                key={stat.label}
                className="rounded-2xl border border-border bg-bg-secondary/80 p-4"
              >
                <div className="text-xs uppercase tracking-[0.18em] text-text-tertiary">
                  {stat.label}
                </div>
                <div className="mt-2 text-3xl font-semibold text-text-primary">{stat.value}</div>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-2xl border border-border bg-bg-secondary/70 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <Sparkles size={16} className="text-accent" />
                  Latest Analysis
                </div>
                <div className="mt-1 text-sm text-text-tertiary">
                  {analysis?.databaseName
                    ? `Database: ${analysis.databaseName}`
                    : 'Database name not detected from the exports.'}
                </div>
              </div>
              <div className="text-right text-xs text-text-tertiary">
                <div>Started: {formatTimestamp(analysis?.startedAt)}</div>
                <div>Completed: {formatTimestamp(analysis?.completedAt)}</div>
              </div>
            </div>

            {running && (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-sm text-text-primary">
                <Loader2 size={16} className="animate-spin text-info" />
                Analysing exported SQL artefacts. This can take a minute.
              </div>
            )}

            {analysis ? (
              <>
                <p className="mt-4 text-sm leading-7 text-text-secondary">{analysis.summary}</p>

                <div className="mt-5 grid gap-4 xl:grid-cols-2">
                  <section className="rounded-2xl border border-border bg-bg-primary/40 p-4">
                    <h3 className="text-sm font-semibold text-text-primary">Key Tables</h3>
                    <div className="mt-3 space-y-3">
                      {analysis.tables.map((table) => (
                        <div key={table.qualifiedName} className="rounded-xl bg-bg-elevated/70 p-3">
                          <div className="font-mono text-sm text-text-primary">
                            {table.qualifiedName}
                          </div>
                          <div className="mt-1 text-xs text-text-tertiary">
                            {table.columnCount} columns
                            {table.keyColumns.length > 0
                              ? ` • Keys: ${table.keyColumns.join(', ')}`
                              : ''}
                          </div>
                          {table.notes && (
                            <div className="mt-2 text-sm text-text-secondary">{table.notes}</div>
                          )}
                        </div>
                      ))}
                      {analysis.tables.length === 0 && (
                        <div className="text-sm text-text-tertiary">No table insights yet.</div>
                      )}
                    </div>
                  </section>

                  <section className="rounded-2xl border border-border bg-bg-primary/40 p-4">
                    <h3 className="text-sm font-semibold text-text-primary">
                      Key Stored Procedures
                    </h3>
                    <div className="mt-3 space-y-3">
                      {analysis.storedProcedures.map((procedure) => (
                        <div
                          key={procedure.qualifiedName}
                          className="rounded-xl bg-bg-elevated/70 p-3"
                        >
                          <div className="font-mono text-sm text-text-primary">
                            {procedure.qualifiedName}
                          </div>
                          {procedure.purpose && (
                            <div className="mt-1 text-sm text-text-secondary">
                              {procedure.purpose}
                            </div>
                          )}
                          <div className="mt-2 text-xs text-text-tertiary">
                            {procedure.referencedObjects.length > 0
                              ? `Touches: ${procedure.referencedObjects.join(', ')}`
                              : 'No referenced objects detected from the body.'}
                          </div>
                        </div>
                      ))}
                      {analysis.storedProcedures.length === 0 && (
                        <div className="text-sm text-text-tertiary">
                          No stored procedure insights yet.
                        </div>
                      )}
                    </div>
                  </section>
                </div>

                <div className="mt-5 grid gap-4 xl:grid-cols-3">
                  <section className="rounded-2xl border border-border bg-bg-primary/40 p-4">
                    <h3 className="text-sm font-semibold text-text-primary">Relationships</h3>
                    <div className="mt-3 space-y-2 text-sm text-text-secondary">
                      {analysis.relationships.map((relationship) => (
                        <div
                          key={relationship}
                          className="rounded-lg bg-bg-elevated/70 px-3 py-2 font-mono text-xs"
                        >
                          {relationship}
                        </div>
                      ))}
                      {analysis.relationships.length === 0 && (
                        <div className="text-sm text-text-tertiary">
                          No explicit foreign-key relationships were detected.
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="rounded-2xl border border-border bg-bg-primary/40 p-4">
                    <h3 className="text-sm font-semibold text-text-primary">Risks & Watchpoints</h3>
                    <div className="mt-3 space-y-2 text-sm text-text-secondary">
                      {analysis.risks.map((risk) => (
                        <div key={risk} className="rounded-lg bg-bg-elevated/70 px-3 py-2">
                          {risk}
                        </div>
                      ))}
                      {analysis.risks.length === 0 && (
                        <div className="text-sm text-text-tertiary">
                          No notable risks were surfaced in the latest analysis.
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="rounded-2xl border border-border bg-bg-primary/40 p-4">
                    <h3 className="text-sm font-semibold text-text-primary">Try In Chat</h3>
                    <div className="mt-3 space-y-2 text-sm text-text-secondary">
                      {analysis.recommendedQuestions.map((question) => (
                        <div key={question} className="rounded-lg bg-bg-elevated/70 px-3 py-2">
                          {question}
                        </div>
                      ))}
                      {analysis.recommendedQuestions.length === 0 && (
                        <div className="text-sm text-text-tertiary">
                          Analyse the exports to generate starter questions.
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => navigate('/chat')}
                      className="mt-4 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                    >
                      <MessageSquare size={14} />
                      Open Chat
                    </button>
                  </section>
                </div>
              </>
            ) : (
              <div className="mt-4 rounded-2xl border border-dashed border-border p-8 text-center">
                <Database size={28} className="mx-auto text-text-tertiary" />
                <p className="mt-3 text-sm text-text-secondary">
                  Add exported SQL files and run Analyse to generate a schema summary for this
                  workspace.
                </p>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
