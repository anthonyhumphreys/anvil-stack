import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FactoryDefinition, FactoryRun } from '../../../shared/factories.js';
import {
  createGitHubFactoryProvider,
  type FactoryProviderDependencies,
} from '../factory-provider.service.js';

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);
const ID = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const root = '/tmp/anvil-factory-test';
const SAFE_DIFF =
  'diff --git a/src/main.ts b/src/main.ts\nindex 1111111..2222222 100644\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-const oldValue = false;\n+const safeValue = true;\n';
const MERGE_REQUEST_ID = '00000000-0000-0000-0000-000000000009';
const checkoutPath = path.join(root, ID('factory-1'), ID('run-1'));
const branch = `anvil/factory/${ID('factory-1')}/${ID('run-1')}`;
const exec = promisify(execFile);

function definition(overrides: Partial<FactoryDefinition['definition']> = {}): FactoryDefinition {
  return {
    id: 'factory-1',
    workspaceId: 'workspace-1',
    revision: 1,
    activeRevision: 1,
    status: 'active',
    ownerId: 'owner-1',
    accountScope: 'account-1',
    confirmation: 'approved',
    createdAt: '',
    updatedAt: '',
    workflow: {} as FactoryDefinition['workflow'],
    definition: {
      name: 'Issue factory',
      workspaceId: 'workspace-1',
      repoId: 'repo-1',
      github: {
        host: 'github.com',
        owner: 'acme',
        repo: 'demo',
        label: 'ready',
        baseBranch: 'main',
      },
      workflowTemplateId: 'workflow-1',
      criteria: ['The test suite passes'],
      checks: ['pnpm test'],
      postMergeChecks: [],
      limits: { repairRounds: 2, maxRunMinutes: 60, maxCommands: 20, maxConcurrentRuns: 2 },
      publication: { enabled: true, draft: false },
      merge: { mode: 'auto-merge', method: 'squash', requiredChecks: [], requireApproval: false },
      access: { kind: 'private' },
      ...overrides,
    },
  };
}

function run(overrides: Partial<FactoryRun> = {}): FactoryRun {
  const factory = definition();
  return {
    id: 'run-1',
    factoryId: factory.id,
    revision: 1,
    workspaceId: factory.workspaceId,
    snapshot: factory,
    issue: {
      number: 17,
      title: 'Fix a thing',
      body: '',
      url: 'https://github.com/acme/demo/issues/17',
      labels: ['ready'],
      state: 'open',
      createdAt: '',
      updatedAt: '',
    },
    stage: 'publishing',
    version: 4,
    repairRounds: 0,
    commandsUsed: 1,
    createdAt: '',
    updatedAt: '',
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    checkout: { path: checkoutPath, branch, baseSha: OTHER_HEAD },
    evidence: {
      headSha: HEAD,
      treeSha: TREE,
      criteria: [{ criterion: 'The test suite passes', status: 'passed', evidence: 'exit 0' }],
      commands: [],
      passed: true,
      checkedAt: '',
    },
    pullRequest: {
      number: 42,
      url: 'https://github.com/acme/demo/pull/42',
      headSha: HEAD,
      branch,
      baseBranch: 'main',
      draft: false,
    },
    receipts: [],
    ...overrides,
  };
}

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    html_url: 'https://github.com/acme/demo/pull/42',
    node_id: 'PR_node_42',
    body: `Closes #17\n\n<!-- anvil-factory-run:${ID('run-1')} -->`,
    title: 'Fix a thing (#17)',
    state: 'open',
    draft: false,
    merged: false,
    head: { sha: HEAD, ref: branch, repo: { full_name: 'acme/demo' } },
    base: { ref: 'main', repo: { full_name: 'acme/demo' } },
    ...overrides,
  };
}

