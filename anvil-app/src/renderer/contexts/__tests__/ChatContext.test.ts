import { describe, expect, it } from 'vitest';
import { threadBelongsToWorkspace } from '../ChatContext';

describe('threadBelongsToWorkspace', () => {
  it('matches only the active workspace', () => {
    expect(threadBelongsToWorkspace({ workspaceId: 'workspace-a' }, 'workspace-a')).toBe(true);
    expect(threadBelongsToWorkspace({ workspaceId: 'workspace-b' }, 'workspace-a')).toBe(false);
  });

  it('keeps global and workspace-owned threads separate', () => {
    expect(threadBelongsToWorkspace({}, null)).toBe(true);
    expect(threadBelongsToWorkspace({}, 'workspace-a')).toBe(false);
    expect(threadBelongsToWorkspace({ workspaceId: 'workspace-a' }, null)).toBe(false);
  });
});
