import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Check,
  X,
  AlertTriangle,
  ExternalLink,
  FileText,
  FolderGit2,
  Package,
  Play,
  Loader2,
  ShieldAlert,
  Terminal,
} from 'lucide-react';
import type { OnboardDetection, EnvironmentCheck } from '../../../shared/types';
import { useBrand } from '../../contexts/BrandContext';

interface EnvironmentStepProps {
  detection: OnboardDetection;
  onNext: () => void;
}

export function EnvironmentStep({ detection, onNext }: EnvironmentStepProps) {
  const brand = useBrand();
  const passedCount = detection.environmentStatus.filter((c) => c.installed).length;
  const totalCount = detection.environmentStatus.length;
  const allPassed = passedCount === totalCount;

  const missingDeps = detection.environmentStatus.filter((c) => !c.installed && c.installCommand);

  const [accepted, setAccepted] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [installLog]);

  // Listen for install output
  useEffect(() => {
    const unsub = window.anvil.onboard.onInstallOutput((line) => {
      setInstallLog((prev) => [...prev, line]);
    });
    return unsub;
  }, []);

  const handleInstall = useCallback(async (check: EnvironmentCheck) => {
    if (!check.installCommand) return;
    setInstalling(check.name);
    setInstallLog([]);
    const result = await window.anvil.onboard.installDep(check.installCommand);
    if (result.success) {
      setInstalled((prev) => new Set(prev).add(check.name));
    } else {
      setFailed((prev) => new Set(prev).add(check.name));
    }
    setInstalling(null);
  }, []);

  const handleInstallAll = useCallback(async () => {
    for (const dep of missingDeps) {
      if (installed.has(dep.name)) continue;
      await handleInstall(dep);
    }
  }, [missingDeps, installed, handleInstall]);

  return (
    <div className="flex gap-6">
      {/* Main content */}
      <div className="flex-1 space-y-4">
        <h3 className="text-base font-semibold text-text-primary">Environment & Artifact Check</h3>

        {/* Artifact status */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
            Repository Artifacts
          </h4>

          <ArtifactRow
            icon={<FileText size={14} />}
            name="AGENTS.md"
            status={
              detection.agentsMdExists
                ? detection.agentsMdStaleness === 'stale'
                  ? 'stale'
                  : 'present'
                : 'missing'
            }
          />
          <ArtifactRow
            icon={<FolderGit2 size={14} />}
            name=".devcontainer/devcontainer.json"
            status={detection.devcontainerExists ? 'present' : 'missing'}
          />
          <ArtifactRow
            icon={<Package size={14} />}
            name="README.md"
            status={detection.readmeExists ? 'present' : 'missing'}
          />
        </div>

        {/* Environment tools */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
            Development Tools
          </h4>

          {detection.environmentStatus.map((check) => {
            const justInstalled = installed.has(check.name);
            const justFailed = failed.has(check.name);
            const isInstalling = installing === check.name;

            return (
              <div
                key={check.name}
                className="flex items-center gap-3 rounded-md border border-border-subtle bg-bg-tertiary px-3 py-2"
              >
                {check.installed || justInstalled ? (
                  <Check size={14} className="shrink-0 text-success" />
                ) : justFailed ? (
                  <X size={14} className="shrink-0 text-error" />
                ) : check.required ? (
                  <X size={14} className="shrink-0 text-error" />
                ) : (
                  <AlertTriangle size={14} className="shrink-0 text-warning" />
                )}

                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-text-primary">{check.name}</span>
                    {check.required && (
                      <span className="text-xs uppercase text-text-secondary">required</span>
                    )}
                    {justInstalled && <span className="text-xs text-success">installed</span>}
                  </div>
                  {(check.installed || justInstalled) && check.version && (
                    <span className="text-xs text-text-tertiary">v{check.version}</span>
                  )}
                  {!check.installed && !justInstalled && check.installCommand && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-info">
                      <ExternalLink size={10} />
                      <span className="font-mono">{check.installCommand}</span>
                    </div>
                  )}
                </div>

                {/* Per-item install button */}
                {!check.installed && !justInstalled && check.installCommand && accepted && (
                  <button
                    onClick={() => handleInstall(check)}
                    disabled={!!installing}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
                  >
                    {isInstalling ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Play size={12} />
                    )}
                    Install
                  </button>
                )}
              </div>
            );
          })}

          {detection.environmentStatus.length === 0 && (
            <p className="text-sm text-text-tertiary">No framework-specific tools detected.</p>
          )}
        </div>

        {/* Install missing deps section */}
        {missingDeps.length > 0 && (
          <div className="space-y-3">
            {!accepted ? (
              <div className="rounded-md border border-warning/30 bg-warning/5 p-4">
                <div className="flex items-start gap-2">
                  <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warning" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">
                      Install missing dependencies?
                    </p>
                    <p className="mt-1 text-xs text-text-secondary">
                      This will run shell commands on your machine to install the missing tools
                      listed above. Commands are run with your current user permissions. Review the
                      install commands shown above before proceeding. {brand.appName} is not
                      responsible for any side effects of running these commands.
                    </p>
                    <button
                      onClick={() => setAccepted(true)}
                      className="mt-3 flex items-center gap-2 rounded-md bg-warning/20 px-3 py-1.5 text-sm font-medium text-warning transition-colors hover:bg-warning/30"
                    >
                      <Terminal size={14} />I understand, enable install
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <button
                onClick={handleInstallAll}
                disabled={!!installing || missingDeps.every((d) => installed.has(d.name))}
                className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
              >
                {installing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {missingDeps.every((d) => installed.has(d.name))
                  ? 'All installed'
                  : installing
                    ? `Installing ${installing}...`
                    : 'Install all missing'}
              </button>
            )}

            {/* Streaming output log */}
            {installLog.length > 0 && (
              <div
                ref={logRef}
                className="h-48 overflow-auto rounded-md border border-border bg-bg-primary p-3 font-mono text-xs text-text-secondary"
              >
                {installLog.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap">
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          onClick={onNext}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
        >
          {allPassed ? 'Continue' : 'Continue Anyway'}
        </button>
      </div>

      {/* Summary sidebar */}
      <div className="w-56 shrink-0 space-y-3">
        <div className="rounded-md border border-border bg-bg-tertiary p-3">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
            Quick Summary
          </h4>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-text-secondary">Tools</span>
              <span className={passedCount === totalCount ? 'text-success' : 'text-warning'}>
                {passedCount + installed.size}/{totalCount} passed
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">Actions</span>
              <span className="text-text-primary">
                {detection.suggestedActions.length} suggested
              </span>
            </div>
          </div>
        </div>

        {detection.suggestedActions.length > 0 && (
          <div className="rounded-md border border-border bg-bg-tertiary p-3">
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
              Suggested Actions
            </h4>
            <ul className="space-y-1">
              {detection.suggestedActions.map((action) => (
                <li key={action} className="text-xs text-text-secondary">
                  {formatAction(action)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactRow({
  icon,
  name,
  status,
}: {
  icon: React.ReactNode;
  name: string;
  status: 'present' | 'stale' | 'missing';
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border-subtle bg-bg-tertiary px-3 py-2">
      {status === 'present' ? (
        <Check size={14} className="shrink-0 text-success" />
      ) : status === 'stale' ? (
        <AlertTriangle size={14} className="shrink-0 text-warning" />
      ) : (
        <X size={14} className="shrink-0 text-error" />
      )}
      <span className="text-text-secondary">{icon}</span>
      <span className="text-sm text-text-primary">{name}</span>
      <span
        className={`ml-auto text-xs ${
          status === 'present' ? 'text-success' : status === 'stale' ? 'text-warning' : 'text-error'
        }`}
      >
        {status === 'present' ? 'Found' : status === 'stale' ? 'Stale' : 'Missing'}
      </span>
    </div>
  );
}

function formatAction(action: string): string {
  const labels: Record<string, string> = {
    'generate-agents-md': 'Generate AGENTS.md',
    'update-agents-md': 'Update AGENTS.md (stale)',
    'generate-devcontainer': 'Generate devcontainer',
    'update-devcontainer': 'Update devcontainer',
    'install-dependencies': 'Install missing tools',
    'generate-env-template': 'Generate .env template',
    'generate-readme': 'Generate README',
  };
  return labels[action] ?? action;
}
