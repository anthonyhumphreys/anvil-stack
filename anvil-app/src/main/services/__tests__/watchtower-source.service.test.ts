import { describe, expect, it } from 'vitest';
import type { AutomationDefinition, WatchtowerState } from '../../../shared/types.js';
import {
  buildExternalWatchtowerEvent,
  normaliseGitHubPullRequest,
  normalisePipelineObservation,
  shouldTriggerWatchtowerObservation,
  watchtowerStateFromObservation,
} from '../watchtower-source.service.js';

const automation: AutomationDefinition = {
  id: 'automation-1',
  workspaceId: 'workspace-1',
  name: 'Merge follow-up',
  personaId: 'coder',
  prompt: 'Inspect what landed.',
  repoIds: ['repo-1'],
  triggerMode: 'watchtower',
  watchEvent: 'pull_request.merged',
  watchTarget: { repoId: 'repo-1', pullRequestNumber: 42 },
  scheduleCron: '0 9 * * 1-5',
  timezone: 'UTC',
  enabled: true,
  allowRepoWrite: false,
  allowCommandRun: false,
  executionMode: 'disposable-worktree',
  createdAt: '2026-08-10T09:00:00.000Z',
  updatedAt: '2026-08-10T09:00:00.000Z',
};

describe('Watchtower source transitions', () => {
  it('uses the first pull request observation as a baseline, then triggers on merge', () => {
    const open = normaliseGitHubPullRequest({
      number: 42,
      title: 'Ship it',
      state: 'OPEN',
      url: 'https://github.com/anvil/app/pull/42',
    });
    expect(shouldTriggerWatchtowerObservation('pull_request.merged', undefined, open)).toBe(false);

    const previous = watchtowerStateFromObservation(open);
    const merged = normaliseGitHubPullRequest({
      number: 42,
      title: 'Ship it',
      state: 'CLOSED',
      mergedAt: '2026-08-10T10:05:00.000Z',
      url: 'https://github.com/anvil/app/pull/42',
      mergeCommit: { oid: 'abc123' },
    });

    expect(shouldTriggerWatchtowerObservation('pull_request.merged', previous, merged)).toBe(true);
    expect(shouldTriggerWatchtowerObservation('pull_request.closed', previous, merged)).toBe(false);
    expect(
      buildExternalWatchtowerEvent(automation, { id: 'repo-1', name: 'app' }, merged),
    ).toMatchObject({
      type: 'pull_request.merged',
      sourceId: 'github-pr:42',
      repoIds: ['repo-1'],
      metadata: { mergeCommitSha: 'abc123' },
    });
  });

  it('distinguishes an unmerged close from a merge', () => {
    const previous: WatchtowerState = {
      sourceId: 'github-pr:42',
      status: 'open',
      observedAt: '2026-08-10T10:00:00.000Z',
    };
    const closed = normaliseGitHubPullRequest({
      number: 42,
      title: 'Do not ship',
      state: 'CLOSED',
      closedAt: '2026-08-10T10:05:00.000Z',
      url: 'https://github.com/anvil/app/pull/42',
    });

    expect(shouldTriggerWatchtowerObservation('pull_request.closed', previous, closed)).toBe(true);
    expect(shouldTriggerWatchtowerObservation('pull_request.merged', previous, closed)).toBe(false);
  });

  it('triggers completed and failed pipeline watches from terminal transitions', () => {
    const running = normalisePipelineObservation('github', {
      databaseId: 123,
      workflowName: 'CI',
      displayTitle: 'Test main',
      status: 'in_progress',
      url: 'https://github.com/anvil/app/actions/runs/123',
    });
    const previous = watchtowerStateFromObservation(running);
    const succeeded = normalisePipelineObservation('github', {
      databaseId: 123,
      workflowName: 'CI',
      displayTitle: 'Test main',
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/anvil/app/actions/runs/123',
    });
    const failed = normalisePipelineObservation('github', {
      databaseId: 123,
      workflowName: 'CI',
      displayTitle: 'Test main',
      status: 'completed',
      conclusion: 'failure',
      url: 'https://github.com/anvil/app/actions/runs/123',
    });

    expect(shouldTriggerWatchtowerObservation('pipeline.completed', previous, succeeded)).toBe(
      true,
    );
    expect(shouldTriggerWatchtowerObservation('pipeline.failed', previous, succeeded)).toBe(false);
    expect(shouldTriggerWatchtowerObservation('pipeline.failed', previous, failed)).toBe(true);
    expect(shouldTriggerWatchtowerObservation('pipeline.completed', previous, failed)).toBe(true);
    expect(
      shouldTriggerWatchtowerObservation(
        'pipeline.failed',
        watchtowerStateFromObservation(failed),
        failed,
      ),
    ).toBe(false);
  });
});
