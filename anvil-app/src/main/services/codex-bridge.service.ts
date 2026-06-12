import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

export interface CodexCliStatus {
  installed: boolean;
  version?: string;
  path?: string;
  configuredForFoundry: boolean;
}

/**
 * Detect if Codex CLI is installed and get its status.
 */
export async function detectCodexCli(): Promise<CodexCliStatus> {
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout: codexPath } = await execFileAsync(whichCmd, ['codex']);
    const trimmedPath = codexPath.trim();

    let version: string | undefined;
    try {
      const { stdout } = await execFileAsync('codex', ['--version']);
      const match = stdout.match(/(\d+\.\d+\.\d+)/);
      version = match?.[1];
    } catch {
      /* version check failed, CLI still exists */
    }

    const configuredForFoundry = await checkCodexFoundryConfig();

    return {
      installed: true,
      version,
      path: trimmedPath,
      configuredForFoundry,
    };
  } catch {
    return { installed: false, configuredForFoundry: false };
  }
}

/**
 * Check if Codex CLI is configured to use Azure Foundry.
 */
async function checkCodexFoundryConfig(): Promise<boolean> {
  // Codex CLI config is typically at ~/.codex/config.json or similar
  const configPaths = [
    path.join(os.homedir(), '.codex', 'config.json'),
    path.join(os.homedir(), '.config', 'codex', 'config.json'),
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        // Check if Azure/Foundry endpoint is configured
        if (config.provider === 'azure' || config.apiBase?.includes('azure')) {
          return true;
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }

  return false;
}

/**
 * Get install instructions for Codex CLI.
 */
export function getCodexInstallInstructions(): string {
  return [
    'Codex CLI is required for the chat feature.',
    '',
    'Install via npm:',
    '  npm install -g @openai/codex',
    '',
    'Or see: https://github.com/openai/codex',
    '',
    'After installing, configure it to use your Azure AI Foundry endpoint',
    'via the Settings page in Anvil.',
  ].join('\n');
}
