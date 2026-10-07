import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Minus, Wand2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { OnboardDetection, RepoInfo } from '../../../shared/types';
import { cx } from '../ui';

/**
 * OB2: per-repo agent-readiness checklist shown on the repo detail pane —
 * AGENTS.md, devcontainer, and environment variables, each with a
 * "Fix with agent" action that routes to Chat with a scoped prompt.
 *
 * Detection comes from the persisted `onboard.detect` IPC (backed by the
 * `onboard_state` table), so the result survives relaunch.
 */
export function RepoReadinessChecklist({ repo }: { repo: RepoInfo }) {
  const navigate = useNavigate();
  const [detection, setDetection] = useState<OnboardDetection | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.anvil.onboard
      .detect(repo.id)
      .then((result) => {
        if (!cancelled) setDetection(result);
      })
      .catch(() => {
        if (!cancelled) setDetection(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repo.id]);

  if (loading || !detection) return null;

  const missingRequiredEnv = detection.environmentStatus.filter(
    (check) => check.required && !check.installed,
  );
  const envTemplateSuggested = detection.suggestedActions.includes('generate-env-template');

  const fixWithAgent = (task: string) =>
    navigate(
      `/chat?prompt=${encodeURIComponent(
        `In the ${repo.name} repository (${repo.path}), ${task}`,
      )}`,
    );

  const items: Array<{
    key: string;
    label: string;
    ok: boolean;
    stale?: boolean;
    detail?: string;
    fixPrompt?: string;
  }> = [
    {
      key: 'agents-md',
      label: 'AGENTS.md',
      ok: detection.agentsMdExists && detection.agentsMdStaleness !== 'missing',
      stale: detection.agentsMdStaleness === 'stale',
      detail: detection.agentsMdExists
        ? detection.agentsMdStaleness === 'stale'
          ? 'Present but may be stale'
          : (detection.agentsMdPath ?? 'Present')
        : 'Missing — agents won’t know project conventions',
      fixPrompt: detection.agentsMdExists
        ? 'review and update AGENTS.md so it reflects the current project structure and conventions.'
        : 'generate an AGENTS.md describing the project structure, conventions, and how to build and test it.',
    },
    {
      key: 'devcontainer',
      label: 'Dev container',
      ok: detection.devcontainerExists,
      detail: detection.devcontainerExists
        ? (detection.devcontainerPath ?? 'Present')
        : 'Missing — no reproducible agent environment',
      fixPrompt:
        'generate a .devcontainer/devcontainer.json with the runtimes and tools this project needs.',
    },
    {
      key: 'env',
      label: 'Environment',
      ok: missingRequiredEnv.length === 0 && !envTemplateSuggested,
      stale: envTemplateSuggested && missingRequiredEnv.length === 0,
      detail:
        missingRequiredEnv.length > 0
          ? `Missing required: ${missingRequiredEnv.map((check) => check.name).join(', ')}`
          : envTemplateSuggested
            ? 'No env template (.env.example) found'
            : 'Required tools detected',
      fixPrompt:
        missingRequiredEnv.length > 0
          ? `help me set up the missing required tools: ${missingRequiredEnv
              .map((check) => check.name)
              .join(', ')}.`
          : 'create a .env.example documenting the environment variables this project needs.',
    },
  ];

  const allOk = items.every((item) => item.ok && !item.stale);
  if (allOk) return null;

  return (
    <section className="rounded-lg border border-border-subtle bg-bg-secondary p-4">
      <h3 className="text-eyebrow font-semibold uppercase tracking-wider text-text-tertiary">
        Agent readiness
      </h3>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item.key} className="flex items-center gap-3">
            {item.ok && !item.stale ? (
              <Check size={14} className="shrink-0 text-success" aria-hidden="true" />
            ) : item.stale ? (
              <AlertTriangle size={14} className="shrink-0 text-warning" aria-hidden="true" />
            ) : (
              <Minus size={14} className="shrink-0 text-error" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <span
                className={cx(
                  'text-sm',
                  item.ok && !item.stale ? 'text-text-secondary' : 'text-text-primary',
                )}
              >
                {item.label}
              </span>
              {item.detail && (
                <span className="ml-2 text-xs text-text-tertiary">{item.detail}</span>
              )}
            </div>
            {(!item.ok || item.stale) && item.fixPrompt && (
              <button
                type="button"
                onClick={() => fixWithAgent(item.fixPrompt!)}
                className="flex shrink-0 items-center gap-1 rounded-md border border-accent/30 px-2 py-1 text-xs text-accent hover:bg-accent/10"
              >
                <Wand2 size={11} aria-hidden="true" />
                Fix with agent
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
