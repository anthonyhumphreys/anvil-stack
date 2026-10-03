import { describe, expect, it } from 'vitest';
import type { RepoInfo } from '../../../shared/types';
import { getStarterPrompts } from '../starter-prompts';

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

describe('getStarterPrompts', () => {
  it('always returns at least the generic prompt', () => {
    const prompts = getStarterPrompts({ repos: [] });
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[prompts.length - 1].label).toBe('What can you do?');
  });

  it('names a mapped repo in repo-scoped prompts', () => {
    const prompts = getStarterPrompts({
      repos: [repo({ indexTier: 'mapped', name: 'api' })],
    });
    expect(prompts.some((p) => p.prompt.includes('api'))).toBe(true);
  });

  it('falls back to the first repo when nothing is mapped yet', () => {
    const prompts = getStarterPrompts({ repos: [repo({ name: 'web' })] });
    expect(prompts.some((p) => p.prompt.includes('web'))).toBe(true);
  });

  it('includes a role-specific prompt first', () => {
    const prompts = getStarterPrompts({ repos: [], userRole: 'itsm' });
    expect(prompts[0].label).toBe('Investigate an incident');
  });

  it('respects the limit', () => {
    const prompts = getStarterPrompts({
      repos: [repo({ indexTier: 'mapped' })],
      userRole: 'design',
      limit: 2,
    });
    expect(prompts).toHaveLength(2);
  });
});