function provider(
  command: FactoryProviderDependencies['command'],
  overrides: Partial<FactoryProviderDependencies> = {},
) {
  return createGitHubFactoryProvider({
    command,
    repoPath: () => '/repo',
    rootPath: () => root,
    validation: async () => [],
    verify: vi.fn(async () => ({
      approvalGranted: true,
      exitCode: 0,
      logTail: 'ok',
      timedOut: false,
    })) as unknown as FactoryProviderDependencies['verify'],
    currentMode: () => 'on-request',
    snapshot: (_cwd: string) => ({ head: HEAD, tree: TREE, status: '', capturedAt: '' }),
    ...overrides,
  });
}

function output<T>(value: T): string {
  return JSON.stringify(value);
}

function apiEndpoint(args: string[]): string {
  return args.find((arg) => arg === 'graphql' || arg.startsWith('repos/')) ?? '';
}

describe('GitHub factory provider', () => {
  it('reconciles a PR created before a lost response without creating a duplicate', async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const existing = pull();
    let createWasAccepted = false;
    let createAttempts = 0;
    const io = provider(async (executable, args) => {
      calls.push({ executable, args });
      if (executable === 'git' && args.includes('remote') && args.includes('get-url'))
        return 'git@github.com:acme/demo.git';
      if (executable === 'git' && args.includes('symbolic-ref')) return branch;
      if (executable === 'git' && args.includes('rev-parse') && args.at(-1) === 'HEAD') return HEAD;
      if (executable === 'git' && args.at(-1) === 'HEAD^{tree}') return TREE;
      if (executable === 'git' && args.includes('status')) return '';
      if (executable === 'git' && args.includes('diff')) return SAFE_DIFF;
      if (
        executable === 'gh' &&
        args[0] === 'api' &&
        apiEndpoint(args).startsWith('repos/acme/demo/pulls?')
      )
        return output(createWasAccepted ? [existing] : []);
      if (
        executable === 'gh' &&
        args[0] === 'api' &&
        apiEndpoint(args) === 'repos/acme/demo/pulls' &&
        args.includes('POST')
      ) {
        createAttempts += 1;
        createWasAccepted = true;
        throw new Error('Response lost after GitHub accepted the PR creation.');
      }
      if (executable === 'gh' && apiEndpoint(args) === 'repos/acme/demo/pulls/42')
        return output(existing);
      return '';
    });

    await expect(io.publishPullRequest(definition(), run(), 'intent-1')).rejects.toThrow(
      /accepted the PR creation/i,
    );
    const result = await io.publishPullRequest(definition(), run(), 'intent-1');

    expect(result).toMatchObject({ number: 42, headSha: HEAD, branch, draft: false });
    expect(createAttempts).toBe(1);
    expect(
      calls.filter(({ executable, args }) => executable === 'git' && args.includes('push')),
    ).toHaveLength(2);
  });

  it('rejects publication when the found PR head does not match the verified checkout', async () => {
    const changed = pull({
      head: { sha: OTHER_HEAD, ref: branch, repo: { full_name: 'acme/demo' } },
    });
    const io = provider(async (executable, args) => {
      if (executable === 'git' && args.includes('rev-parse') && args.at(-1) === 'HEAD') return HEAD;
      if (executable === 'git' && args.at(-1) === 'HEAD^{tree}') return TREE;
      if (executable === 'git' && args.includes('status')) return '';
      if (executable === 'git' && args.includes('diff')) return SAFE_DIFF;
      if (executable === 'git' && args.includes('remote') && args.includes('get-url'))
        return 'git@github.com:acme/demo.git';
      if (executable === 'git' && args.includes('symbolic-ref')) return branch;
      if (executable === 'gh' && apiEndpoint(args).startsWith('repos/acme/demo/pulls?'))
        return output([changed]);
      if (executable === 'gh' && apiEndpoint(args) === 'repos/acme/demo/pulls/42')
        return output(changed);
      return '';
    });
    await expect(io.publishPullRequest(definition(), run(), 'intent-1')).rejects.toThrow(
      /head does not match/i,
    );
  });

  it('blocks a candidate containing a credential already held by Anvil before any remote mutation', async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const secret = 'factory-known-secret-value-123';
    const io = provider(
      async (executable, args) => {
        calls.push({ executable, args });
        if (executable === 'git' && args.includes('remote') && args.includes('get-url'))
          return 'git@github.com:acme/demo.git';
        if (executable === 'git' && args.includes('symbolic-ref')) return branch;
        if (executable === 'git' && args.includes('rev-parse') && args.at(-1) === 'HEAD')
          return HEAD;
        if (executable === 'git' && args.at(-1) === 'HEAD^{tree}') return TREE;
        if (executable === 'git' && args.includes('status')) return '';
        if (executable === 'git' && args.includes('diff'))
          return SAFE_DIFF.replace('safeValue', secret);
        return '';
      },
      { knownSecrets: async () => [secret] },
    );

    await expect(io.publishPullRequest(definition(), run(), 'intent-1')).rejects.toThrow(
      /secret-like content/i,
    );
    expect(
      calls.some(({ executable, args }) => executable === 'git' && args.includes('push')),
    ).toBe(false);
    expect(calls.some(({ executable, args }) => executable === 'gh' && args.includes('POST'))).toBe(
      false,
    );
  });

  it('reports required check and human review failures and pins observations to the PR head', async () => {
    const calls: string[] = [];
    const io = provider(async (_executable, args) => {
      if (args[0] !== 'api') return '';
      const endpoint = apiEndpoint(args);
      calls.push(endpoint);
      if (endpoint === 'graphql')
        return output({
          data: { node: { isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null } },
        });
      if (/\/pulls\/42(?:\?|$)/.test(endpoint)) return output(pull());
      if (endpoint.includes('/check-runs'))
        return output({ check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] });
      if (endpoint.includes('/status')) return output({ statuses: [] });
      if (endpoint.includes('/reviews')) return output([]);
      if (endpoint.includes('/rules/branches/')) return output([]);
      if (endpoint.includes('/comments')) return output([]);
      return output({});
    });
    const factory = definition({
      merge: {
        mode: 'human-approved',
        method: 'squash',
        requiredChecks: ['ci'],
        requireApproval: true,
      },
    });

    const observation = await io.readPullRequest(factory, run());
    expect(observation.headSha).toBe(HEAD);
    expect(observation.checks).toEqual([{ name: 'ci', headSha: HEAD, status: 'failed' }]);
    expect(observation.review).toBe('pending');
    expect(
      calls.filter((endpoint) => /^repos\/acme\/demo\/pulls\/42$/.test(endpoint)),
    ).toHaveLength(2);
    await expect(
      io.requestMerge(factory, run({ snapshot: factory, mergeApprovalHead: HEAD }), 'merge-1'),
    ).rejects.toThrow(/checks or reviews/i);
  });

  it('marks draft PR ready before merge and treats an asynchronous queue response as not merged', async () => {
    const calls: string[] = [];
    let pullReads = 0;
    const io = provider(async (executable, args) => {
      if (executable === 'gh' && args[0] === 'pr' && args[1] === 'ready') {
        calls.push('ready');
        return '';
      }
      if (executable !== 'gh' || args[0] !== 'api') return '';
      const endpoint = apiEndpoint(args);
      if (endpoint.includes('/merge-async')) {
        calls.push('merge');
        return output({ status: 'enqueued', details: { uuid: MERGE_REQUEST_ID } });
      }
      if (endpoint === 'graphql')
        return output({
          data: { node: { isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null } },
        });
      if (/\/pulls\/42(?:\?|$)/.test(endpoint)) {
        pullReads += 1;
        return output(pull({ draft: pullReads === 1 }));
      }
      if (endpoint.includes('/check-runs')) return output({ check_runs: [] });
      if (endpoint.includes('/status')) return output({ statuses: [] });
      if (
        endpoint.includes('/reviews') ||
        endpoint.includes('/comments') ||
        endpoint.includes('/rules/branches/')
      )
        return output([]);
      return output({});
    });
    const factory = definition({
      merge: { mode: 'auto-merge', method: 'squash', requiredChecks: [], requireApproval: false },
    });

    const result = await io.requestMerge(factory, run({ snapshot: factory }), 'merge-1');

    expect(calls).toEqual(['ready', 'merge']);
    expect(result).toMatchObject({
      providerRequestId: MERGE_REQUEST_ID,
      requestedHeadSha: HEAD,
      state: 'queued',
    });
    expect(result.mergeCommitSha).toBeUndefined();
  });

  it('rejects an accepted asynchronous merge request without a valid request UUID', async () => {
    const factory = definition();
    const io = provider(async (executable, args) => {
      if (executable !== 'gh' || args[0] !== 'api') return '';
      const endpoint = apiEndpoint(args);
      if (endpoint === 'graphql')
        return output({
          data: { node: { isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null } },
        });
      if (/\/pulls\/42(?:\?|$)/.test(endpoint)) return output(pull());
      if (endpoint.includes('/check-runs')) return output({ check_runs: [] });
      if (endpoint.includes('/status')) return output({ statuses: [] });
      if (
        endpoint.includes('/reviews') ||
        endpoint.includes('/comments') ||
        endpoint.includes('/rules/branches/')
      )
        return output([]);
      if (endpoint.endsWith('/merge-async'))
        return output({ status: 'pending', details: { uuid: '../bad-id' } });
      return output({});
    });

    await expect(io.requestMerge(factory, run({ snapshot: factory }), 'merge-1')).rejects.toThrow(
      /without a valid request identifier/i,
    );
  });

  it('accepts an enqueued merge without a request UUID only when GraphQL confirms its queue entry', async () => {
    const factory = definition();
    const io = provider(async (executable, args) => {
      if (executable !== 'gh' || args[0] !== 'api') return '';
      const endpoint = apiEndpoint(args);
      if (endpoint === 'graphql')
        return output({
          data: {
            node: {
              isInMergeQueue: true,
              mergeQueueEntry: { id: 'entry-1' },
              autoMergeRequest: null,
            },
          },
        });
      if (/\/pulls\/42(?:\?|$)/.test(endpoint)) return output(pull());
      if (endpoint.includes('/check-runs')) return output({ check_runs: [] });
      if (endpoint.includes('/status')) return output({ statuses: [] });
      if (
        endpoint.includes('/reviews') ||
        endpoint.includes('/comments') ||
        endpoint.includes('/rules/branches/')
      )
        return output([]);
      if (endpoint.endsWith('/merge-async')) return output({ status: 'enqueued' });
      return output({});
    });

    await expect(
      io.requestMerge(factory, run({ snapshot: factory }), 'merge-1'),
    ).resolves.toMatchObject({ requestedHeadSha: HEAD, state: 'queued' });
  });

  it('rejects an observation if the PR head changes during the provider reads', async () => {
    let pullReads = 0;
    const io = provider(async (executable, args) => {
      if (executable !== 'gh' || args[0] !== 'api') return '';
      const endpoint = apiEndpoint(args);
      if (endpoint === 'graphql')
        return output({
          data: { node: { isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null } },
        });
      if (/\/pulls\/42(?:\?|$)/.test(endpoint)) {
        pullReads += 1;
        return output(
          pull({
            head: {
              sha: pullReads === 1 ? HEAD : OTHER_HEAD,
              ref: branch,
              repo: { full_name: 'acme/demo' },
            },
          }),
        );
      }
      if (endpoint.includes('/check-runs')) return output({ check_runs: [] });
      if (endpoint.includes('/status')) return output({ statuses: [] });
      if (
        endpoint.includes('/reviews') ||
        endpoint.includes('/comments') ||
        endpoint.includes('/rules/branches/')
      )
        return output([]);
      return output({});
    });

    await expect(io.readPullRequest(definition(), run())).rejects.toThrow(
      /head changed while observing/i,
    );
  });

  it('treats cancellation as a no-op when the provider has no queued or auto-merge request', async () => {
    const calls: string[] = [];
    const io = provider(async (executable, args) => {
      if (executable === 'gh' && args[0] === 'api') calls.push(apiEndpoint(args));
      if (
        executable === 'gh' &&
        args[0] === 'api' &&
        apiEndpoint(args) === 'repos/acme/demo/pulls/42'
      )
        return output(pull());
      if (executable === 'gh' && args[0] === 'api' && apiEndpoint(args) === 'graphql')
        return output({
          data: { node: { isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null } },
        });
      return '';
    });

    await expect(io.cancelMerge(definition(), run(), 'cancel-1')).resolves.toBeUndefined();
    expect(calls).toEqual(['repos/acme/demo/pulls/42', 'graphql']);
  });

  it('reconciles an enqueued async merge, dequeues the GraphQL entry and confirms it cleared', async () => {
    const graphql: string[] = [];
    let queued = true;
    const endpoints: string[] = [];
    const io = provider(async (executable, args) => {
      const endpoint = apiEndpoint(args);
      if (executable === 'gh' && args[0] === 'api') endpoints.push(endpoint);
      if (executable === 'gh' && args[0] === 'api' && endpoint === 'repos/acme/demo/pulls/42')
        return output(pull({ mergeable_state: 'clean' }));
      if (
        executable === 'gh' &&
        args[0] === 'api' &&
        endpoint.endsWith(`/merge-async/${MERGE_REQUEST_ID}`)
      )
        return output({ status: 'enqueued' });
      if (executable === 'gh' && args[0] === 'api' && endpoint === 'graphql') {
        const query = String(
          args.find((arg) => arg.includes('mutation(') || arg.includes('query(')),
        );
        graphql.push(query);
        if (query.includes('mutation(')) {
          queued = false;
          return output({ data: { dequeuePullRequest: { mergeQueueEntry: { id: 'entry-1' } } } });
        }
        return output({
          data: {
            node: {
              isInMergeQueue: queued,
              mergeQueueEntry: queued ? { id: 'entry-1' } : null,
              autoMergeRequest: null,
            },
          },
        });
      }
      return '';
    });

    await io.cancelMerge(
      definition(),
      run({
        mergeReceipt: {
          state: 'requested',
          providerRequestId: MERGE_REQUEST_ID,
          requestedHeadSha: HEAD,
        },
      }),
      'cancel-1',
    );
    expect(endpoints).toContain(`repos/acme/demo/pulls/42/merge-async/${MERGE_REQUEST_ID}`);
    const mutation = graphql.find((query) => query.includes('mutation('));
    expect(mutation).toContain('dequeuePullRequest');
    expect(mutation).toContain('mergeQueueEntry{id}');
    expect(mutation).not.toContain('pullRequest{id}');
    expect(graphql.filter((query) => query.includes('query('))).toHaveLength(2);
  });

  it('keeps an in-flight asynchronous merge uncertain instead of claiming cancellation', async () => {
    const calls: string[] = [];
    const io = provider(async (executable, args) => {
      if (executable !== 'gh' || args[0] !== 'api') return '';
      const endpoint = apiEndpoint(args);
      calls.push(endpoint);
      if (endpoint === 'repos/acme/demo/pulls/42') return output(pull());
      if (endpoint.endsWith(`/merge-async/${MERGE_REQUEST_ID}`))
        return output({ status: 'pending' });
      return '';
    });

    await expect(
      io.cancelMerge(
        definition(),
        run({
          mergeReceipt: {
            state: 'requested',
            providerRequestId: MERGE_REQUEST_ID,
            requestedHeadSha: HEAD,
          },
        }),
        'cancel-1',
      ),
    ).rejects.toThrow(/cancellation is uncertain/i);
    expect(calls).toEqual([
      'repos/acme/demo/pulls/42',
      `repos/acme/demo/pulls/42/merge-async/${MERGE_REQUEST_ID}`,
    ]);
  });

  it('refuses to repair when the provider PR has moved beyond the retained checkout head', async () => {
    const io = provider(async (executable, args) => {
      if (executable === 'git' && args.includes('check-ref-format')) return '';
      if (executable === 'git' && args.includes('remote') && args.includes('get-url'))
        return 'git@github.com:acme/demo.git';
      if (executable === 'git' && args.includes('fetch')) return '';
      if (
        executable === 'git' &&
        args.includes('rev-parse') &&
        args.at(-1)?.includes('refs/anvil/factory')
      )
        return OTHER_HEAD;
      if (executable === 'git' && args.includes('symbolic-ref')) return branch;
      if (executable === 'git' && args.includes('rev-parse') && args.at(-1) === 'HEAD') return HEAD;
      if (
        executable === 'gh' &&
        args[0] === 'api' &&
        apiEndpoint(args) === 'repos/acme/demo/pulls/42'
      )
        return output(
          pull({ head: { sha: OTHER_HEAD, ref: branch, repo: { full_name: 'acme/demo' } } }),
        );
      return '';
    });

    await expect(io.prepareCheckout(definition(), run(), 'repair-1')).rejects.toThrow(
      /head moved/i,
    );
  });

  it('clamps full-access settings to the factory workspace sandbox for verification', async () => {
    const verify = vi.fn(async () => ({
      repositoryId: 'repo-1',
      command: 'pnpm test',
      approvalGranted: true,
      exitCode: 0,
      logTail: 'ok',
      timedOut: false,
      durationMs: 1,
    }));
    const candidateMarker = `Anvil factory candidate ${ID('run-1')} ${ID('factory:run-1:verify:0')}`;
    let statusReads = 0;
    const io = provider(
      async (executable, args) => {
        if (executable === 'git' && args.includes('remote') && args.includes('get-url'))
          return 'git@github.com:acme/demo.git';
        if (executable === 'git' && args.includes('symbolic-ref')) return branch;
        if (executable === 'git' && args.includes('status'))
          return ++statusReads === 1 ? ' M src/main.ts' : '';
        if (executable === 'git' && args.includes('diff') && args.includes('--cached'))
          return SAFE_DIFF;
        if (executable === 'git' && args.includes('diff')) return SAFE_DIFF;
        if (executable === 'git' && args.includes('show')) return candidateMarker;
        if (executable === 'git' && args.includes('rev-parse') && args.at(-1) === 'HEAD^')
          return OTHER_HEAD;
        if (executable === 'git' && args.includes('rev-parse') && args.at(-1) === 'HEAD^{commit}')
          return HEAD;
        if (executable === 'git' && args.includes('rev-parse') && args.at(-1) === 'HEAD')
          return HEAD;
        if (executable === 'git' && args.at(-1) === 'HEAD^{tree}') return TREE;
        return '';
      },
      { currentMode: () => 'full-access', verify },
    );

    const evidence = await io.verifyCheckout(
      definition(),
      run({ pullRequest: undefined }),
      'verify-1',
    );

    expect(evidence.passed).toBe(true);
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: 'workspace-auto',
        repositoryId: 'repo-1',
        command: 'pnpm test',
      }),
    );
  });

  it('runs activation-reviewed checks unattended in workspace-auto but keeps an explicit read-only ceiling', async () => {
    for (const scenario of [
      { mode: 'on-request' as const, expected: 'workspace-auto', approvalGranted: true },
      { mode: 'read-only' as const, expected: 'read-only', approvalGranted: false },
    ]) {
      let statusReads = 0;
      const verify = vi.fn(async () => ({
        repositoryId: 'repo-1',
        command: 'pnpm test',
        approvalGranted: scenario.approvalGranted,
        exitCode: 0,
        logTail: 'ok',
        timedOut: false,
        durationMs: 1,
      }));
      const candidateMarker = `Anvil factory candidate ${ID('run-1')} ${ID('factory:run-1:verify:0')}`;
      const io = provider(
        async (executable, args) => {
          if (executable === 'git' && args.includes('remote') && args.includes('get-url'))
            return 'git@github.com:acme/demo.git';
          if (executable === 'git' && args.includes('symbolic-ref')) return branch;
          if (executable === 'git' && args.includes('status'))
            return ++statusReads === 1 ? ' M src/main.ts' : '';
          if (executable === 'git' && args.includes('diff') && args.includes('--cached'))
            return SAFE_DIFF;
          if (executable === 'git' && args.includes('diff')) return SAFE_DIFF;
          if (executable === 'git' && args.includes('show')) return candidateMarker;
          if (executable === 'git' && args.includes('rev-parse') && args.at(-1) === 'HEAD^')
            return OTHER_HEAD;
          if (executable === 'git' && args.includes('rev-parse') && args.at(-1) === 'HEAD^{commit}')
            return HEAD;
          if (executable === 'git' && args.includes('rev-parse') && args.at(-1) === 'HEAD')
            return HEAD;
          if (executable === 'git' && args.at(-1) === 'HEAD^{tree}') return TREE;
          return '';
        },
        { currentMode: () => scenario.mode, verify },
      );

      const evidence = await io.verifyCheckout(
        definition(),
        run({ pullRequest: undefined }),
        `verify-${scenario.mode}`,
      );

      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({ permissionMode: scenario.expected }),
      );
      expect(evidence.passed).toBe(scenario.approvalGranted);
    }
  });

  it('scans the complete staged candidate against stored credentials before committing it', async () => {
    const secret = 'factory-staged-secret-value-123';
    const calls: string[][] = [];
    const verify = vi.fn(async () => ({
      repositoryId: 'repo-1',
      command: 'pnpm test',
      approvalGranted: true,
      exitCode: 0,
      logTail: 'ok',
      timedOut: false,
      durationMs: 1,
    }));
    const io = provider(
      async (executable, args) => {
        if (executable !== 'git') return '';
        calls.push(args);
        if (args.includes('remote') && args.includes('get-url'))
          return 'git@github.com:acme/demo.git';
        if (args.includes('symbolic-ref')) return branch;
        if (args.includes('status')) return ' M src/main.ts';
        if (args.includes('--cached')) return SAFE_DIFF.replace('safeValue', secret);
        return '';
      },
      { knownSecrets: async () => [secret], verify },
    );

    await expect(io.verifyCheckout(definition(), run(), 'verify-secret')).rejects.toThrow(
      /secret-like content/i,
    );
    expect(calls.some((args) => args.includes('commit'))).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  it('seals each repair as a child of the prior verified PR head while scanning from the original base', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anvil-factory-repair-'));
    const repo = path.join(tempRoot, 'repo');
    const bare = path.join(tempRoot, 'remote.git');
    const factory = definition();
    const checkResults = [1, 0, 0];
    let checkIndex = 0;
    const runGit = async (cwd: string, ...args: string[]) =>
      (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout.trim();

    try {
      await fs.mkdir(repo, { recursive: true });
      await fs.mkdir(bare, { recursive: true });
      await runGit(bare, 'init', '--bare');
      await runGit(repo, 'init', '-b', 'main');
      await runGit(repo, 'config', 'user.name', 'Factory Test');
      await runGit(repo, 'config', 'user.email', 'factory-test@example.invalid');
      await runGit(repo, 'remote', 'add', 'origin', bare);
      await fs.writeFile(path.join(repo, 'src.ts'), 'export const value = "base";\n');
      await runGit(repo, 'add', '--all');
      await runGit(repo, 'commit', '-m', 'base');
      await runGit(repo, 'push', '-u', 'origin', 'main');
      const baseSha = await runGit(repo, 'rev-parse', 'HEAD');
      const worktreeRoot = path.join(tempRoot, 'worktrees');
      const checkout = path.join(worktreeRoot, ID(factory.id), ID('run-1'));
      await fs.mkdir(path.dirname(checkout), { recursive: true });
      await runGit(repo, 'worktree', 'add', '-b', branch, checkout, baseSha);
      const controllerGitArgs: string[][] = [];

      const io = createGitHubFactoryProvider({
        async command(executable, args) {
          if (executable === 'git') controllerGitArgs.push(args);
          if (executable === 'git' && args.includes('remote') && args.includes('get-url'))
            return 'git@github.com:acme/demo.git';
          return (await exec(executable, args, { encoding: 'utf8' })).stdout.trim();
        },
        repoPath: () => repo,
        rootPath: () => worktreeRoot,
        validation: async () => [],
        verify: vi.fn(async () => ({
          repositoryId: 'repo-1',
          command: 'pnpm test',
          approvalGranted: true,
          exitCode: checkResults[checkIndex++],
          logTail: 'check output',
          timedOut: false,
          durationMs: 1,
        })) as unknown as FactoryProviderDependencies['verify'],
        currentMode: () => 'workspace-auto',
        snapshot: (cwd) => ({
          head: execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          tree: execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD^{tree}'], {
            encoding: 'utf8',
          }).trim(),
          status: execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
            encoding: 'utf8',
          }).trim(),
          capturedAt: new Date().toISOString(),
        }),
        knownSecrets: async () => [],
      });

      const initialRun = run({
        checkout: { path: checkout, branch, baseSha },
        pullRequest: undefined,
      });
      await fs.writeFile(
        path.join(checkout, 'src.ts'),
        'export const value = "first candidate";\n',
      );
      const firstEvidence = await io.verifyCheckout(factory, initialRun, 'verify-0');
      expect(firstEvidence.passed).toBe(false);
      expect(await runGit(checkout, 'rev-parse', 'HEAD^')).toBe(baseSha);
      const commitArgs = controllerGitArgs.find((args) => args.includes('commit'));
      expect(commitArgs).toContain('commit.gpgSign=false');
      expect(commitArgs).toContain('tag.gpgSign=false');
      expect(commitArgs).toContain(
        `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      );

      await fs.writeFile(
        path.join(checkout, 'src.ts'),
        'export const value = "corrected candidate";\n',
      );
      const repairedRun = { ...initialRun, repairRounds: 1, evidence: firstEvidence };
      const secondEvidence = await io.verifyCheckout(factory, repairedRun, 'verify-1');
      expect(secondEvidence.passed).toBe(true);
      expect(await runGit(checkout, 'rev-parse', 'HEAD^')).toBe(firstEvidence.headSha);

      const pullRun: FactoryRun = {
        ...repairedRun,
        repairRounds: 2,
        evidence: undefined,
        pullRequest: {
          number: 42,
          url: 'https://github.com/acme/demo/pull/42',
          headSha: secondEvidence.headSha,
          branch,
          baseBranch: 'main',
          draft: false,
        },
      };
      await fs.writeFile(
        path.join(checkout, 'src.ts'),
        'export const value = "PR review correction";\n',
      );
      const pullRepairEvidence = await io.verifyCheckout(factory, pullRun, 'verify-2');
      expect(pullRepairEvidence.passed).toBe(true);
      expect(await runGit(checkout, 'rev-parse', 'HEAD^')).toBe(secondEvidence.headSha);
      expect(await runGit(checkout, 'rev-parse', 'HEAD~3')).toBe(baseSha);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
