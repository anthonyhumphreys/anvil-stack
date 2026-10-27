import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ settings: {} as Record<string, string> }));
vi.mock('../workitem-context.service.js', () => ({
  getWorkItemSettings: () => state.settings,
  getCachedWorkItems: () => null,
  getCachedWorkItem: () => null,
  cacheWorkItems: vi.fn(),
  cacheSingleWorkItem: vi.fn(),
  invalidateWorkItemsCache: vi.fn(),
}));
import {
  githubWorkItemsProvider as provider,
  githubIssueNumber,
  githubWorkItemTarget,
} from '../github-workitems.service.js';
import { publishWorkItemLink } from '../workitem-review-publication.service.js';
const issue = {
  number: 42,
  title: 'Fix widget',
  body: 'Description',
  state: 'open',
  labels: [{ name: 'bug' }],
  assignee: { login: 'alice' },
  milestone: { number: 2, title: 'Next' },
};
const response = (value: unknown) => ({ ok: true, json: async () => value });
beforeEach(() => {
  state.settings = {
    workItemProvider: 'github',
    githubOwner: 'Acme',
    githubRepo: 'Widgets',
    githubToken: 'connection-token',
    githubPat: 'unrelated-account',
  };
});
afterEach(() => vi.unstubAllGlobals());
describe('GitHub Work Items', () => {
  it('excludes pull requests, uses scoped canonical identities, and filters labels/milestones', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(response([issue, { ...issue, number: 43, pull_request: {} }]));
    vi.stubGlobal('fetch', fetch);
    const items = await provider.listItems({
      tags: ['bug'],
      iterationIds: ['2'],
      assignee: 'alice',
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'https://github.com/acme/widgets/issues/42',
      type: 'Bug',
      provider: 'github',
    });
    expect(fetch.mock.calls[0][0]).toContain('/repos/Acme/Widgets/issues?state=all');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer connection-token');
  });
  it('rejects bare numbers, wrong repositories/hosts and pull request lookups', async () => {
    for (const id of [
      '42',
      'https://github.com/other/widgets/issues/42',
      'https://other.example/acme/widgets/issues/42',
    ])
      expect(() => githubIssueNumber(id)).toThrow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...issue, pull_request: {} })));
    await expect(provider.getItem('https://github.com/acme/widgets/issues/42')).rejects.toThrow(
      'Pull requests',
    );
  });
  it('never falls back to the general GitHub token and rejects credential-bearing origins', () => {
    delete state.settings.githubToken;
    expect(() => githubWorkItemTarget()).toThrow('token');
    state.settings.githubToken = 'token';
    state.settings.githubHost = 'https://token@github.com';
    expect(() => githubWorkItemTarget()).toThrow('HTTPS origin');
  });
  it('supports enterprise APIs and creates without inventing parent relationships', async () => {
    state.settings.githubHost = 'https://github.example';
    const fetch = vi.fn().mockResolvedValue(response(issue));
    vi.stubGlobal('fetch', fetch);
    await expect(provider.createItem({ title: 'Fix', parentId: '42' })).rejects.toThrow(
      'not supported',
    );
    expect(fetch).not.toHaveBeenCalled();
    await provider.createItem({ title: ' Fix ', description: 'Details' });
    expect(fetch.mock.calls[0][0]).toBe('https://github.example/api/v3/repos/Acme/Widgets/issues');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ title: 'Fix', body: 'Details' });
  });
  it('keeps share fragments and runs the publication guard immediately before one POST', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(issue))
      .mockResolvedValueOnce(response({ id: 12 }));
    vi.stubGlobal('fetch', fetch);
    const guard = vi.fn();
    await publishWorkItemLink(
      'https://github.com/acme/widgets/issues/42',
      'Shared',
      'Thread',
      'https://mezair.example/artifacts/a#secret',
      guard,
    );
    expect(guard).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[1][0]).toContain('/issues/42/comments');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      body: 'Shared\n\n[Thread](https://mezair.example/artifacts/a#secret)',
    });
  });
  it('does not post if the guard rejects', async () => {
    const fetch = vi.fn().mockResolvedValue(response(issue));
    vi.stubGlobal('fetch', fetch);
    await expect(
      publishWorkItemLink(
        'https://github.com/acme/widgets/issues/42',
        'Shared',
        'Thread',
        'https://mezair.example/#key',
        () => {
          throw new Error('changed');
        },
      ),
    ).rejects.toThrow('changed');
    expect(fetch).toHaveBeenCalledOnce();
  });
});

it('rejects a response for another issue and dot path scopes', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...issue, number: 43 })));
  await expect(provider.getItem('https://github.com/acme/widgets/issues/42')).rejects.toThrow(
    'different issue',
  );
  state.settings.githubRepo = '..';
  expect(() => githubWorkItemTarget()).toThrow('owner and repository');
});

it('paginates before caching and maps milestones', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response(Array.from({ length: 100 }, (_, n) => ({ ...issue, number: n + 1 }))),
    )
    .mockResolvedValueOnce(response([{ ...issue, number: 101 }]))
    .mockResolvedValueOnce(response([{ number: 2, title: 'Next', due_on: '2026-12-01' }]));
  vi.stubGlobal('fetch', fetch);
  expect(await provider.listItems()).toHaveLength(101);
  expect(fetch.mock.calls[1][0]).toContain('page=2');
  expect(await provider.listIterations()).toEqual([
    { id: '2', name: 'Next', finishDate: '2026-12-01', provider: 'github' },
  ]);
});

it('rejects public GitHub hosts with a different origin port', () => {
  state.settings.githubHost = 'https://github.com:8443';
  expect(() => githubWorkItemTarget()).toThrow('HTTPS origin');
});
