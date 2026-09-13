import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AutomationDefinition,
  AutomationRun,
  WatchtowerEvent,
} from '../../../shared/types.js';

vi.mock('electron', () => ({ app: {} }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../db/database.js', () => ({ getDb: vi.fn() }));
vi.mock('../workflow.service.js', () => ({
  getWorkflowTemplate: vi.fn(),
  startWorkflowRun: vi.fn(),
  waitForWorkflowRun: vi.fn(),
}));
vi.mock('../automation-persistence.service.js', () => ({
  getAutomation: vi.fn(),
  createAutomationRun: vi.fn(),
  listWatchtowerAutomations: vi.fn(),
  appendAutomationRunEvent: vi.fn(),
  completeAutomationRun: vi.fn(),
}));
vi.mock('../automation-cron.service.js', () => ({}));
vi.mock('../automation-daemon.service.js', () => ({}));
vi.mock('../codex-bridge.service.js', () => ({}));
vi.mock('../codex-protocol.service.js', () => ({}));
vi.mock('../git.service.js', () => ({ addWorktree: vi.fn() }));
vi.mock('../notification.service.js', () => ({}));
vi.mock('../persona.service.js', () => ({}));
vi.mock('../settings.service.js', () => ({}));
vi.mock('../codex-session.service.js', () => ({}));
vi.mock('../code-review-pr.service.js', () => ({}));
vi.mock('../watchtower-source.service.js', () => ({}));
vi.mock('../dojo.service.js', () => ({}));

import { spawn } from 'node:child_process';
import { getDb } from '../../db/database.js';
import { startWorkflowRun } from '../workflow.service.js';
import { addWorktree } from '../git.service.js';
import {
  getAutomation,
  createAutomationRun,
  listWatchtowerAutomations,
  appendAutomationRunEvent,
  completeAutomationRun,
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
  watchState: { headSha: 'head-2', observedAt: '2026-09-09' },
  scheduleCron: '* * * * *',
  timezone: 'UTC',
  enabled: true,
  allowRepoWrite: true,
  allowCommandRun: true,
  executionMode: 'disposable-worktree',
  createdAt: '2026-09-09',
  updatedAt: '2026-09-09',
};
const event: WatchtowerEvent = {
  id: 'comment-event-1',
  type: 'pull_request.review_comment',
  workspaceId: 'workspace-1',
  repoIds: ['repo-1'],
  sourceId: 'pr-1',
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
    'defers feedback before persona/workflow execution (%s)',
    (workflowTemplateId) => {
      vi.mocked(getAutomation).mockReturnValue({ ...automation, workflowTemplateId });
      triggerWatchtowerEvent(event);
      expectStopped('deferred', 'remote-write-capabilities-unavailable');
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
    expectStopped('deferred', 'remote-write-capabilities-unavailable');
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
    expectStopped('deferred', 'remote-write-capabilities-unavailable');
  });

  it('does not let manual runs bypass feedback gating', () => {
    runAutomationNow(automation.id);
    expectStopped('rejected', 'unknown-head');
  });
});
