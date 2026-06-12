import { useCallback, useEffect, useState } from 'react';
import { Compass, ChevronRight, Check, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import type { OnboardDetection, RepoInfo } from '../../../shared/types';
import { EnvironmentStep } from './EnvironmentStep';
import { AgentsMdStep } from './AgentsMdStep';
import { DevcontainerStep } from './DevcontainerStep';
import { ConnectorsStep } from './ConnectorsStep';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { RepoSelector } from '../shared/RepoSelector';

type WizardStep =
  | 'select'
  | 'detect'
  | 'environment'
  | 'agents-md'
  | 'devcontainer'
  | 'connectors'
  | 'done';

const STEP_LABELS: Record<WizardStep, string> = {
  select: 'Select Repo',
  detect: 'Detect State',
  environment: 'Environment',
  'agents-md': 'AGENTS.md',
  devcontainer: 'Devcontainer',
  connectors: 'Connectors',
  done: 'Complete',
};

function loadSessionState() {
  try {
    const raw = sessionStorage.getItem('onboard-state');
    if (raw)
      return JSON.parse(raw) as { step: WizardStep; repoId: string; detection: OnboardDetection };
  } catch {
    /* ignore */
  }
  return null;
}

export function OnboardView() {
  const saved = loadSessionState();
  const { repos: workspaceRepos } = useWorkspace();

  const [selectedRepo, setSelectedRepo] = useState<RepoInfo | null>(null);
  const [detection, setDetection] = useState<OnboardDetection | null>(saved?.detection ?? null);
  const [currentStep, setCurrentStep] = useState<WizardStep>(saved?.step ?? 'select');
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Persist wizard state to sessionStorage
  useEffect(() => {
    if (selectedRepo && currentStep !== 'select') {
      sessionStorage.setItem(
        'onboard-state',
        JSON.stringify({
          step: currentStep,
          repoId: selectedRepo.id,
          detection,
        }),
      );
    }
  }, [currentStep, selectedRepo, detection]);

  // Restore selected repo from session or auto-select first indexed
  useEffect(() => {
    const restoredId = saved?.repoId;
    const match = restoredId ? workspaceRepos.find((repo) => repo.id === restoredId) : null;
    if (match) {
      setSelectedRepo(match);
    } else {
      const indexed = workspaceRepos.find((repo) => repo.status === 'indexed');
      if (indexed) setSelectedRepo(indexed);
    }
  }, [workspaceRepos]);

  const handleDetect = useCallback(async () => {
    if (!selectedRepo) return;
    setDetecting(true);
    setError(null);
    try {
      const result = await window.anvil.onboard.detect(selectedRepo.id);
      setDetection(result);
      setCurrentStep('environment');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Detection failed');
    } finally {
      setDetecting(false);
    }
  }, [selectedRepo]);

  const handleRestart = useCallback(() => {
    sessionStorage.removeItem('onboard-state');
    setDetection(null);
    setCurrentStep('select');
    setError(null);
  }, []);

  // Determine which steps are relevant based on detection
  const visibleSteps: WizardStep[] = ['select', 'detect'];
  if (detection) {
    visibleSteps.push('environment');
    if (
      detection.suggestedActions.some(
        (a) => a === 'generate-agents-md' || a === 'update-agents-md',
      ) ||
      detection.agentsMdExists
    ) {
      visibleSteps.push('agents-md');
    }
    if (
      detection.suggestedActions.includes('generate-devcontainer') ||
      detection.devcontainerExists
    ) {
      visibleSteps.push('devcontainer');
    }
    visibleSteps.push('connectors');
    visibleSteps.push('done');
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-bg-secondary px-4 py-2">
        <div className="flex items-center gap-3">
          <Compass size={20} className="text-accent" />
          <h2 className="text-xl font-semibold">Onboarding</h2>
          {selectedRepo && (
            <span className="rounded bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">
              {selectedRepo.name}
            </span>
          )}
        </div>
        {detection && (
          <button
            onClick={handleRestart}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm text-text-secondary hover:text-text-primary"
          >
            <RefreshCw size={12} />
            Restart
          </button>
        )}
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-1 border-b border-border bg-bg-secondary px-4 py-2">
        {visibleSteps.map((step, i) => {
          const stepIndex = visibleSteps.indexOf(step);
          const currentIndex = visibleSteps.indexOf(currentStep);
          const isDone = stepIndex < currentIndex;
          const isCurrent = step === currentStep;

          return (
            <div key={step} className="flex items-center">
              {i > 0 && <ChevronRight size={12} className="mx-1 text-text-tertiary" />}
              <div
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs ${
                  isCurrent
                    ? 'bg-accent text-white font-medium'
                    : isDone
                      ? 'text-success'
                      : 'text-text-secondary'
                }`}
              >
                {isDone ? (
                  <Check size={10} />
                ) : isCurrent ? (
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                ) : (
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-text-tertiary/40" />
                )}
                {STEP_LABELS[step]}
              </div>
            </div>
          );
        })}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto p-4">
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-error/30 bg-error/10 px-3 py-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-error" />
            <p className="text-sm text-error">{error}</p>
          </div>
        )}

        {/* Select Repo step */}
        {currentStep === 'select' && (
          <div className="mx-auto max-w-lg space-y-4">
            <p className="text-sm text-text-secondary">
              Select an indexed repository to run the onboarding wizard.
            </p>

            <RepoSelector
              selectedRepoId={selectedRepo?.id ?? null}
              onSelect={setSelectedRepo}
              emptyMessage="No indexed repositories found. Connect and index a repo first."
            />

            <button
              onClick={() => {
                setCurrentStep('detect');
                handleDetect();
              }}
              disabled={!selectedRepo}
              className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
            >
              Start Detection
            </button>
          </div>
        )}

        {/* Detecting step */}
        {currentStep === 'detect' && detecting && (
          <div className="flex h-64 items-center justify-center">
            <div className="text-center">
              <Loader2 size={32} className="mx-auto mb-3 animate-spin text-accent" />
              <p className="text-sm text-text-secondary">Analysing repository state...</p>
              <p className="mt-1 text-xs text-text-secondary">
                Checking artifacts, environment tools, and staleness
              </p>
            </div>
          </div>
        )}

        {/* Environment step */}
        {currentStep === 'environment' && detection && (
          <EnvironmentStep
            detection={detection}
            onNext={() =>
              setCurrentStep(
                visibleSteps.includes('agents-md')
                  ? 'agents-md'
                  : visibleSteps.includes('devcontainer')
                    ? 'devcontainer'
                    : 'done',
              )
            }
          />
        )}

        {/* AGENTS.md step */}
        {currentStep === 'agents-md' && detection && selectedRepo && (
          <AgentsMdStep
            repoId={selectedRepo.id}
            detection={detection}
            onNext={() =>
              setCurrentStep(visibleSteps.includes('devcontainer') ? 'devcontainer' : 'done')
            }
          />
        )}

        {/* Devcontainer step */}
        {currentStep === 'devcontainer' && detection && selectedRepo && (
          <DevcontainerStep
            repoId={selectedRepo.id}
            detection={detection}
            onNext={() => setCurrentStep('connectors')}
          />
        )}

        {/* Connectors step */}
        {currentStep === 'connectors' && <ConnectorsStep onNext={() => setCurrentStep('done')} />}

        {/* Done step */}
        {currentStep === 'done' && detection && (
          <div className="mx-auto max-w-lg text-center">
            <Check size={48} className="mx-auto mb-4 text-success" />
            <h3 className="text-base font-semibold text-text-primary">Onboarding Complete</h3>
            <p className="mt-2 text-sm text-text-secondary">
              Your repository is set up for developer onboarding. Generated artifacts have been
              written to the repo directory.
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <button
                onClick={handleRestart}
                className="rounded-md border border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
              >
                Onboard Another Repo
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
