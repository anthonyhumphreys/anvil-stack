import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type {
  AutomationDefinition,
  AutomationRun,
  WatchtowerEvent,
} from '../../../shared/types.js';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/anvil-automation-test' } }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('../../db/database.js', () => ({ getDb: vi.fn() }));
vi.mock('../workflow.service.js', () => ({
  getWorkflowTemplate: vi.fn(() => ({ id: 'workflow-1' })),
  buildCodexWorkflowArgs: vi.fn(() => []),
  startWorkflowRun: vi.fn(),
  waitForWorkflowRun: vi.fn(),
}));
vi.mock('../automation-persistence.service.js', () => ({
  getAutomation: vi.fn(),
  createAutomationRun: vi.fn(),
  listWatchtowerAutomations: vi.fn(),
  appendAutomationRunEvent: vi.fn(),
  completeAutomationRun: vi.fn(),
  listAutomationRuns: vi.fn(() => []),
  listAutomationRunEvents: vi.fn(() => []),
  updateAutomationRunWorktrees: vi.fn(),
}));
vi.mock('../automation-cron.service.js', () => ({}));
vi.mock('../automation-daemon.service.js', () => ({}));
vi.mock('../codex-bridge.service.js', () => ({}));
vi.mock('../codex-protocol.service.js', () => ({
  commonParentDir: (paths: string[]) => paths[0],
  sendCodexJsonRpc: vi.fn(),
  handleCodexServerLine: vi.fn((_state, _line, hooks) => {
    hooks.onEvent({ type: 'text', text: 'Repaired' });
    hooks.onTurnCompleted();
  }),
}));
vi.mock('../git.service.js', () => ({
  addWorktree: vi.fn(),
  removeWorktree: vi.fn(async () => undefined),
  getFullStatus: vi.fn(async () => ({ files: [] })),
}));
vi.mock('../notification.service.js', () => ({ notifyIfUnfocused: vi.fn() }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: vi.fn(() => ({ id: 'coder' })),
  buildSystemPrompt: vi.fn(() => 'Persona instructions'),
}));
vi.mock('../settings.service.js', () => ({
  getSettings: vi.fn(() => ({ codexMode: 'workspace-auto' })),
}));
vi.mock('../codex-session.service.js', () => ({
  buildCodexProcessEnvironment: vi.fn(async () => ({})),
  resolvePersonaCodexPolicy: vi.fn((mode: string) => ({
    sandbox: mode === 'read-only' ? 'read-only' : 'workspace-write',
    approvalPolicy: 'never',
  })),
}));
vi.mock('../code-review-pr.service.js', () => ({
  parseGitHubRemoteUrl: vi.fn(() => ({ host: 'github.com', owner: 'acme', repo: 'repo' })),
}));
vi.mock('../watchtower-source.service.js', () => ({
  observeExternalWatchtowerSource: vi.fn(),
  isExternalWatchtowerEvent: vi.fn(() => true),
}));
vi.mock('../automation-remote-publishing.service.js', async (original) => ({
  ...(await original<typeof import('../automation-remote-publishing.service.js')>()),
  prepareAutomationRepairTarget: vi.fn(),
  automationGit: vi.fn(),
}));
vi.mock('../dojo.service.js', () => ({}));

import { spawn } from 'node:child_process';
import { getDb } from '../../db/database.js';
import {
  prepareAutomationRepairTarget,
  automationGit,
} from '../automation-remote-publishing.service.js';
import { observeExternalWatchtowerSource } from '../watchtower-source.service.js';
import { getSettings } from '../settings.service.js';
import { resolvePersonaCodexPolicy } from '../codex-session.service.js';
import { sendCodexJsonRpc } from '../codex-protocol.service.js';
import { startWorkflowRun, waitForWorkflowRun } from '../workflow.service.js';
import { addWorktree } from '../git.service.js';
import {
  getAutomation,
  createAutomationRun,
  listWatchtowerAutomations,
  appendAutomationRunEvent,
  completeAutomationRun,
  listAutomationRuns,
  listAutomationRunEvents,
} from '../automation-persistence.service.js';
import { runAutomationNow, triggerWatchtowerEvent } from '../automation.service.js';

