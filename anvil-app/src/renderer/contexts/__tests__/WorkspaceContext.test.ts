import { describe, expect, it } from 'vitest';
import { readInitialWorkspaceIdFromLocation, shouldApplyWorkspaceLoad } from '../WorkspaceContext';

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
