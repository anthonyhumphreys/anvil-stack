import { describe, expect, it } from 'vitest';
import {
  bootstrapDigestInput,
  canTransitionBootstrapStep,
  type BootstrapRecipe,
} from '../bootstrap';

const recipe: BootstrapRecipe = {
  schemaVersion: 1,
  platforms: ['darwin', 'linux'],
  steps: [
    {
      id: 'install',
      kind: 'command',
      workingDirectory: '.',
      argv: ['pnpm', 'install'],
      timeoutMs: 120_000,
      envNames: [],
      retry: 'inspect-before-retry',
    },
    {
      id: 'check',
      kind: 'verify',
      workingDirectory: '.',
      argv: ['pnpm', 'run', 'verify-setup'],
      timeoutMs: 60_000,
      envNames: [],
      retry: 'safe',
    },
  ],
};

describe('bootstrap digest input', () => {
  it('is deterministic regardless of caller key order', () => {
    const commitsA = { 'repo-a': 'abc', 'repo-b': 'def' };
    const commitsB = { 'repo-b': 'def', 'repo-a': 'abc' };
    const a = bootstrapDigestInput({
      recipe,
      repositoryCommits: commitsA,
      executionPolicy: { allowJobs: true, allowedSources: ['enr-1'] },
    });
    const b = bootstrapDigestInput({
      recipe,
      repositoryCommits: commitsB,
      executionPolicy: { allowedSources: ['enr-1'], allowJobs: true },
    });
    expect(a).toBe(b);
  });

  it('changes when a pinned input changes', () => {
    const base = bootstrapDigestInput({
      recipe,
      repositoryCommits: { 'repo-a': 'abc' },
      executionPolicy: { allowJobs: true },
    });
    const movedCommit = bootstrapDigestInput({
      recipe,
      repositoryCommits: { 'repo-a': 'other' },
      executionPolicy: { allowJobs: true },
    });
    const movedPolicy = bootstrapDigestInput({
      recipe,
      repositoryCommits: { 'repo-a': 'abc' },
      executionPolicy: { allowJobs: false },
    });
    const movedRecipe = bootstrapDigestInput({
      recipe: { ...recipe, steps: recipe.steps.slice(1) },
      repositoryCommits: { 'repo-a': 'abc' },
      executionPolicy: { allowJobs: true },
    });
    expect(movedCommit).not.toBe(base);
    expect(movedPolicy).not.toBe(base);
    expect(movedRecipe).not.toBe(base);
  });
});

describe('bootstrap step transitions', () => {
  it('follows pending → running → verified with terminal failure states', () => {
    expect(canTransitionBootstrapStep('pending', 'running')).toBe(true);
    expect(canTransitionBootstrapStep('running', 'verified')).toBe(true);
    expect(canTransitionBootstrapStep('running', 'unknown-outcome')).toBe(true);
    expect(canTransitionBootstrapStep('pending', 'verified')).toBe(false);
    expect(canTransitionBootstrapStep('verified', 'running')).toBe(false);
    expect(canTransitionBootstrapStep('failed', 'running')).toBe(false);
    expect(canTransitionBootstrapStep('unknown-outcome', 'running')).toBe(false);
  });
});
