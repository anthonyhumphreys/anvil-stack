import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  Shield,
  Play,
  Loader2,
  Search,
  FileCode2,
  Merge,
  FileText,
  CheckCircle2,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { SecurityAudit } from '../../../shared/types';
import { SecurityAuditReport } from './SecurityAuditReport';
import { RepoSelector } from '../shared/RepoSelector';
import { SecurityTabs } from './SecurityTabs';

const auditSteps = [
  { key: 'scope', label: 'Detecting scope', icon: Search, threshold: 5 },
  { key: 'analyze', label: 'Analyzing modules', icon: FileCode2, threshold: 15 },
  { key: 'dedup', label: 'Deduplicating findings', icon: Merge, threshold: 90 },
  { key: 'summary', label: 'Generating summary', icon: FileText, threshold: 95 },
  { key: 'complete', label: 'Complete', icon: CheckCircle2, threshold: 100 },
];

function SecurityAuditProgress({ message, percent }: { message: string; percent: number }) {
  const activeIdx = auditSteps.findIndex((s) => percent < s.threshold);
  const currentStep = activeIdx === -1 ? auditSteps.length - 1 : Math.max(0, activeIdx - 1);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-full max-w-md px-6">
        {/* Animated shield */}
        <div className="mb-8 flex justify-center">
          <div className="relative">
            <div className="absolute inset-0 animate-ping rounded-full bg-accent opacity-10" />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full border border-border-subtle bg-bg-secondary">
              <Shield size={36} className="text-accent" />
            </div>
          </div>
        </div>

        {/* Current message */}
        <p className="mb-6 text-center text-base font-medium text-text-primary">
          {message || 'Starting audit...'}
        </p>

        {/* Progress bar */}
        <div className="mb-8 h-2 overflow-hidden rounded-full bg-bg-tertiary">
          <div
            className="h-full rounded-full bg-gradient-to-r from-accent to-warning transition-all duration-500 ease-out"
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        </div>

        {/* Step indicators */}
        <div className="space-y-2">
          {auditSteps.slice(0, -1).map((step, i) => {
            const Icon = step.icon;
            const isDone = i < currentStep;
            const isActive = i === currentStep;

            return (
              <div
                key={step.key}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-all duration-300 ${
                  isActive
                    ? 'bg-accent/10 font-medium text-text-primary'
                    : isDone
                      ? 'text-success'
                      : 'text-text-secondary'
                }`}
              >
                <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                  {isDone ? (
                    <CheckCircle2 size={16} />
                  ) : isActive ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Icon size={16} />
                  )}
                </div>
                <span>{step.label}</span>
                {isActive && (
                  <span className="ml-auto text-xs tabular-nums text-text-secondary">
                    {percent}%
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function SecurityView() {
  const { repoId } = useParams<{ repoId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // State for audit list
  const [audits, setAudits] = useState<SecurityAudit[]>([]);
  const [selectedAudit, setSelectedAudit] = useState<SecurityAudit | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ message: '', percent: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAudits([]);
    setSelectedAudit(null);
    setRunning(false);
    setProgress({ message: '', percent: 0 });
    setError(null);
  }, [repoId]);

  const syncAuditState = useCallback(
    async (preferredAuditId?: string | null) => {
      if (!repoId) return;

      const [nextAudits, runningAudit] = await Promise.all([
        window.anvil.security.listAudits(repoId),
        window.anvil.security.getRunningAudit(repoId),
      ]);

      setAudits(nextAudits);
      setRunning(Boolean(runningAudit));
      setSelectedAudit((current) => {
        const targetId =
          preferredAuditId ?? current?.id ?? runningAudit?.id ?? nextAudits[0]?.id ?? null;
        if (!targetId) return null;
        return nextAudits.find((audit) => audit.id === targetId) ?? nextAudits[0] ?? null;
      });

      if (runningAudit) {
        setProgress((current) =>
          current.percent > 0
            ? current
            : { message: 'Audit in progress (reconnected)...', percent: 5 },
        );
      } else {
        setProgress((current) =>
          current.message || current.percent > 0 ? { message: '', percent: 0 } : current,
        );
      }
    },
    [repoId],
  );

  useEffect(() => {
    if (!repoId) return;
    void syncAuditState();
  }, [repoId, syncAuditState]);

  // Poll for completion when reconnected to a running audit
  useEffect(() => {
    if (!repoId || !running) return;

    const interval = window.setInterval(() => {
      void syncAuditState();
    }, 2500);

    return () => window.clearInterval(interval);
  }, [repoId, running, syncAuditState]);

  // Auto-select audit from query param
  useEffect(() => {
    const auditId = searchParams.get('auditId');
    if (auditId && audits.length > 0) {
      const found = audits.find((a) => a.id === auditId);
      if (found) setSelectedAudit(found);
    }
  }, [searchParams, audits]);

  // Listen for progress events
  useEffect(() => {
    if (!repoId) return;
    const unsub = window.anvil.security.onAuditProgress((data) => {
      if (data.repoId !== repoId) return;
      setProgress({ message: data.message, percent: data.percent });
      setRunning(data.percent > 0 && data.percent < 100);

      // Audit completed or failed — refresh the list and clear running state
      if (data.percent >= 100 || data.percent === 0) {
        void syncAuditState();
      }
    });
    return unsub;
  }, [repoId, syncAuditState]);

  const handleRunAudit = useCallback(async () => {
    if (!repoId) return;
    setRunning(true);
    setError(null);
    setProgress({ message: 'Starting audit...', percent: 0 });
    try {
      const audit = await window.anvil.security.runAudit(repoId);
      if (audit) {
        setSelectedAudit(audit);
        setAudits((prev) => [audit, ...prev.filter((existing) => existing.id !== audit.id)]);
        await syncAuditState(audit.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audit failed');
      setRunning(false);
      setProgress({ message: '', percent: 0 });
      await syncAuditState();
    }
  }, [repoId, syncAuditState]);

  // Repo selection view
  if (!repoId) {
    return (
      <div className="flex h-full flex-1 flex-col">
        <SecurityTabs />
        <div className="flex-1 overflow-auto p-6">
          <div className="mb-6">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
              <Shield size={20} className="text-error" />
              Security Audit
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Select an indexed repository to audit
            </p>
          </div>
          <RepoSelector
            selectedRepoId={null}
            onSelect={(repo) => navigate(`/security/${repo.id}`)}
          />
        </div>
      </div>
    );
  }

  // Audit view for specific repo
  return (
    <div className="flex h-full flex-1 flex-col">
      <SecurityTabs />
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar: audit list */}
        <div className="flex w-[260px] shrink-0 flex-col border-r border-border-subtle bg-bg-secondary">
          <div className="border-b border-border-subtle p-4">
            <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
              <Shield size={16} className="text-error" />
              Security Audits
            </h2>
            <button
              onClick={handleRunAudit}
              disabled={running}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              aria-label={running ? 'Audit running' : 'Run new security audit'}
            >
              {running ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <Play size={14} />
                  Run New Audit
                </>
              )}
            </button>
          </div>

          {/* Progress bar during audit — click to focus */}
          {running && (
            <button
              onClick={() => setSelectedAudit(null)}
              className={`w-full border-b border-border-subtle p-3 text-left transition-colors hover:bg-bg-tertiary ${
                !selectedAudit ? 'bg-accent/20' : ''
              }`}
            >
              <p className="mb-1.5 text-sm text-text-secondary">{progress.message}</p>
              <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-300"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            </button>
          )}

          {/* Audit history list */}
          <div className="flex-1 overflow-auto p-2">
            {audits.map((audit) => (
              <button
                key={audit.id}
                onClick={() => setSelectedAudit(audit)}
                className={`mb-1 flex w-full flex-col rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  selectedAudit?.id === audit.id
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:bg-bg-tertiary'
                }`}
              >
                <span className="font-medium">
                  {new Date(audit.startedAt).toLocaleDateString()}{' '}
                  {new Date(audit.startedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span
                  className={`mt-0.5 text-xs ${audit.status === 'failed' ? 'text-error' : selectedAudit?.id === audit.id ? 'text-white/70' : 'text-text-secondary'}`}
                >
                  {audit.status === 'completed'
                    ? audit.scope.join(', ')
                    : audit.status === 'failed'
                      ? 'Failed'
                      : audit.status === 'running'
                        ? 'In progress...'
                        : audit.status}
                </span>
              </button>
            ))}
            {audits.length === 0 && !running && (
              <p className="p-3 text-center text-sm text-text-secondary">
                No audits yet. Run your first audit.
              </p>
            )}
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 overflow-auto">
          {error && (
            <div className="m-4 rounded-md border border-error bg-error/10 p-3 text-sm text-error">
              {error}
            </div>
          )}
          {selectedAudit ? (
            <SecurityAuditReport audit={selectedAudit} />
          ) : running ? (
            <SecurityAuditProgress message={progress.message} percent={progress.percent} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <Shield size={48} className="mx-auto mb-3 text-text-tertiary opacity-30" />
                <p className="text-sm text-text-secondary">Select an audit or run a new one</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
