import { useEffect, useState } from 'react';
import type { AnvilAPI } from '../../../../shared/ipc-api';
import type {
  ChatDelegationRun,
  ChatDelegationVerificationSelection,
} from '../../../../shared/chat-delegation';
import type { RepoInfo } from '../../../../shared/types';
import type { PreparedTurnDelivery } from '../../../../shared/scoped-git';
import { ChatDelegations } from '../ChatDelegations';
import { TurnChangesActions } from '../turn-changes/TurnChangesActions';
import type { TurnChangeSummary } from '../chat-turn-changes';

type Scenario = 'ready' | 'stale' | 'pr-failed' | 'checks-failed' | 'verified';
let scenario: Scenario = 'ready';
let run: ChatDelegationRun;
const fixtureHead = 'a'.repeat(40);
const fixtureResult = 'b'.repeat(40);
const fixtureDiff = [
  'diff --git a/src/retry.ts b/src/retry.ts',
  'index 1111111..2222222 100644',
  '--- a/src/retry.ts',
  '+++ b/src/retry.ts',
  '@@ -1 +1 @@',
  '-export const attempts = 1;',
  '+export const attempts = 3;',
  '',
].join('\n');

const repo: RepoInfo = {
  id: 'delivery-fixture',
  name: 'Delivery preview (synthetic)',
  path: '/synthetic/delivery-preview',
  defaultBranch: 'main',
  languages: [],
  status: 'connected',
  fileCount: 1,
  branchCount: 1,
};

const summary: TurnChangeSummary = {
  files: [
    {
      filePath: `${repo.path}/src/retry.ts`,
      diff: fixtureDiff,
      editCount: 1,
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: 'unified',
    },
  ],
  additions: 1,
  deletions: 1,
};

function resetRun(): void {
  run = {
    id: `fixture-run-${scenario}`,
    title: 'Linux compatibility check',
    reason: 'Verify the returned change before applying it to your checkout.',
    status: 'completed',
    createdAt: '2026-10-19T09:00:00Z',
    tasks: [
      {
        id: 'compatibility',
        name: 'Check retry behavior',
        provider: 'codex',
        model: 'fixture-model',
        destination: 'Build machine (synthetic)',
        mode: 'on-request',
        status: 'completed',
        output: 'Synthetic worker report. Review the combined diff and run the selected checks.',
        outputTruncated: false,
      },
    ],
    hasRemoteChanges: true,
  };
}

function combine(selectedChecks: ChatDelegationVerificationSelection[] = []): ChatDelegationRun {
  const state =
    scenario === 'checks-failed'
      ? 'failed'
      : scenario === 'verified' || selectedChecks.some((selection) => selection.commands.length > 0)
        ? 'passed'
        : 'not-run';
  run = {
    ...run,
    integrationState: 'integrated',
    integration: {
      integrationId: 'fixture-integration',
      mergeState: 'integrated',
      combined: true,
      applyAllowed: true,
      verificationState: state,
      verificationAttempt: state === 'not-run' ? 0 : 1,
      verificationSelections: [{ repositoryId: repo.id, commands: ['pnpm test'] }],
      verification:
        state === 'not-run'
          ? []
          : [
              {
                repositoryId: repo.id,
                command: 'pnpm test',
                approvalGranted: true,
                exitCode: state === 'passed' ? 0 : 1,
                timedOut: false,
                durationMs: 1200,
                logTail:
                  state === 'passed'
                    ? 'Synthetic fixture: 12 tests passed.'
                    : 'Synthetic fixture: retry assertion failed.',
                testedHead: fixtureResult,
                testedTree: 'c'.repeat(40),
              },
            ],
      appliedAt: null,
      repositories: [
        {
          repositoryId: repo.id,
          name: repo.name,
          baseCommit: fixtureHead,
          integratedCommit: fixtureResult,
          branch: 'mesh/integrate/synthetic',
          worktreePath: '/synthetic/mesh/integrate/synthetic',
          conflicts: [],
          appliedAt: null,
          destinationBranch: null,
          appliedCommit: null,
        },
      ],
    },
  };
  return run;
}

