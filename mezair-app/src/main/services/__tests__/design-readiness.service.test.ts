import { describe, expect, it, vi } from 'vitest';

const { execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

import { hasOfficialFigmaRemoteMcp, registerFigmaMcp } from '../design-readiness.service.js';

describe('design readiness service', () => {
  it('detects the official remote Figma MCP server', () => {
    const output = `
Name    Url                         Bearer Token Env Var  Status   Auth
figma   https://mcp.figma.com/mcp   -                     enabled  OAuth
`;

    expect(hasOfficialFigmaRemoteMcp(output)).toBe(true);
  });

  it('does not treat the legacy stdio Figma package as Make-resource ready', () => {
    const output = `
Name   Command  Args                       Env  Cwd  Status   Auth
figma  npx      -y @anthropic-ai/figma-mcp -    -    enabled  Unsupported
`;

    expect(hasOfficialFigmaRemoteMcp(output)).toBe(false);
  });

  it('registers Figma using the official remote MCP endpoint', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, '', '');
    });

    await expect(registerFigmaMcp()).resolves.toEqual({ success: true });

    expect(execFileMock).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'figma', '--url', 'https://mcp.figma.com/mcp'],
      expect.objectContaining({ timeout: 60_000 }),
      expect.any(Function),
    );
  });
});
