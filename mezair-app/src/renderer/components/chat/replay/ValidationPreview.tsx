import { useCallback, useState } from 'react';
import type { AgentUISurfaceIntent } from '../../../../shared/agent-ui-intents';
import type { ValidationSurfaceData } from '../../../../shared/surfaces/kinds/validation';
import type { SurfaceViewProps } from '../../surfaces/types';
import { ValidationInline } from '../../surfaces/kinds/validation';

type Scenario = 'plan' | 'results' | 'stale' | 'running';
export function validationFixture(scenario: Scenario): AgentUISurfaceIntent {
  const data: ValidationSurfaceData = {
    repoId: 'synthetic-links',
    repoName: 'document-links',
    source: {
      kind: 'work-item',
      text: '- Expired links must not expose document contents.\n- A valid link opens the requested document.\n- A failed request preserves the draft.',
      workItemRef: { provider: 'linear', connectionId: 'synthetic', id: 'ANV-42' },
      workItemTitle: 'Make document links reliable',
    },
    snapshot: { head: 'a'.repeat(40), tree: 'b'.repeat(40), capturedAt: '2026-10-21T00:00:00Z' },
    criteriaVersion: 'fixture-criteria',
    freshness: scenario === 'stale' ? 'stale' : 'current',
    ...(scenario === 'stale'
      ? {
          freshnessDetail:
            'The source changed after these checks. Refresh the plan in chat before using its evidence.',
        }
      : {}),
    criteria: [
      {
        id: 'expiry',
        text: 'Expired links must not expose document contents.',
        basis: 'work-item',
        method: 'command',
        instruction:
          'Check expired-link responses and confirm that no document content is returned.',
        command: 'pnpm test -- share-links.test.ts',
      },
      {
        id: 'open',
        text: 'A valid link opens the requested document.',
        basis: 'work-item',
        method: 'browser',
        instruction: 'Open a valid link and inspect the document that appears.',
      },
      {
        id: 'draft',
        text: 'A failed request preserves the draft.',
        basis: 'work-item',
        method: 'command',
        instruction:
          'Simulate a network failure after editing a draft and check the retained text.',
        command: 'pnpm test -- draft-recovery.test.ts',
      },
      {
        id: 'keyboard',
        text: 'Opening a link with the keyboard keeps focus in the document.',
        basis: 'inferred',
        method: 'manual',
        instruction:
          'Check the installed desktop app with keyboard input. Report what you observe in chat.',
      },
    ],
  };
  if (scenario !== 'plan') {
    data.criteria = data.criteria.map((criterion, index) => ({
      ...criterion,
      result: {
        status:
          scenario === 'running' && criterion.method === 'command'
            ? 'running'
            : index === 2
              ? 'failed'
              : index === 3
                ? 'blocked'
                : 'passed',
        summary:
          scenario === 'running' && criterion.method === 'command'
            ? 'Waiting to run'
            : index === 2
              ? 'The draft is cleared after the request fails.'
              : index === 3
                ? 'No installed-app observation recorded.'
                : index === 0
                  ? 'Command exited 0'
                  : 'The expected document opened.',
        evidence:
          scenario === 'running' && criterion.method === 'command'
            ? ''
            : index === 2
              ? 'draft-recovery.test.ts\nExpected: "Meeting notes"\nReceived: ""\n\n1 failed, 8 passed'
              : index === 0
                ? 'share-links.test.ts\n12 tests passed, including revoked and expired links.'
                : index === 1
                  ? 'Browser tool observed the document title and body after opening the valid link.'
                  : '',
        provenance: criterion.method === 'command' ? 'runner-observed' : 'agent-reported',
        recordedAt: '2026-10-21T00:01:00Z',
      },
    }));
  }
  return {
    protocolVersion: 1,
    id: `fixture-validation-${scenario}`,
    kind: 'surface',
    revision: 1,
    scope: { threadId: 'synthetic-thread' },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind: 'validation',
      title: 'Validate document links',
      streaming: false,
      digest: 'Synthetic validation fixture',
      data,
    },
    createdAt: '2026-10-21T00:00:00Z',
    updatedAt: '2026-10-21T00:01:00Z',
  };
}

/** Exercises the production surface with synthetic evidence, never repository commands. */
export function ValidationPreview() {
  const [scenario, setScenario] = useState<Scenario>('results');
  const [intent, setIntent] = useState(() => validationFixture('results'));
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState('');
  const onAction: SurfaceViewProps['onAction'] = useCallback(async (request) => {
    if (request.action === 'refresh') return { ok: true };
    if (request.action === 'run' || request.action === 'retry') {
      setScenario('running');
      setIntent(validationFixture('running'));
      window.setTimeout(() => {
        setScenario('results');
        setIntent(validationFixture('results'));
      }, 500);
      return { ok: true, message: 'Synthetic checks are running. No commands were executed.' };
    }
    if (request.action === 'cancel') {
      setScenario('results');
      setIntent(validationFixture('results'));
    }
    return {
      ok: true,
      message:
        request.action === 'revise'
          ? 'Continue in chat: tell the agent which expectation or check to change.'
          : 'Synthetic preview: no workflow was saved and no command was executed.',
    };
  }, []);
  return (
    <main
      data-validation-preview
      className="min-h-screen bg-bg-primary px-5 py-6 text-text-primary sm:px-8"
    >
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-4">
          <p className="text-xs text-text-tertiary">
            Conversational validation · Synthetic UI replay
          </p>
          <div className="flex flex-wrap gap-1" aria-label="Preview state">
            {(['plan', 'results', 'stale', 'running'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={value === scenario}
                className={`rounded-md px-2 py-1 text-xs capitalize focus-visible:outline-2 focus-visible:outline-accent ${value === scenario ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:bg-bg-secondary'}`}
                onClick={() => {
                  setScenario(value);
                  setIntent(validationFixture(value));
                }}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <p className="ml-auto max-w-prose rounded-xl bg-bg-secondary px-4 py-3 text-sm">
          Validate this against ANV-42. Check that failed requests preserve my draft.
        </p>
        <div className="space-y-5">
          <p className="max-w-prose text-sm leading-6">
            {scenario === 'plan'
              ? "I've turned the work item's acceptance criteria into these checks. Keyboard focus is an expectation interpreted from your request. Refine it here, or run the plan when ready."
              : scenario === 'running'
                ? "I'm running the saved checks. The browser observation is recorded; keyboard focus still needs an installed-app observation."
                : scenario === 'stale'
                  ? 'The source changed after these checks. The earlier results remain here as history. Refine the plan in this conversation before rerunning it.'
                  : "I checked the work item's acceptance criteria. Draft recovery needs a fix, and keyboard focus still needs an installed-app observation. Expand a check to inspect its evidence, or refine the plan in this conversation."}
          </p>
          <ValidationInline
            intent={intent}
            presentation={expanded ? 'stage' : 'inline'}
            onAction={onAction}
            onComment={(anchor) => setComment(`Discuss in chat: ${anchor.label}`)}
            onOpenStage={() => setExpanded(true)}
          />
          {comment && (
            <p role="status" className="text-sm text-text-secondary">
              {comment}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
