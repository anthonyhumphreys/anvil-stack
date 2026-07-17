import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

import {
  buildApprovalResponse,
  buildInputResponse,
  buildTurnSteerParams,
} from '../codex-session.service.js';

describe('codex session service', () => {
  it('builds turn steering params using the Codex app-server expected turn precondition', () => {
    const params = buildTurnSteerParams('thread-1', 'turn-1', 'Keep going, but keep it small.', [
      {
        id: 'attachment-1',
        name: 'app.ts',
        mimeType: 'text/typescript',
        size: 128,
        kind: 'file',
        path: '/repo/src/app.ts',
        createdAt: '2026-06-23T00:00:00.000Z',
      },
    ]);

    expect(params).toEqual({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [
        {
          type: 'text',
          text: 'Keep going, but keep it small.',
          text_elements: [],
        },
        {
          type: 'mention',
          name: 'app.ts',
          path: '/repo/src/app.ts',
        },
      ],
    });
    expect(params).not.toHaveProperty('turnId');
  });

  it('returns requested permission profiles only for accepted permission approvals', () => {
    const permissions = { network: { enabled: true } };

    expect(buildApprovalResponse('permissions', permissions, 'acceptForSession')).toEqual({
      permissions,
      scope: 'session',
    });
    expect(buildApprovalResponse('permissions', permissions, 'decline')).toEqual({
      permissions: {},
      scope: 'turn',
    });
    expect(buildApprovalResponse('command', undefined, 'accept')).toEqual({ decision: 'accept' });
  });

  it('maps user answers and MCP elicitation responses to app-server response shapes', () => {
    expect(
      buildInputResponse({
        kind: 'user_input',
        answers: { provider: ['Linear'], scope: ['Current workspace'] },
      }),
    ).toEqual({
      answers: {
        provider: { answers: ['Linear'] },
        scope: { answers: ['Current workspace'] },
      },
    });
    expect(
      buildInputResponse({
        kind: 'mcp_elicitation',
        action: 'accept',
        content: { project: 'Anvil' },
      }),
    ).toEqual({ action: 'accept', content: { project: 'Anvil' } });
  });
});
