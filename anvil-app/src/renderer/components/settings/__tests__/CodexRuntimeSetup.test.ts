import { describe, expect, it } from 'vitest';
import type { CodexRuntimeStatus } from '../../../../shared/codex-runtime';
import { codexRuntimeStateLabel } from '../CodexRuntimeSetup';

describe('codexRuntimeStateLabel', () => {
  it('announces checking while the runtime status is loading', () => {
    expect(codexRuntimeStateLabel(null, 'checking')).toBe('Checking');
  });

  it('distinguishes an installed runtime that still needs attention', () => {
    const status: CodexRuntimeStatus = { installed: true, ready: false };
    expect(codexRuntimeStateLabel(status, 'idle')).toBe('Needs attention');
  });

  it('announces when the coding engine is ready', () => {
    const status: CodexRuntimeStatus = { installed: true, ready: true };
    expect(codexRuntimeStateLabel(status, 'idle')).toBe('Ready');
  });
});
