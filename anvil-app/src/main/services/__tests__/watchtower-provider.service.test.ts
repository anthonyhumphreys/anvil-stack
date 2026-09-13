import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationDefinition } from '../../../shared/types.js';

const { execute, repoRow } = vi.hoisted(() => ({
  execute: vi.fn(),
  repoRow: { id: 'repo-1', name: 'app', remote_url: 'https://github.com/anvil/app.git' },
}));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => execute }));
vi.mock('../../db/database.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => repoRow }) }),
}));
vi.mock('../settings.service.js', () => ({ getSettings: () => ({}) }));
vi.mock('../code-review-pr.service.js', () => ({
  parseGitHubRemoteUrl: () => ({ owner: 'anvil', repo: 'app' }),
  parseAdoRemoteUrl: () => null,
}));
import { observeExternalWatchtowerSource } from '../watchtower-source.service.js';

const automation = {
  watchEvent: 'pull_request.review_comment',
  watchTarget: { repoId: 'repo-1', pullRequestNumber: 42 },
} as AutomationDefinition;
const pr = {
  number: 42,
  title: 'Ship',
  state: 'OPEN',
  url: 'https://github.com/anvil/app/pull/42',
  headRefOid: 'head-a',
};
const response = (value: unknown) => ({ stdout: JSON.stringify(value) });

beforeEach(() => execute.mockReset());

describe('GitHub feedback polling', () => {
  it('reads all pages and retains each review comment commit as evidence', async () => {
    execute
      .mockResolvedValueOnce(response(pr))
      .mockResolvedValueOnce(
        response([
          [{ id: 1, body: 'Old feedback', commit_id: 'head-old' }],
          [{ id: 2, body: 'Current feedback', commit_id: 'head-a' }],
        ]),
      )
      .mockResolvedValueOnce(response(pr));
    const { observation } = await observeExternalWatchtowerSource(automation);
    expect(observation.headSha).toBe('head-a');
    expect(observation.reviewComments).toMatchObject([
      { id: '1', headSha: 'head-old' },
      { id: '2', headSha: 'head-a' },
    ]);
    expect(execute.mock.calls[1][1]).toEqual([
      'api',
      '--paginate',
      '--slurp',
      'repos/anvil/app/pulls/42/comments?per_page=100',
    ]);
  });

  it('does not advance an observation when the head changes during polling', async () => {
    execute
      .mockResolvedValueOnce(response(pr))
      .mockResolvedValueOnce(response([[]]))
      .mockResolvedValueOnce(response({ ...pr, headRefOid: 'head-b' }));
    await expect(observeExternalWatchtowerSource(automation)).rejects.toThrow('head changed');
  });

  it('surfaces a provider failure instead of treating an unavailable response as no feedback', async () => {
    execute.mockResolvedValueOnce(response(pr)).mockRejectedValueOnce(new Error('API unavailable'));
    await expect(observeExternalWatchtowerSource(automation)).rejects.toThrow('API unavailable');
  });
});
