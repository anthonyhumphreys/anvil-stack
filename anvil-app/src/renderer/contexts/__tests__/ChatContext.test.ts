import { describe, expect, it } from 'vitest';
import {
  chatMessagesToEntries,
  shouldSuppressPreparedChatBootstrap,
  threadBelongsToWorkspace,
} from '../ChatContext';

describe('chatMessagesToEntries', () => {
  it('restores segmented assistant output and persisted activity', () => {
    expect(
      chatMessagesToEntries([
        {
          id: 'progress-1',
          role: 'system',
          content: 'Checking the tests.',
          timestamp: '2026-07-14T10:00:00.000Z',
          event: {
            type: 'text',
            text: 'Checking the tests.',
            itemId: 'provider-message-1',
            assistantPhase: 'progress',
          },
        },
        {
          id: 'command-1',
          role: 'system',
          content: 'Ran pnpm test',
          timestamp: '2026-07-14T10:00:01.000Z',
          event: { type: 'command_exec', command: 'pnpm test', exitCode: 0 },
        },
        {
          id: 'final-1',
          role: 'assistant',
          content: 'The tests pass.',
          timestamp: '2026-07-14T10:00:02.000Z',
          event: {
            type: 'text',
            text: 'The tests pass.',
            itemId: 'provider-message-2',
            assistantPhase: 'final',
          },
        },
      ]),
    ).toEqual([
      {
        kind: 'assistant',
        content: 'Checking the tests.',
        id: 'progress-1',
        itemId: 'provider-message-1',
        phase: 'progress',
      },
      { kind: 'event', event: { type: 'command_exec', command: 'pnpm test', exitCode: 0 } },
      {
        kind: 'assistant',
        content: 'The tests pass.',
        id: 'final-1',
        itemId: 'provider-message-2',
        phase: 'final',
      },
    ]);
  });

  it('does not restore approval and input cards after their requests were resolved', () => {
    expect(
      chatMessagesToEntries([
        {
          id: 'approval',
          role: 'system',
          content: 'Approval needed',
          timestamp: '2026-04-27T10:00:00.000Z',
          event: { type: 'approval_request', approvalRequestId: 7 },
        },
        {
          id: 'input',
          role: 'system',
          content: 'Input needed',
          timestamp: '2026-04-27T10:00:01.000Z',
          event: { type: 'input_request', inputRequestId: 'question-1' },
        },
        {
          id: 'approval-resolved',
          role: 'system',
          content: 'Request resolved',
          timestamp: '2026-04-27T10:00:02.000Z',
          event: { type: 'request_resolved', resolvedRequestId: 7 },
        },
        {
          id: 'input-resolved',
          role: 'system',
          content: 'Request resolved',
          timestamp: '2026-04-27T10:00:03.000Z',
          event: { type: 'request_resolved', resolvedRequestId: 'question-1' },
        },
      ]),
    ).toEqual([]);
  });

  it('keeps legacy flattened assistant history readable', () => {
    expect(
      chatMessagesToEntries([
        {
          id: 'legacy-1',
          role: 'assistant',
          content: 'Existing flattened output',
          timestamp: '2026-07-14T10:00:00.000Z',
        },
      ]),
    ).toEqual([{ kind: 'assistant', content: 'Existing flattened output', id: 'legacy-1' }]);
  });
});

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

describe('shouldSuppressPreparedChatBootstrap', () => {
  it('does not leave suppression armed when launching with the active persona', () => {
    expect(shouldSuppressPreparedChatBootstrap('coder', 'coder')).toBe(false);
  });

  it('suppresses the bootstrap triggered by an actual persona change', () => {
    expect(shouldSuppressPreparedChatBootstrap('coder', 'architect')).toBe(true);
    expect(shouldSuppressPreparedChatBootstrap(null, 'coder')).toBe(true);
  });
});
