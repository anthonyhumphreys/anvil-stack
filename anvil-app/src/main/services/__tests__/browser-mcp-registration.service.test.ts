import { describe, expect, it } from 'vitest';
import {
  buildBrowserMcpAddArgs,
  isCurrentBrowserMcpRegistration,
  parseCodexStdioMcpRegistration,
} from '../browser-mcp-registration.service.js';

const electronPath = '/Applications/Anvil.app/Contents/MacOS/Anvil';
const scriptPath =
  '/Applications/Anvil.app/Contents/Resources/app.asar/scripts/chrome-mcp-server.mjs';

describe('browser MCP registration', () => {
  it('runs the packaged Electron executable in Node mode', () => {
    expect(buildBrowserMcpAddArgs('anvil-chrome', electronPath, scriptPath)).toEqual([
      'mcp',
      'add',
      'anvil-chrome',
      '--env',
      'ELECTRON_RUN_AS_NODE=1',
      '--',
      electronPath,
      scriptPath,
    ]);
  });

  it('recognises the safe packaged registration', () => {
    const registration = parseCodexStdioMcpRegistration(
      JSON.stringify({
        name: 'anvil-chrome',
        transport: {
          type: 'stdio',
          command: electronPath,
          args: [scriptPath],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      }),
    );

    expect(registration).not.toBeNull();
    expect(isCurrentBrowserMcpRegistration(registration!, electronPath, scriptPath)).toBe(true);
  });

  it('rejects the old registration that launches a second GUI instance', () => {
    const registration = parseCodexStdioMcpRegistration(
      JSON.stringify({
        name: 'anvil-chrome',
        transport: {
          type: 'stdio',
          command: electronPath,
          args: [scriptPath],
          env: null,
        },
      }),
    );

    expect(registration).not.toBeNull();
    expect(isCurrentBrowserMcpRegistration(registration!, electronPath, scriptPath)).toBe(false);
  });
});
