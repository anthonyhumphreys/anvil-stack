import { describe, expect, it } from 'vitest';
import type { RepoInfo, WorkspaceScaffoldSession } from '../../../shared/types';
import {
  computeFeatureAvailability,
  readInitialWorkspaceIdFromLocation,
  repoIsMapped,
  shouldApplyWorkspaceLoad,
} from '../WorkspaceContext';

describe('readInitialWorkspaceIdFromLocation', () => {
  it('reads workspace ids from hash router search params', () => {
    expect(
      readInitialWorkspaceIdFromLocation({
        hash: '#/repos?workspaceId=workspace-123',
        search: '',
      }),
    ).toBe('workspace-123');
  });

  it('falls back to top-level search params', () => {
    expect(
      readInitialWorkspaceIdFromLocation({
        hash: '#/repos',
        search: '?workspaceId=workspace-456',
      }),
    ).toBe('workspace-456');
  });

  it('prefers hash router workspace ids over top-level params', () => {
    expect(
      readInitialWorkspaceIdFromLocation({
        hash: '#/repos?workspaceId=hash-workspace',
        search: '?workspaceId=top-level-workspace',
      }),
    ).toBe('hash-workspace');
  });
});

describe('shouldApplyWorkspaceLoad', () => {
  it('accepts only the latest response for the desired workspace', () => {
    expect(shouldApplyWorkspaceLoad(3, 3, 'workspace-b', 'workspace-b')).toBe(true);
    expect(shouldApplyWorkspaceLoad(2, 3, 'workspace-b', 'workspace-b')).toBe(false);
    expect(shouldApplyWorkspaceLoad(3, 3, 'workspace-a', 'workspace-b')).toBe(false);
  });
});

function repo(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    id: 'repo-1',
    name: 'demo',
    path: '/code/demo',
    defaultBranch: 'main',
    languages: [],
    status: 'connected',
    fileCount: 0,
    branchCount: 1,
    ...overrides,
  };
}

function scaffold(status: WorkspaceScaffoldSession['status']): WorkspaceScaffoldSession {
  return {
    id: 's-1',
    workspaceId: 'w-1',
    rootPath: '/tmp',
    personaId: 'p-1',
    status,
    createdAt: '',
    updatedAt: '',
  };
}

const hydrated = {
  scaffoldSession: null,
  activeJobRepoIds: new Set<string>(),
  failedJobRepoIds: new Set<string>(),
  jobsHydrated: true,
};

describe('repoIsMapped', () => {
  it('is true for mapped/enriched tiers and legacy indexed status', () => {
    expect(repoIsMapped(repo({ indexTier: 'mapped' }))).toBe(true);
    expect(repoIsMapped(repo({ indexTier: 'enriched' }))).toBe(true);
    expect(repoIsMapped(repo({ status: 'indexed' }))).toBe(true);
    expect(repoIsMapped(repo({ indexTier: 'connected' }))).toBe(false);
    expect(repoIsMapped(repo({}))).toBe(false);
  });
});

describe('computeFeatureAvailability', () => {
  it('reports empty when the workspace has no repositories', () => {
    const result = computeFeatureAvailability({ ...hydrated, repos: [] });
    expect(result.statusLabel).toBe('empty');
    expect(result.chatEnabled).toBe(true);
    expect(result.repoFeaturesEnabled).toBe(false);
  });

  it('enables chat outside scaffold mode even with nothing indexed', () => {
    const result = computeFeatureAvailability({
      ...hydrated,
      repos: [repo()],
    });
    expect(result.chatEnabled).toBe(true);
    expect(result.statusLabel).toBe('needs-attention');
  });

  it('reports preparing while an index job is queued or running', () => {
    const result = computeFeatureAvailability({
      ...hydrated,
      repos: [repo()],
      activeJobRepoIds: new Set(['repo-1']),
    });
    expect(result.statusLabel).toBe('preparing');
    expect(result.repoFeaturesEnabled).toBe(false);
  });

  it('keeps repo features enabled when a mapped repo coexists with active work', () => {
    const result = computeFeatureAvailability({
      ...hydrated,
      repos: [repo({ indexTier: 'mapped' }), repo({ id: 'repo-2' })],
      activeJobRepoIds: new Set(['repo-2']),
    });
    expect(result.statusLabel).toBe('preparing');
    expect(result.repoFeaturesEnabled).toBe(true);
  });

  it('reports ready once any repo reaches the mapped tier', () => {
    const result = computeFeatureAvailability({
      ...hydrated,
      repos: [repo({ indexTier: 'mapped' })],
    });
    expect(result.statusLabel).toBe('ready');
    expect(result.repoFeaturesEnabled).toBe(true);
  });

  it('reports needs-attention when indexing failed and nothing is mapped', () => {
    const result = computeFeatureAvailability({
      ...hydrated,
      repos: [repo({ status: 'error' })],
    });
    expect(result.statusLabel).toBe('needs-attention');
    expect(result.repoFeatureReason).toContain('failed');
  });

  it('reports preparing instead of needs-attention before jobs hydrate', () => {
    const result = computeFeatureAvailability({
      ...hydrated,
      repos: [repo()],
      jobsHydrated: false,
    });
    expect(result.statusLabel).toBe('preparing');
  });

  it('keeps chat enabled and reports scaffolding for an active scaffold session', () => {
    const result = computeFeatureAvailability({
      ...hydrated,
      repos: [repo()],
      scaffoldSession: scaffold('active'),
    });
    expect(result.statusLabel).toBe('scaffolding');
    expect(result.chatEnabled).toBe(true);
    expect(result.repoFeaturesEnabled).toBe(false);
  });

  it('exposes a reason while scaffold indexing runs before any repo is mapped', () => {
    const result = computeFeatureAvailability({
      ...hydrated,
      repos: [repo()],
      scaffoldSession: scaffold('indexing'),
    });
    expect(result.statusLabel).toBe('indexing');
    expect(result.repoFeaturesEnabled).toBe(false);
    expect(result.repoFeatureReason).toBeTruthy();
  });
});
