import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/anvil-test',
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

import {
  buildApprovalResponse,
  buildCodexCollaborationMode,
  buildCursorClientCapabilities,
  buildInputResponse,
  buildTurnSteerParams,
  resolveSessionModel,
  resolvePersonaCodexPolicy,
  resolvePlanFeedbackDelivery,
  resolveSessionCwd,
} from '../codex-session.service.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('codex session service', () => {
  it('builds native Codex collaboration modes for plan and default turns', () => {
    expect(buildCodexCollaborationMode('plan', 'gpt-5.6-sol', 'high')).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5.6-sol',
        reasoning_effort: 'high',
        developer_instructions: null,
      },
    });
    expect(buildCodexCollaborationMode(undefined, 'gpt-5.6-terra', 'medium')).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-5.6-terra',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    });
  });

  it('keeps Cursor model ids instead of coercing them into the Codex catalog', () => {
    expect(resolveSessionModel('cursor', 'claude-fable-5-thinking-high')).toBe(
      'claude-fable-5-thinking-high',
    );
    expect(resolveSessionModel('cursor', '  ')).toBe('auto');
    expect(resolveSessionModel('codex', '')).toBe('gpt-5.6-sol');
  });

  it('advertises ACP form elicitation without claiming unsupported URL elicitation', () => {
    expect(buildCursorClientCapabilities()).toMatchObject({
      elicitation: { form: {} },
    });
    expect(buildCursorClientCapabilities()).not.toMatchObject({
      elicitation: { url: {} },
    });
  });

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

  it('routes plan feedback using provider-specific active-turn semantics', () => {
    expect(resolvePlanFeedbackDelivery('codex', 'busy', 'turn-1')).toBe('steer');
    expect(resolvePlanFeedbackDelivery('cursor', 'busy', null)).toBe('queue');
    expect(resolvePlanFeedbackDelivery('cursor', 'ready', null)).toBe('prompt');
    expect(resolvePlanFeedbackDelivery('codex', 'error', null)).toBe('none');
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
    ).toEqual({ action: 'accept', content: { project: 'Anvil' }, _meta: null });
    expect(
      buildInputResponse({
        kind: 'mcp_elicitation',
        action: 'decline',
      }),
    ).toEqual({ action: 'decline', content: null, _meta: null });
  });

  it('forces non-writing personas into the read-only sandbox', () => {
    expect(resolvePersonaCodexPolicy('full-access', 'technical-support')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    expect(resolvePersonaCodexPolicy('workspace-auto', 'incident-manager')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    expect(resolvePersonaCodexPolicy('full-access', 'coder')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });

  it('creates an isolated working directory for an empty workspace', () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-session-cwd-'));
    tempDirs.push(userDataPath);

    const cwd = resolveSessionCwd(
      [],
      { workspace: { workspaceId: 'workspace-123' } },
      userDataPath,
    );

    expect(cwd).toBe(path.join(userDataPath, 'workspace-chat', 'workspace-123'));
    expect(fs.statSync(cwd).isDirectory()).toBe(true);
  });

  it('rejects unsafe workspace IDs when creating an isolated working directory', () => {
    expect(() =>
      resolveSessionCwd([], { workspace: { workspaceId: '../outside' } }, '/tmp/anvil-test'),
    ).toThrow('Invalid workspace ID');
  });
});
