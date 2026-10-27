import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AutomationDefinition, WatchtowerEvent } from '../../../shared/types.js';

vi.mock('../watchtower-source.service.js', () => ({ observeExternalWatchtowerSource: vi.fn() }));
vi.mock('../code-review-pr.service.js', () => ({
  parseGitHubRemoteUrl: (url: string) => ({
    host: 'github.com',
    owner: 'acme',
    repo: url.includes('wrong') ? 'wrong' : 'repo',
  }),
  parseAdoRemoteUrl: () => null,
}));
import { observeExternalWatchtowerSource } from '../watchtower-source.service.js';
import {
  automationAccessMode,
  remotePublishingAllowed,
  remotePublishingInstructions,
  matchesRepairTarget,
  prepareAutomationRepairTarget,
  repairTargetInstructions,
} from '../automation-remote-publishing.service.js';

const definition: AutomationDefinition = {
  id: 'automation',
  workspaceId: 'workspace',
  name: 'Repair',
  personaId: 'coder',
  prompt: 'Fix review feedback',
  repoIds: ['repo'],
  triggerMode: 'watchtower',
  watchEvent: 'pull_request.head_changed',
  watchTarget: { repoId: 'repo', pullRequestNumber: 7 },
  scheduleCron: '* * * * *',
  timezone: 'UTC',
  enabled: true,
  allowRepoWrite: true,
  allowCommandRun: true,
  allowRemotePublishing: true,
  executionMode: 'disposable-worktree',
  createdAt: '',
  updatedAt: '',
};
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', ['-C', cwd, ...args])).stdout.trim();
let directory: string;
let repo: { id: string; path: string; remoteUrl: string };
let head: string;
let event: WatchtowerEvent;
const fresh = (overrides: Record<string, unknown> = {}) => ({
  repo: { id: 'repo', name: 'Repo' },
  observation: {
    sourceId: 'github-pr:7',
    sourceLabel: 'PR #7',
    status: 'open',
    headSha: head,
    observedAt: '',
    terminal: false,
    failed: false,
    metadata: { headBranch: 'feature/fix', isCrossRepository: false },
    ...overrides,
  },
});

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anvil-auto-publish-'));
  const remote = path.join(directory, 'remote.git');
  const work = path.join(directory, 'work');
  await fs.mkdir(work);
  await exec('git', ['init', '--bare', '-q', remote]);
  await git(work, 'init', '-q');
  await git(work, 'config', 'user.name', 'Test');
  await git(work, 'config', 'user.email', 'test@example.com');
  await fs.writeFile(path.join(work, 'file.txt'), 'original');
  await git(work, 'add', '.');
  await git(work, 'commit', '-qm', 'Initial');
  await git(work, 'branch', '-M', 'feature/fix');
  await git(work, 'remote', 'add', 'origin', remote);
  await git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/feature/fix');
  head = await git(work, 'rev-parse', 'HEAD');
  repo = { id: 'repo', path: work, remoteUrl: remote };
  event = {
    id: 'event',
    type: 'pull_request.head_changed',
    workspaceId: 'workspace',
    repoIds: ['repo'],
    sourceId: 'github-pr:7',
    sourceLabel: 'PR #7',
    occurredAt: '',
    metadata: { headSha: head },
  };
  vi.mocked(observeExternalWatchtowerSource).mockResolvedValue(fresh());
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('verified PR repair checkout', () => {
  it('fetches the exact remote head even when local HEAD contains unrelated work', async () => {
    await fs.writeFile(path.join(repo.path, 'unrelated.txt'), 'unrelated');
    await git(repo.path, 'add', '.');
    await git(repo.path, 'commit', '-qm', 'Unrelated local change');
    const localHead = await git(repo.path, 'rev-parse', 'HEAD');
    const target = await prepareAutomationRepairTarget(definition, event, repo, 'run-1');
    expect(target).toMatchObject({
      headSha: head,
      sourceBranch: 'feature/fix',
      pullRequestNumber: 7,
    });
    expect(await git(repo.path, 'rev-parse', 'HEAD')).toBe(localHead);
    expect(await git(repo.path, 'rev-parse', 'refs/anvil/automation/run-1')).toBe(head);
  });
  it.each([true, undefined])(
    'rejects fork or unverified source identity (%s)',
    async (isCrossRepository) => {
      vi.mocked(observeExternalWatchtowerSource).mockResolvedValue(
        fresh({ metadata: { headBranch: 'feature/fix', isCrossRepository } }),
      );
      await expect(prepareAutomationRepairTarget(definition, event, repo, 'run')).rejects.toThrow(
        'Fork pull requests',
      );
    },
  );
  it('rejects PRs closed since the queued observation', async () => {
    vi.mocked(observeExternalWatchtowerSource).mockResolvedValue(fresh({ status: 'closed' }));
    await expect(prepareAutomationRepairTarget(definition, event, repo, 'run')).rejects.toThrow(
      'no longer open',
    );
  });
  it('rejects a provider head that moves after fetch', async () => {
    vi.mocked(observeExternalWatchtowerSource)
      .mockResolvedValueOnce(fresh())
      .mockResolvedValueOnce(fresh({ headSha: 'b'.repeat(40) }));
    await expect(prepareAutomationRepairTarget(definition, event, repo, 'run')).rejects.toThrow(
      'head changed',
    );
  });
  it('rejects a fetched branch whose SHA does not match the observed PR', async () => {
    event.metadata!.headSha = 'b'.repeat(40);
    vi.mocked(observeExternalWatchtowerSource).mockResolvedValue(
      fresh({ headSha: 'b'.repeat(40) }),
    );
    await expect(prepareAutomationRepairTarget(definition, event, repo, 'run')).rejects.toThrow(
      'source branch moved',
    );
  });
  it('rejects changed checkout remote identity', async () => {
    await expect(
      prepareAutomationRepairTarget(
        definition,
        event,
        { ...repo, remoteUrl: 'https://github.com/wrong/repo' },
        'run',
      ),
    ).rejects.toThrow('origin no longer matches');
  });
  it('rejects another PR, repository, workspace, or claimed number', () => {
    for (const change of [
      { sourceId: 'github-pr:8' },
      { repoIds: ['other'] },
      { workspaceId: 'other' },
      { metadata: { pullRequestNumber: 8 } },
    ])
      expect(matchesRepairTarget(definition, { ...event, ...change })).toBe(false);
  });
  it('keeps shell syntax in valid branch names as quoted argument data', async () => {
    const sourceBranch = 'fix/$(touch${IFS}owned);echo';
    await git(repo.path, 'check-ref-format', `refs/heads/${sourceBranch}`);
    const instructions = repairTargetInstructions({
      repoId: 'repo',
      pullRequestNumber: 7,
      sourceId: 'github-pr:7',
      sourceBranch,
      headSha: head,
    });
    expect(instructions).toContain(
      JSON.stringify(['git', 'push', 'origin', `HEAD:refs/heads/${sourceBranch}`]),
    );
    expect(instructions).not.toContain(`git push origin HEAD:refs/heads/${sourceBranch}`);
    expect(instructions).toContain('not shell source');
  });
});

describe('publication authority', () => {
  it('requires all three flags and the current writable ceiling', () => {
    expect(remotePublishingAllowed(definition, 'workspace-auto')).toBe(true);
    for (const change of [
      { allowRemotePublishing: false },
      { allowRemotePublishing: undefined },
      { allowRepoWrite: false },
      { allowCommandRun: false },
    ])
      expect(
        remotePublishingAllowed(
          { ...definition, ...change } as AutomationDefinition,
          'full-access',
        ),
      ).toBe(false);
    expect(remotePublishingAllowed(definition, 'read-only')).toBe(false);
    expect(automationAccessMode({ allowRepoWrite: false }, 'full-access')).toBe('read-only');
  });
  it('never grants merge or force-push authority', () => {
    expect(remotePublishingInstructions(true)).toContain('Never merge pull requests');
    expect(remotePublishingInstructions(true)).toContain('force-push');
    expect(remotePublishingInstructions(false)).toContain('not authorised');
  });
});
