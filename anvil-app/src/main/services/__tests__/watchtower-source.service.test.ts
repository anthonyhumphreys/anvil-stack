import { describe, expect, it } from 'vitest';
import type { AutomationDefinition, WatchtowerState } from '../../../shared/types.js';
import {
  buildExternalWatchtowerEvent,
  buildExternalWatchtowerEvents,
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

describe('PR feedback observation cursors', () => {
  const observe = (headSha: string, ids: string[] = []) => ({
    ...normaliseGitHubPullRequest({
      number: 42,
      title: 'Ship it',
      state: 'OPEN',
      url: 'https://github.com/anvil/app/pull/42',
      headRefOid: headSha,
    }),
    reviewComments: ids.map((id) => ({ id, body: `Feedback ${id}`, headSha })),
  });

  it('baselines existing comments and emits each new comment once across restart', () => {
    const baseline = observe('head-a', ['1']);
    const watch = { ...automation, watchEvent: 'pull_request.review_comment' as const };
    expect(buildExternalWatchtowerEvents(watch, { id: 'repo-1', name: 'app' }, baseline)).toEqual(
      [],
    );
    const state = JSON.parse(JSON.stringify(watchtowerStateFromObservation(baseline)));
    const changed = observe('head-a', ['1', '2', '3']);
    const events = buildExternalWatchtowerEvents(
      { ...watch, watchState: state },
      { id: 'repo-1', name: 'app' },
      changed,
    );
    expect(events).toHaveLength(2);
    expect(events[0].id).not.toEqual(events[1].id);
    expect(events[0].metadata).toMatchObject({
      headSha: 'head-a',
      feedback: { id: '2', headSha: 'head-a' },
    });
    expect(
      buildExternalWatchtowerEvents(
        { ...watch, watchState: watchtowerStateFromObservation(changed) },
        { id: 'repo-1', name: 'app' },
        changed,
      ),
    ).toEqual([]);
    // A crash before cursor advancement replays the same durable queue identities.
    expect(
      buildExternalWatchtowerEvents(
        { ...watch, watchState: state },
        { id: 'repo-1', name: 'app' },
        changed,
      ).map((event) => event.id),
    ).toEqual(events.map((event) => event.id));
  });

  it('observes head changes while the PR remains open, with distinct event identities', () => {
    const watch = {
      ...automation,
      watchEvent: 'pull_request.head_changed' as const,
      watchState: watchtowerStateFromObservation(observe('head-a')),
    };
    const events = buildExternalWatchtowerEvents(
      watch,
      { id: 'repo-1', name: 'app' },
      observe('head-b'),
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ previousHeadSha: 'head-a', headSha: 'head-b' });
    expect(events[0].id).not.toEqual(
      buildExternalWatchtowerEvents(watch, { id: 'repo-1', name: 'app' }, observe('head-c'))[0].id,
    );
    expect(
      buildExternalWatchtowerEvents(watch, { id: 'repo-1', name: 'app' }, observe('head-a')),
    ).toEqual([]);
  });

  it('baselines a changed target and cannot infer head changes from missing heads', () => {
    const watch = {
      ...automation,
      watchEvent: 'pull_request.head_changed' as const,
      watchState: {
        ...watchtowerStateFromObservation(observe('head-a')),
        sourceId: 'github-pr:99',
      },
    };
    expect(
      buildExternalWatchtowerEvents(watch, { id: 'repo-1', name: 'app' }, observe('head-b')),
    ).toEqual([]);
    expect(
      shouldTriggerWatchtowerObservation(
        'pull_request.head_changed',
        { ...watch.watchState, sourceId: 'github-pr:42', headSha: undefined },
        observe('head-b'),
      ),
    ).toBe(false);
  });
});
