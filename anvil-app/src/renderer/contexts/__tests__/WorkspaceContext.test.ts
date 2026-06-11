import { describe, expect, it } from 'vitest';
import { readInitialWorkspaceIdFromLocation } from '../WorkspaceContext';

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
