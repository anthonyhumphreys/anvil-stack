import { useCallback, useEffect, useRef, useState } from 'react';
import { Compass, ChevronRight, Check, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import type { OnboardDetection, RepoInfo } from '../../../shared/types';
import { EnvironmentStep } from './EnvironmentStep';
import { AgentsMdStep } from './AgentsMdStep';
import { DevcontainerStep } from './DevcontainerStep';
import { ConnectorsStep } from './ConnectorsStep';
import { useWorkspace, repoIsMapped } from '../../contexts/WorkspaceContext';
import { RepoSelector } from '../shared/RepoSelector';
import { RepoFeatureEmptyState } from '../shared/RepoFeatureEmptyState';
import { Button } from '../ui';
import { ViewHeader } from '../layout/ViewScaffold';

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

// OB3: wizard progress is persisted per repo (localStorage keyed by repo id)
// so a relaunch resumes where the user left off. Detection itself is
// persisted server-side by `onboard:detect` (onboard_state table) and is
// re-run on resume — it's cheap and refreshes staleness.
const STEP_STORAGE_PREFIX = 'anvil:onboard-step:';
const REPO_STORAGE_KEY = 'anvil:onboard-repo';

function loadPersistedRepoId(): string | null {
  try {
    return window.localStorage.getItem(REPO_STORAGE_KEY);
  } catch {
    return null;
  }
}

function loadPersistedStep(repoId: string): WizardStep | null {
  try {
    const raw = window.localStorage.getItem(`${STEP_STORAGE_PREFIX}${repoId}`);
    return (raw as WizardStep | null) ?? null;
  } catch {
    return null;
  }
}

function clearPersisted(repoId: string) {
  try {
    window.localStorage.removeItem(`${STEP_STORAGE_PREFIX}${repoId}`);
    window.localStorage.removeItem(REPO_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function OnboardView() {
  const { repos: workspaceRepos, featureAvailability } = useWorkspace();
  const [restoredRepoId] = useState(() => loadPersistedRepoId());

  const [selectedRepo, setSelectedRepo] = useState<RepoInfo | null>(null);
  const [detection, setDetection] = useState<OnboardDetection | null>(null);
  const [currentStep, setCurrentStep] = useState<WizardStep>('select');
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resumeAttemptedRef = useRef<string | null>(null);

  // Restore the previously worked-on repo, or auto-select the first repo that
  // has reached the `mapped` tier (OB4) — not merely 'connected'.
  useEffect(() => {
    if (selectedRepo) return;
    const match = restoredRepoId ? workspaceRepos.find((repo) => repo.id === restoredRepoId) : null;
    const target = match ?? workspaceRepos.find(repoIsMapped) ?? null;
    if (target) setSelectedRepo(target);
  }, [workspaceRepos, restoredRepoId, selectedRepo]);

  // Persist the selected repo and the per-repo step across relaunch.
  useEffect(() => {
    if (!selectedRepo) return;
    try {
      window.localStorage.setItem(REPO_STORAGE_KEY, selectedRepo.id);
    } catch {
      /* ignore */
    }
  }, [selectedRepo]);

  useEffect(() => {
    if (!selectedRepo || currentStep === 'select') return;
    try {
      window.localStorage.setItem(`${STEP_STORAGE_PREFIX}${selectedRepo.id}`, currentStep);
    } catch {
      /* ignore */
    }
  }, [currentStep, selectedRepo]);

  // Resume: if the restored repo has a persisted step past detection, re-run
  // detection (refreshes onboard_state) and jump back to that step.
  useEffect(() => {
    if (!selectedRepo) return;
    const step = loadPersistedStep(selectedRepo.id);
    if (!step || step === 'select' || step === 'detect') return;
    if (resumeAttemptedRef.current === selectedRepo.id) return;
    resumeAttemptedRef.current = selectedRepo.id;
    (async () => {
      try {
        const result = await window.anvil.onboard.detect(selectedRepo.id);
        setDetection(result);
        setCurrentStep(step);
      } catch {
        /* leave at select — detection errors surface on explicit Start */
      }
    })();
  }, [selectedRepo]);

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
    if (selectedRepo) clearPersisted(selectedRepo.id);
    setDetection(null);
    setCurrentStep('select');
    setError(null);
  }, [selectedRepo]);

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

  if (!featureAvailability.repoFeaturesEnabled) {
    return (
      <RepoFeatureEmptyState
        icon={Compass}
        featureLabel="Repo setup"
        description="Prepare a repository for reliable agent work and connected delivery tools."
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        icon={Compass}
        title="Repo setup"
        description="Prepare a repository for reliable agent work and connected delivery tools."
        meta={
          selectedRepo ? (
            <span className="rounded bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">
              {selectedRepo.name}
            </span>
          ) : undefined
        }
        actions={
          detection ? (
            <button
              onClick={handleRestart}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm text-text-secondary hover:text-text-primary"
            >
              <RefreshCw size={12} />
              Restart
            </button>
          ) : undefined
        }
      />

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
                    ? 'bg-accent text-accent-foreground font-medium'
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
              Select a repository to check its agent-readiness — AGENTS.md, dev container, and
              environment. The structural index must have finished (mapped tier).
            </p>

            <RepoSelector
              selectedRepoId={selectedRepo?.id ?? null}
              onSelect={setSelectedRepo}
              emptyMessage="No mapped repositories yet — indexing runs automatically after a repo is connected."
            />

            <Button
              variant="primary"
              onClick={() => {
                setCurrentStep('detect');
                void handleDetect();
              }}
              disabled={!selectedRepo}
              className="w-full"
            >
              Start detection
            </Button>
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