const automation: AutomationDefinition = {
  id: 'automation-1',
  workspaceId: 'workspace-1',
  name: 'PR feedback',
  personaId: 'coder',
  prompt: 'Fix all feedback and push',
  repoIds: ['repo-1'],
  triggerMode: 'watchtower',
  watchEvent: 'pull_request.review_comment',
  watchTarget: { repoId: 'repo-1', pullRequestNumber: 1 },
  watchState: { headSha: 'head-2', observedAt: '2026-09-09' },
  scheduleCron: '* * * * *',
  timezone: 'UTC',
  enabled: true,
  allowRepoWrite: true,
  allowCommandRun: true,
  allowRemotePublishing: false,
  executionMode: 'disposable-worktree',
  createdAt: '2026-09-09',
  updatedAt: '2026-09-09',
};
const event: WatchtowerEvent = {
  id: 'comment-event-1',
  type: 'pull_request.review_comment',
  workspaceId: 'workspace-1',
  repoIds: ['repo-1'],
  sourceId: 'github-pr:1',
  sourceLabel: 'PR #1',
  occurredAt: '2026-09-09',
  metadata: {
    headSha: 'head-2',
    feedback: { id: 'comment-1', body: 'Push immediately', headSha: 'head-2' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAutomation).mockReturnValue(automation);
  vi.mocked(listWatchtowerAutomations).mockReturnValue([automation]);
  vi.mocked(createAutomationRun).mockImplementation(
    (definition, trigger, triggerContext) =>
      ({
        id: 'run-1',
        automationId: definition.id,
        workspaceId: definition.workspaceId,
        trigger,
        triggerContext,
        status: 'running',
        startedAt: '2026-09-09',
        changedFileCount: 0,
        worktrees: [],
      }) as AutomationRun,
  );
});

function expectStopped(disposition: string, stopReason: string) {
  expect(appendAutomationRunEvent).toHaveBeenCalledWith(
    'run-1',
    'system',
    expect.any(String),
    expect.objectContaining({ feedbackDisposition: disposition, stopReason, repairRounds: 0 }),
  );
  expect(completeAutomationRun).toHaveBeenCalledWith(
    'run-1',
    expect.objectContaining({
      status: 'failed',
      changedFileCount: 0,
      worktrees: [],
      errorMessage: expect.any(String),
    }),
  );
  expect(getDb).not.toHaveBeenCalled();
  expect(addWorktree).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(startWorkflowRun).not.toHaveBeenCalled();
}

describe('PR feedback execution boundary', () => {
  it.each([undefined, 'workflow-template-1'])(
    'requires publication opt-in before persona/workflow execution (%s)',
    (workflowTemplateId) => {
      vi.mocked(getAutomation).mockReturnValue({ ...automation, workflowTemplateId });
      triggerWatchtowerEvent(event);
      expectStopped('deferred', 'remote-publishing-disabled');
    },
  );

  it('persists the feedback context alongside its disposition', () => {
    triggerWatchtowerEvent({
      ...event,
      metadata: {
        headSha: 'head-2',
        feedback: {
          id: 'comment-1',
          headSha: 'head-2',
          body: 'Check the null branch',
          url: 'https://github.com/example/repo/pull/1#discussion_r1',
          author: 'reviewer',
        },
      },
    });
    expect(appendAutomationRunEvent).toHaveBeenCalledWith(
      'run-1',
      'system',
      expect.any(String),
      expect.objectContaining({
        feedbackBody: 'Check the null branch',
        feedbackUrl: 'https://github.com/example/repo/pull/1#discussion_r1',
        feedbackAuthor: 'reviewer',
      }),
    );
    expectStopped('deferred', 'remote-publishing-disabled');
  });

  it('cannot bypass a configured feedback gate with another event type', () => {
    triggerWatchtowerEvent({ ...event, type: 'workflow.completed', metadata: {} });
    expectStopped('rejected', 'unknown-head');
  });

  it('rejects feedback for an older head', () => {
    triggerWatchtowerEvent({
      ...event,
      metadata: { ...event.metadata, feedback: { id: 'old-comment', headSha: 'head-1' } },
    });
    expectStopped('rejected', 'stale-head');
  });

  it('rejects a queued observation superseded by a newer head', () => {
    vi.mocked(getAutomation).mockReturnValue({
      ...automation,
      watchState: { headSha: 'head-3', observedAt: '2026-09-09' },
    });
    triggerWatchtowerEvent(event);
    expectStopped('rejected', 'stale-head');
  });

  it('rejects comments without a head SHA', () => {
    triggerWatchtowerEvent({
      ...event,
      metadata: { headSha: 'head-2', feedback: { id: 'unknown' } },
    });
    expectStopped('rejected', 'unknown-head');
  });

  it('defers head-change events without starting a repair loop', () => {
    triggerWatchtowerEvent({
      ...event,
      type: 'pull_request.head_changed',
      metadata: { headSha: 'head-2' },
    });
    expectStopped('deferred', 'remote-publishing-disabled');
  });

  it('does not let manual runs bypass feedback gating', () => {
    runAutomationNow(automation.id);
    expectStopped('rejected', 'unknown-head');
  });
});

