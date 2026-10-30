import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }));
vi.mock('../agent-mcp/index.js', () => ({
  getAgentMcpStatus: () => ({
    running: true,
    port: 4321,
    sessions: [
      { sessionId: 's1', createdAt: '2026-01-01T00:00:00.000Z', toolCalls: 3, toolErrors: 1 },
    ],
  }),
}));
vi.mock('../browser.service.js', () => ({ listTargets: () => [] }));
vi.mock('../codex-session.service.js', () => ({
  getCodexSessionDiagnostics: () => ({ activeSessions: 0, bufferedBytes: 0, pendingApprovals: 0 }),
}));
vi.mock('../run-process.service.js', () => ({
  getRunProcessDiagnostics: () => ({ runningProcesses: 0, trackedProcesses: 0 }),
}));
vi.mock('../terminal.service.js', () => ({
  getTerminalDiagnostics: () => ({
    activeTerminals: 0,
    replayBytes: 0,
    trackedTerminals: 0,
    replayChunks: 0,
  }),
}));

import { buildAgentMcpDiagnostics, getDiagnosticsSnapshot } from '../diagnostics.service';

describe('agent MCP diagnostics', () => {
  it('reports endpoint status and per-session counters in the snapshot', () => {
    expect(getDiagnosticsSnapshot().agentMcp).toEqual({
      listening: true,
      port: 4321,
      activeSessions: 1,
      sessions: [
        { sessionId: 's1', createdAt: '2026-01-01T00:00:00.000Z', toolCalls: 3, toolErrors: 1 },
      ],
    });
  });

  it('copies only counters, never token-like extra fields', () => {
    const status = {
      running: false,
      error: 'EADDRINUSE',
      sessions: [
        {
          sessionId: 's2',
          createdAt: '2026-01-01T00:00:00.000Z',
          toolCalls: 0,
          toolErrors: 0,
          token: 'secret-token',
        },
      ],
    };
    const result = buildAgentMcpDiagnostics(status);
    expect(result).toEqual({
      listening: false,
      error: 'EADDRINUSE',
      activeSessions: 1,
      sessions: [
        { sessionId: 's2', createdAt: '2026-01-01T00:00:00.000Z', toolCalls: 0, toolErrors: 0 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });
});
