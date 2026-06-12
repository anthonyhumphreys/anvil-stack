import { useState, useCallback, useEffect, useRef } from 'react';
import { Play, ChevronDown, ChevronRight, AlertTriangle, Loader2 } from 'lucide-react';
import type { ImpactAnalysis, AffectedModule } from '../../../../shared/types';
import { useWorkspace } from '../../../contexts/WorkspaceContext';

interface Props {
  lifecycleItemId: string;
  linkedRepoIds: string[];
}

type ScopeType = 'branch_diff' | 'commit_range' | 'manual';

const SCOPE_LABELS: Record<ScopeType, string> = {
  branch_diff: 'Branch Diff',
  commit_range: 'Commit Range',
  manual: 'Manual Scope',
};

const RISK_BADGE: Record<'high' | 'medium' | 'low', string> = {
  high: 'bg-red-500/10 text-red-400',
  medium: 'bg-amber-500/10 text-amber-400',
  low: 'bg-emerald-500/10 text-emerald-400',
};

const IMPACT_BADGE: Record<'high' | 'medium' | 'low', string> = {
  high: 'bg-red-500/10 text-red-400',
  medium: 'bg-amber-500/10 text-amber-400',
  low: 'bg-emerald-500/10 text-emerald-400',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function AffectedModuleRow({ mod }: { mod: AffectedModule }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = mod.affectedFiles.length > 0 || mod.downstreamDependents.length > 0;

  return (
    <div className="rounded-lg border border-border">
      <button
        onClick={() => hasDetails && setExpanded((p) => !p)}
        className={`flex w-full items-start gap-3 px-4 py-3 text-left ${hasDetails ? 'cursor-pointer hover:bg-bg-tertiary' : 'cursor-default'}`}
      >
        {hasDetails ? (
          expanded ? (
            <ChevronDown size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
          ) : (
            <ChevronRight size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
          )
        ) : (
          <span className="mt-0.5 w-[14px] shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{mod.modulePath}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${IMPACT_BADGE[mod.impactLevel]}`}
            >
              {mod.impactLevel}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-text-secondary">{mod.impactDescription}</p>
        </div>
      </button>
      {expanded && hasDetails && (
        <div className="border-t border-border px-4 pb-3 pt-2 space-y-3">
          {mod.affectedFiles.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                Affected Files
              </div>
              <ul className="space-y-0.5">
                {mod.affectedFiles.map((f) => (
                  <li key={f} className="text-xs text-text-secondary font-mono">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {mod.downstreamDependents.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                Downstream Dependents
              </div>
              <ul className="space-y-0.5">
                {mod.downstreamDependents.map((d) => (
                  <li key={d} className="text-xs text-text-secondary font-mono">
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AnalysisDetail({ analysis }: { analysis: ImpactAnalysis }) {
  const [appendixExpanded, setAppendixExpanded] = useState(false);

  return (
    <div className="space-y-4">
      {/* Risk badge + timestamp */}
      <div className="flex flex-wrap items-center gap-3">
        {analysis.riskRating && (
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider ${RISK_BADGE[analysis.riskRating]}`}
          >
            {analysis.riskRating} Risk
          </span>
        )}
        <span className="text-xs text-text-tertiary">
          {SCOPE_LABELS[analysis.scopeType as ScopeType] ?? analysis.scopeType}
          {analysis.completedAt && ` · ${formatDate(analysis.completedAt)}`}
        </span>
      </div>

      {/* Executive summary */}
      {analysis.executiveSummary && (
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
            Executive Summary
          </div>
          <p className="text-sm text-text-primary leading-relaxed">{analysis.executiveSummary}</p>
        </div>
      )}

      {/* Affected modules */}
      {analysis.affectedModules.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
            Affected Modules ({analysis.affectedModules.length})
          </div>
          <div className="space-y-2">
            {analysis.affectedModules.map((mod) => (
              <AffectedModuleRow key={mod.modulePath} mod={mod} />
            ))}
          </div>
        </div>
      )}

      {/* Technology changes */}
      {analysis.technologyChanges.length > 0 && (
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
            Technology Changes
          </div>
          <ul className="space-y-1">
            {analysis.technologyChanges.map((t, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-text-primary">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-text-tertiary" />
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Cross-cutting concerns */}
      {analysis.crossCuttingConcerns.length > 0 && (
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
            Cross-Cutting Concerns
          </div>
          <ul className="space-y-1">
            {analysis.crossCuttingConcerns.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-text-primary">
                <AlertTriangle size={12} className="mt-1 shrink-0 text-amber-400" />
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Technical appendix (collapsible) */}
      {analysis.technicalAppendix && (
        <div className="rounded-lg border border-border">
          <button
            onClick={() => setAppendixExpanded((p) => !p)}
            className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-bg-tertiary"
          >
            {appendixExpanded ? (
              <ChevronDown size={14} className="shrink-0 text-text-tertiary" />
            ) : (
              <ChevronRight size={14} className="shrink-0 text-text-tertiary" />
            )}
            <span className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
              Technical Appendix
            </span>
          </button>
          {appendixExpanded && (
            <div className="border-t border-border px-4 pb-4 pt-3">
              <pre className="whitespace-pre-wrap text-xs text-text-secondary font-mono leading-relaxed">
                {analysis.technicalAppendix}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ImpactAnalysisPanel({ lifecycleItemId, linkedRepoIds }: Props) {
  const { activeWorkspace } = useWorkspace();

  // ----- Scope form state -----
  const [scopeType, setScopeType] = useState<ScopeType>('branch_diff');
  const [selectedRepoId, setSelectedRepoId] = useState<string>(linkedRepoIds[0] ?? '');
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [baseBranch, setBaseBranch] = useState('');
  const [compareBranch, setCompareBranch] = useState('');
  const [fromSha, setFromSha] = useState('');
  const [toSha, setToSha] = useState('');
  const [manualModules, setManualModules] = useState('');

  // ----- Run state -----
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ message: string; percent: number } | null>(null);

  // ----- Analyses state -----
  const [analyses, setAnalyses] = useState<ImpactAnalysis[]>([]);
  const [selectedAnalysis, setSelectedAnalysis] = useState<ImpactAnalysis | null>(null);
  const [loadingAnalyses, setLoadingAnalyses] = useState(false);

  const unsubRef = useRef<(() => void) | null>(null);

  // Derived: linked repos with names from workspace
  const linkedRepos = (activeWorkspace?.repos ?? []).filter((r) => linkedRepoIds.includes(r.id));

  // ---- Fetch analyses ----
  const fetchAnalyses = useCallback(async () => {
    setLoadingAnalyses(true);
    try {
      const list = await window.anvil.lifecycle.listImpactAnalyses(lifecycleItemId);
      // Sort newest first
      const sorted = [...list].sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );
      setAnalyses(sorted);
      setRunning(sorted.some((analysis) => analysis.status === 'running'));
      setSelectedAnalysis((current) => {
        if (current) {
          return sorted.find((analysis) => analysis.id === current.id) ?? sorted[0] ?? null;
        }
        return sorted[0] ?? null;
      });
    } catch (err) {
      console.error('Failed to fetch impact analyses:', err);
    } finally {
      setLoadingAnalyses(false);
    }
  }, [lifecycleItemId]);

  // ---- Fetch branches when repo changes ----
  useEffect(() => {
    if (!selectedRepoId || scopeType === 'manual') return;
    setBranchesLoading(true);
    setBranches([]);
    setBaseBranch('');
    setCompareBranch('');
    window.anvil.git
      .branches(selectedRepoId)
      .then((branchInfos) => {
        const names = branchInfos.map((b) => b.name);
        setBranches(names);
        if (names.length > 0) setBaseBranch(names[0]);
        if (names.length > 1) setCompareBranch(names[1]);
      })
      .catch((err) => console.error('Failed to fetch branches:', err))
      .finally(() => setBranchesLoading(false));
  }, [selectedRepoId, scopeType]);

  // ---- Subscribe to analysis progress ----
  useEffect(() => {
    const unsub = window.anvil.lifecycle.onAnalysisProgress((data) => {
      if (data.lifecycleItemId !== lifecycleItemId) return;
      setProgress({ message: data.message, percent: data.percent });
      if (data.percent >= 100) {
        // Give a moment for completion, then refetch
        setTimeout(() => {
          setRunning(false);
          setProgress(null);
          fetchAnalyses();
        }, 500);
      }
    });
    unsubRef.current = unsub;
    return () => {
      unsub();
      unsubRef.current = null;
    };
  }, [lifecycleItemId, fetchAnalyses]);

  // ---- Initial load ----
  useEffect(() => {
    fetchAnalyses();
  }, [fetchAnalyses]);

  useEffect(() => {
    if (!running) return;

    const interval = window.setInterval(() => {
      void fetchAnalyses();
    }, 2500);

    return () => window.clearInterval(interval);
  }, [running, fetchAnalyses]);

  // ---- Run analysis ----
  const handleRunAnalysis = useCallback(async () => {
    let scopeRef: string | undefined;

    if (scopeType === 'branch_diff') {
      scopeRef = JSON.stringify({ baseBranch, compareBranch, repoId: selectedRepoId });
    } else if (scopeType === 'commit_range') {
      scopeRef = JSON.stringify({ fromSha, toSha, repoId: selectedRepoId });
    } else {
      // manual
      const paths = manualModules
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      scopeRef = JSON.stringify({ modulePaths: paths, repoId: selectedRepoId });
    }

    setRunning(true);
    setProgress({ message: 'Starting analysis…', percent: 0 });

    try {
      await window.anvil.lifecycle.runImpactAnalysis(lifecycleItemId, {
        scopeType,
        scopeRef,
      });
      // Progress subscription handles the refetch; also refetch here as fallback
      await fetchAnalyses();
    } catch (err) {
      console.error('Impact analysis failed:', err);
      setProgress({ message: 'Analysis failed', percent: 0 });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [
    lifecycleItemId,
    scopeType,
    selectedRepoId,
    baseBranch,
    compareBranch,
    fromSha,
    toSha,
    manualModules,
    fetchAnalyses,
  ]);

  return (
    <div className="space-y-4 pt-2">
      {/* ---- Run Analysis Form ---- */}
      <div className="rounded-lg border border-border px-4 py-3 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
          Run New Analysis
        </div>

        {/* Scope type selector */}
        <div className="flex items-center gap-3">
          <label className="text-xs text-text-secondary shrink-0">Scope</label>
          <select
            value={scopeType}
            onChange={(e) => setScopeType(e.target.value as ScopeType)}
            disabled={running}
            className="rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent/50 focus:outline-none disabled:opacity-50"
          >
            {(Object.entries(SCOPE_LABELS) as [ScopeType, string][]).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>

        {/* Repo selector (branch diff + commit range) */}
        {scopeType !== 'manual' && linkedRepos.length > 0 && (
          <div className="flex items-center gap-3">
            <label className="text-xs text-text-secondary shrink-0">Repo</label>
            <select
              value={selectedRepoId}
              onChange={(e) => setSelectedRepoId(e.target.value)}
              disabled={running}
              className="rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent/50 focus:outline-none disabled:opacity-50"
            >
              {linkedRepos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Branch Diff inputs */}
        {scopeType === 'branch_diff' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Base branch</label>
              {branchesLoading ? (
                <div className="flex items-center gap-2 text-xs text-text-tertiary">
                  <Loader2 size={12} className="animate-spin" /> Loading…
                </div>
              ) : (
                <select
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  disabled={running || branches.length === 0}
                  className="rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent/50 focus:outline-none disabled:opacity-50"
                >
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Compare branch</label>
              {branchesLoading ? (
                <div className="flex items-center gap-2 text-xs text-text-tertiary">
                  <Loader2 size={12} className="animate-spin" /> Loading…
                </div>
              ) : (
                <select
                  value={compareBranch}
                  onChange={(e) => setCompareBranch(e.target.value)}
                  disabled={running || branches.length === 0}
                  className="rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent/50 focus:outline-none disabled:opacity-50"
                >
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        )}

        {/* Commit Range inputs */}
        {scopeType === 'commit_range' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">From SHA</label>
              <input
                type="text"
                value={fromSha}
                onChange={(e) => setFromSha(e.target.value)}
                placeholder="e.g. abc1234"
                disabled={running}
                className="rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent/50 focus:outline-none disabled:opacity-50"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">To SHA</label>
              <input
                type="text"
                value={toSha}
                onChange={(e) => setToSha(e.target.value)}
                placeholder="e.g. def5678"
                disabled={running}
                className="rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent/50 focus:outline-none disabled:opacity-50"
              />
            </div>
          </div>
        )}

        {/* Manual Scope inputs */}
        {scopeType === 'manual' && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">
              Module paths <span className="text-text-tertiary">(comma-separated)</span>
            </label>
            <textarea
              value={manualModules}
              onChange={(e) => setManualModules(e.target.value)}
              placeholder="e.g. src/auth, src/payments/processor"
              rows={3}
              disabled={running}
              className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent/50 focus:outline-none disabled:opacity-50 resize-none"
            />
          </div>
        )}

        {/* Progress bar */}
        {running && progress && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-text-secondary">
              <span className="flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" />
                {progress.message}
              </span>
              <span>{progress.percent}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300"
                style={{ width: `${Math.min(progress.percent, 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Run button */}
        <button
          onClick={handleRunAnalysis}
          disabled={running}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {running ? 'Running…' : 'Run Analysis'}
        </button>
      </div>

      {/* ---- Latest / Selected Analysis ---- */}
      {loadingAnalyses ? (
        <div className="flex h-24 items-center justify-center">
          <Loader2 size={20} className="animate-spin text-accent" />
        </div>
      ) : selectedAnalysis ? (
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
            Analysis Result
          </div>
          {selectedAnalysis.status === 'running' ? (
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <Loader2 size={14} className="animate-spin" /> Analysis in progress…
            </div>
          ) : selectedAnalysis.status === 'failed' ? (
            <div className="flex items-center gap-2 text-sm text-red-400">
              <AlertTriangle size={14} /> Analysis failed
            </div>
          ) : (
            <AnalysisDetail analysis={selectedAnalysis} />
          )}
        </div>
      ) : !loadingAnalyses && analyses.length === 0 ? (
        <p className="text-sm text-text-tertiary">No analyses yet. Run one above to get started.</p>
      ) : null}

      {/* ---- Previous Analyses ---- */}
      {analyses.length > 1 && (
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
            Previous Analyses
          </div>
          <div className="space-y-2">
            {analyses.map((a) => (
              <button
                key={a.id}
                onClick={() => setSelectedAnalysis(a)}
                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary ${
                  selectedAnalysis?.id === a.id ? 'border-accent/50 bg-accent/5' : 'border-border'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-text-primary truncate">
                    {SCOPE_LABELS[a.scopeType as ScopeType] ?? a.scopeType}
                  </span>
                  {a.riskRating && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize shrink-0 ${RISK_BADGE[a.riskRating]}`}
                    >
                      {a.riskRating}
                    </span>
                  )}
                </div>
                <span className="text-xs text-text-tertiary shrink-0 ml-2">
                  {formatDate(a.startedAt)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
