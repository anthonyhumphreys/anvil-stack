import { describe, expect, it } from 'vitest';
import {
  buildBrowserMcpAddArgs,
  isCurrentBrowserMcpRegistration,
  parseCodexStdioMcpRegistration,
} from '../browser-mcp-registration.service.js';

const electronPath = '/Applications/Mezair.app/Contents/MacOS/Mezair';
const scriptPath =
  '/Applications/Mezair.app/Contents/Resources/app.asar/scripts/chrome-mcp-server.mjs';

describe('browser MCP registration', () => {
  it('runs the packaged Electron executable in Node mode', () => {
    expect(buildBrowserMcpAddArgs('mezair-chrome', electronPath, scriptPath)).toEqual([
      'mcp',
      'add',
      'mezair-chrome',
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
        name: 'mezair-chrome',
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
        name: 'mezair-chrome',
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