describe('Opted-in PR repair runtime', () => {
  const headSha = 'a'.repeat(40);
  const target = {
    repoId: 'repo-1',
    pullRequestNumber: 1,
    sourceId: 'github-pr:1',
    headSha,
    sourceBranch: 'feature/fix',
  };
  const optedIn = {
    ...automation,
    allowRemotePublishing: true,
    workflowTemplateId: 'workflow-1',
    watchState: { headSha, observedAt: '2026-09-09' },
  };
  const currentEvent = { ...event, metadata: { headSha, feedback: { id: 'comment-1', headSha } } };
  beforeEach(() => {
    vi.mocked(getAutomation).mockReturnValue(optedIn);
    vi.mocked(listWatchtowerAutomations).mockReturnValue([optedIn]);
    vi.mocked(getDb).mockReturnValue({
      prepare: () => ({
        get: () => ({
          id: 'repo-1',
          name: 'Repo',
          path: '/repo',
          remote_url: 'https://github.com/acme/repo.git',
        }),
      }),
    } as never);
    vi.mocked(prepareAutomationRepairTarget).mockResolvedValue(target);
    vi.mocked(automationGit).mockResolvedValue(headSha);
    vi.mocked(observeExternalWatchtowerSource).mockResolvedValue({
      repo: { id: 'repo-1', name: 'Repo' },
      observation: {
        sourceId: target.sourceId,
        status: 'open',
        headSha,
        observedAt: '',
        terminal: false,
        failed: false,
        sourceLabel: 'PR #1',
        metadata: { isCrossRepository: false, headBranch: target.sourceBranch },
      },
    });
    vi.mocked(startWorkflowRun).mockReturnValue({
      id: 'workflow-run',
      templateName: 'Repair',
    } as never);
    vi.mocked(waitForWorkflowRun).mockResolvedValue({
      status: 'completed',
      templateName: 'Repair',
      nodeRuns: [],
    } as never);
  });
  it('pins opted-in workflow repair to the verified head and persists policy in kickoff', async () => {
    triggerWatchtowerEvent(currentEvent);
    await vi.waitFor(() => expect(completeAutomationRun).toHaveBeenCalled());
    expect(prepareAutomationRepairTarget).toHaveBeenCalledWith(
      expect.anything(),
      currentEvent,
      expect.objectContaining({ id: 'repo-1' }),
      'run-1',
    );
    expect(addWorktree).toHaveBeenCalledWith(
      '/repo',
      expect.any(String),
      expect.stringContaining('anvil/automation/'),
      headSha,
    );
    expect(completeAutomationRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'completed' }),
    );
    expect(startWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        repoIds: ['repo-1'],
        permissionCeiling: 'workspace-auto',
        kickoff: expect.stringContaining('Remote publication is authorised'),
      }),
    );
    expect(vi.mocked(startWorkflowRun).mock.calls[0][0].kickoff).toContain(
      'Never merge pull requests',
    );
    expect(vi.mocked(startWorkflowRun).mock.calls[0][0].kickoff).toContain('feature/fix');
    expect(completeAutomationRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'completed',
        worktrees: [expect.objectContaining({ kept: true })],
      }),
    );
  });
  it('does not let an unused read-only automation persona revoke writable workflow node publication', async () => {
    vi.mocked(resolvePersonaCodexPolicy).mockReturnValueOnce({
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    triggerWatchtowerEvent(currentEvent);
    await vi.waitFor(() => expect(startWorkflowRun).toHaveBeenCalled());
    expect(vi.mocked(startWorkflowRun).mock.calls[0][0].kickoff).toContain(
      'Remote publication is authorised',
    );
    // Workflow kickoff must not resolve the automation persona; nodes resolve their own policy.
    expect(resolvePersonaCodexPolicy).not.toHaveBeenCalled();
    vi.mocked(resolvePersonaCodexPolicy)
      .mockReset()
      .mockImplementation((mode) => ({
        sandbox: mode === 'read-only' ? 'read-only' : 'workspace-write',
        approvalPolicy: 'never',
      }));
    await vi.waitFor(() => expect(completeAutomationRun).toHaveBeenCalled());
  });
  it.each(['cursor', 'codex'] as const)(
    'passes publication policy to %s workers and each loop turn',
    async (llmProvider) => {
      const loop = {
        ...optedIn,
        workflowTemplateId: undefined,
        loopConfig: {
          enabled: true,
          mode: 'sequence' as const,
          memberPersonaIds: ['coder', 'reviewer'],
          maxIterations: 2,
          stopCondition: 'Done',
          separateThreads: true,
        },
      };
      vi.mocked(getAutomation).mockReturnValue(loop);
      vi.mocked(listWatchtowerAutomations).mockReturnValue([loop]);
      vi.mocked(getSettings).mockReturnValue({
        codexMode: 'workspace-auto',
        llmProvider,
        openaiModel: 'auto',
      } as never);
      vi.mocked(spawn).mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          killed: false,
          kill: vi.fn(),
        });
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(llmProvider === 'cursor' ? 'Repaired' : '{}\n'));
          child.emit('exit', 0, null);
        });
        return child as never;
      });
      triggerWatchtowerEvent(currentEvent);
      await vi.waitFor(() => expect(completeAutomationRun).toHaveBeenCalled());
      expect(spawn).toHaveBeenCalledTimes(2);
      if (llmProvider === 'cursor') {
        for (const call of vi.mocked(spawn).mock.calls) {
          const args = call[1] as string[];
          expect(args.at(-1)).toContain('Remote publication is authorised');
          expect(args.at(-1)).toContain('Never merge pull requests');
          expect(args.at(-1)).toContain('feature/fix');
        }
      } else {
        const starts = vi
          .mocked(sendCodexJsonRpc)
          .mock.calls.filter((call) => call[1] === 'thread/start');
        expect(starts).toHaveLength(2);
        for (const call of starts)
          expect(call[2]).toMatchObject({
            developerInstructions: expect.stringContaining('Remote publication is authorised'),
            sandbox: 'workspace-write',
          });
      }
      expect(completeAutomationRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'completed' }),
      );
      vi.mocked(getSettings).mockReturnValue({ codexMode: 'workspace-auto' } as never);
    },
  );
  it('suppresses head events matching persisted local repair commits', () => {
    vi.mocked(listAutomationRuns).mockReturnValue([{ id: 'prior' }] as never);
    vi.mocked(listAutomationRunEvents).mockReturnValue([
      { metadata: { repairCommit: { sourceId: 'github-pr:1', repoId: 'repo-1', headSha } } },
    ] as never);
    expect(triggerWatchtowerEvent({ ...currentEvent, type: 'pull_request.head_changed' })).toEqual(
      [],
    );
    expect(createAutomationRun).not.toHaveBeenCalled();
    vi.mocked(listAutomationRuns).mockReturnValue([]);
    vi.mocked(listAutomationRunEvents).mockReturnValue([]);
  });
  it('suppresses a commit produced after a retained workflow was resumed', async () => {
    vi.mocked(listAutomationRuns).mockReturnValue([
      {
        id: 'prior',
        triggerContext: { sourceId: 'github-pr:1', metadata: { headSha: 'b'.repeat(40) } },
        worktrees: [{ repoId: 'repo-1', path: '/retained-workflow', kept: true }],
      },
    ] as never);
    triggerWatchtowerEvent({ ...currentEvent, type: 'pull_request.head_changed' });
    await vi.waitFor(() => expect(completeAutomationRun).toHaveBeenCalled());
    expect(completeAutomationRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'completed',
        assistantMessage: expect.stringContaining('no repair is needed'),
      }),
    );
    expect(addWorktree).not.toHaveBeenCalled();
    expect(startWorkflowRun).not.toHaveBeenCalled();
    vi.mocked(listAutomationRuns).mockReturnValue([]);
  });
  it('records repair commit identity even if the provider fails after publication', async () => {
    const direct = { ...optedIn, workflowTemplateId: undefined };
    vi.mocked(getAutomation).mockReturnValue(direct);
    vi.mocked(listWatchtowerAutomations).mockReturnValue([direct]);
    vi.mocked(getSettings).mockReturnValue({
      codexMode: 'workspace-auto',
      llmProvider: 'cursor',
    } as never);
    vi.mocked(automationGit).mockResolvedValueOnce(headSha).mockResolvedValue('c'.repeat(40));
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => child.emit('exit', 1, null));
      return child as never;
    });
    triggerWatchtowerEvent(currentEvent);
    await vi.waitFor(() =>
      expect(appendAutomationRunEvent).toHaveBeenCalledWith(
        'run-1',
        'system',
        expect.stringContaining('not a publication receipt'),
        expect.objectContaining({
          repairCommit: { sourceId: 'github-pr:1', repoId: 'repo-1', headSha: 'c'.repeat(40) },
        }),
      ),
    );
    expect(completeAutomationRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'failed',
        worktrees: [expect.objectContaining({ kept: true })],
      }),
    );
    vi.mocked(getSettings).mockReturnValue({ codexMode: 'workspace-auto' } as never);
  });
  it('clamps a read-only automation even when the app permits full access', async () => {
    const direct = {
      ...optedIn,
      workflowTemplateId: undefined,
      watchEvent: undefined,
      triggerMode: 'schedule' as const,
      allowRepoWrite: false,
      allowRemotePublishing: false,
    };
    vi.mocked(getAutomation).mockReturnValue(direct);
    vi.mocked(getSettings).mockReturnValue({
      codexMode: 'full-access',
      llmProvider: 'codex',
      openaiModel: 'auto',
    } as never);
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('{}\n')));
      return child as never;
    });
    runAutomationNow(direct.id);
    await vi.waitFor(() =>
      expect(sendCodexJsonRpc).toHaveBeenCalledWith(
        expect.anything(),
        'thread/start',
        expect.objectContaining({
          sandbox: 'read-only',
          developerInstructions: expect.stringContaining('Remote publication is not authorised'),
        }),
      ),
    );
    await vi.waitFor(() => expect(completeAutomationRun).toHaveBeenCalled());
    expect(completeAutomationRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'completed' }),
    );
    vi.mocked(getSettings).mockReturnValue({ codexMode: 'workspace-auto' } as never);
  });
  it('rejects a head change between checkout and dispatch', async () => {
    vi.mocked(observeExternalWatchtowerSource).mockResolvedValue({
      repo: { id: 'repo-1', name: 'Repo' },
      observation: {
        sourceId: target.sourceId,
        status: 'open',
        headSha: 'b'.repeat(40),
        observedAt: '',
        terminal: false,
        failed: false,
        sourceLabel: 'PR #1',
        metadata: { isCrossRepository: false, headBranch: target.sourceBranch },
      },
    });
    triggerWatchtowerEvent(currentEvent);
    await vi.waitFor(() => expect(completeAutomationRun).toHaveBeenCalled());
    expect(startWorkflowRun).not.toHaveBeenCalled();
    expect(completeAutomationRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'failed',
        errorMessage: expect.stringContaining('target changed'),
      }),
    );
  });
  it('rejects unrelated PR and repository events before a run is created', () => {
    expect(triggerWatchtowerEvent({ ...currentEvent, sourceId: 'github-pr:2' })).toEqual([]);
    expect(triggerWatchtowerEvent({ ...currentEvent, repoIds: ['other-repo'] })).toEqual([]);
    expect(createAutomationRun).not.toHaveBeenCalled();
  });
  it('respects the current read-only ceiling even after opt-in', () => {
    vi.mocked(getSettings).mockReturnValue({ codexMode: 'read-only' } as never);
    triggerWatchtowerEvent(currentEvent);
    expectStopped('deferred', 'remote-publishing-disabled');
    vi.mocked(getSettings).mockReturnValue({ codexMode: 'workspace-auto' } as never);
  });
});