/** Called only by the standalone development replay entry, never by Electron. */
export function installDeliveryPreviewBridge(): void {
  resetRun();
  const bridge = window.anvil;
  const previewChat: Pick<
    AnvilAPI['chat'],
    | 'listDelegations'
    | 'readDelegation'
    | 'prepareDelegationIntegration'
    | 'integrateDelegation'
    | 'retryDelegationVerification'
    | 'applyDelegationIntegration'
  > = {
    listDelegations: async () => [run],
    readDelegation: async () => run,
    prepareDelegationIntegration: async () => ({
      repositories: [
        {
          repositoryId: repo.id,
          name: repo.name,
          candidates: [{ label: 'Tests', command: 'pnpm test', source: 'detected' }],
          recommendedCommands: ['pnpm test'],
        },
      ],
      permissionMode: 'on-request',
      permissionExplanation: 'Synthetic preview. No commands run and no files change.',
    }),
    integrateDelegation: async (_threadId, _runId, selectedChecks) => combine(selectedChecks),
    retryDelegationVerification: async () => combine(run.integration?.verificationSelections),
    applyDelegationIntegration: async () => {
      if (!run.integration) throw new Error('Combine the synthetic result first.');
      const appliedAt = new Date().toISOString();
      run = {
        ...run,
        integration: {
          ...run.integration,
          appliedAt,
          repositories: run.integration.repositories.map((repository) => ({
            ...repository,
            appliedAt,
            appliedCommit: repository.integratedCommit,
            destinationBranch: 'feature/retries',
          })),
        },
      };
      return run;
    },
  };
  Object.assign(bridge.chat, previewChat);
  Object.assign(bridge.git, {
    prepareTurnDelivery: async (
      _repoId: string,
      _paths: string[],
      mode: 'commit' | 'pr',
    ): Promise<PreparedTurnDelivery> => ({
      reviewId: 'fixture-review',
      mode,
      sourceBranch: 'feature/retries',
      sourceHead: fixtureHead,
      ...(mode === 'pr' ? { baseBranch: 'main', baseHead: fixtureHead } : {}),
      files: [{ path: 'src/retry.ts', status: 'modified', diff: fixtureDiff }],
      diff: fixtureDiff,
      suggestedMessage: 'fix(retry): bound attempts',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }),
    commitTurnDelivery: async () => {
      if (scenario === 'stale')
        throw new Error('A selected file changed after review. Review the current Git diff again.');
      return { commitHash: fixtureResult, branch: 'feature/retries', files: ['src/retry.ts'] };
    },
    createTurnPullRequest: async () => ({
      repoId: repo.id,
      repoName: repo.name,
      branch: 'codex/turn-synthetic',
      baseBranch: 'main',
      commitHash: fixtureResult,
      commitMessage: 'fix(retry): bound attempts',
      status: 'branch-pushed',
      detail:
        'Synthetic preview: the branch is retained, but the pull request provider could not be reached.',
    }),
  });
}

export function DeliveryReadinessPreview() {
  const [selected, setSelected] = useState<Scenario>(scenario);
  const [theme, setTheme] = useState('dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <main className="mx-auto h-full max-w-5xl space-y-8 overflow-y-auto px-6 py-8 text-text-primary">
      <header className="space-y-3">
        <h1 className="text-xl font-semibold">Delivery interactions</h1>
        <p className="max-w-[72ch] text-sm text-text-secondary">
          Synthetic data using the production components. No Git action, provider request or
          verification command runs here.
        </p>
        <div className="flex flex-wrap gap-4">
          <label className="text-sm">
            Scenario
            <select
              className="ml-2 rounded border border-border bg-bg-secondary px-2 py-1"
              value={selected}
              onChange={(event) => {
                scenario = event.target.value as Scenario;
                resetRun();
                setSelected(scenario);
              }}
            >
              <option value="ready">Ready for review</option>
              <option value="stale">Selected file changed</option>
              <option value="pr-failed">PR provider unavailable</option>
              <option value="checks-failed">Verification failed</option>
              <option value="verified">Verification passed</option>
            </select>
          </label>
          <label className="text-sm">
            Theme
            <select
              className="ml-2 rounded border border-border bg-bg-secondary px-2 py-1"
              value={theme}
              onChange={(event) => setTheme(event.target.value)}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="agent-after-hours">Agent After Hours</option>
            </select>
          </label>
        </div>
      </header>
      <section aria-label="Reviewed change delivery">
        <h2 className="mb-3 text-base font-medium">Current changes in selected files</h2>
        <TurnChangesActions
          key={selected}
          summary={summary}
          repo={repo}
          readOnly={false}
          checkUndo={false}
        />
      </section>
      <ChatDelegations key={`delegation-${selected}`} threadId={`delivery-preview-${selected}`} />
    </main>
  );
}
