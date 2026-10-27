import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../../../shared/types';
import { publicWorkflowRun } from '../workflow-public';

describe('publicWorkflowRun', () => {
  it('keeps candidate bytes and account authority in main without mutating the durable run', () => {
    const binding = {
      backendId: 'backend-1',
      baseUrl: 'https://backend.test',
      apiUrl: 'https://backend.test/v1',
      accountId: 'private-account',
      datasetEpoch: 'epoch-1',
    };
    const run: WorkflowRun = {
      id: 'run-1',
      templateId: 'template-1',
      templateName: 'Review',
      workspaceId: 'workspace-1',
      repoIds: ['repo-1'],
      nodes: [],
      edges: [],
      kickoff: 'Review current changes',
      status: 'completed',
      supervisorThreadId: 'supervisor-1',
      nodeRuns: [],
      createdAt: '2026-10-19T00:00:00.000Z',
      chatOrigin: {
        threadId: 'chat-1',
        requestId: 'request-1',
        fingerprint: 'fingerprint',
        reason: 'Review',
        destinations: { review: 'Build machine' },
        source: 'current-tracked',
        sourceBackend: binding,
      },
      remoteReviewBackend: binding,
      remoteReviewCandidates: [
        {
          version: 1,
          policyVersion: 'remote-review-candidate/v1',
          repositoryId: 'repo-1',
          baseCommit: 'a'.repeat(40),
          candidateTree: 'b'.repeat(40),
          candidateCommit: 'c'.repeat(40),
          patch: 'private candidate bytes',
          patchSha256: 'd'.repeat(64),
          commitObjectBase64: 'private-commit-object',
          includedPaths: ['source.ts'],
          fileCount: 1,
          totalFileBytes: 42,
        },
      ],
    };
    const view = publicWorkflowRun(run);
    expect(view.id).toBe(run.id);
    expect(view.chatOrigin?.source).toBe('current-tracked');
    expect(view).not.toHaveProperty('remoteReviewCandidates');
    expect(view).not.toHaveProperty('remoteReviewBackend');
    expect(view.chatOrigin).not.toHaveProperty('sourceBackend');
    expect(JSON.stringify(view)).not.toContain('private');
    expect(run.remoteReviewCandidates?.[0].patch).toBe('private candidate bytes');
    expect(run.chatOrigin?.sourceBackend).toBe(binding);
  });
});
