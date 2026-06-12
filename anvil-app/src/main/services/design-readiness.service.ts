// src/main/services/design-readiness.service.ts

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BrowserWindow } from 'electron';
import type { DesignReadiness } from '../../shared/types.js';

const execFileAsync = promisify(execFile);
const FIGMA_MCP_NAME = 'figma';
const FIGMA_MCP_REMOTE_URL = 'https://mcp.figma.com/mcp';

export async function checkDesignReadiness(): Promise<DesignReadiness> {
  const [figmaMcpRegistered, frontendSkillInstalled] = await Promise.all([
    checkFigmaMcp(),
    checkFrontendSkill(),
  ]);

  return {
    figmaMcpRegistered,
    frontendSkillInstalled,
    allReady: figmaMcpRegistered && frontendSkillInstalled,
  };
}

async function checkFigmaMcp(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('codex', ['mcp', 'list'], {
      timeout: 10_000,
    });
    return hasOfficialFigmaRemoteMcp(String(stdout));
  } catch {
    return false;
  }
}

export function hasOfficialFigmaRemoteMcp(output: string): boolean {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => {
      return (
        new RegExp(`^${FIGMA_MCP_NAME}\\s`, 'i').test(line) && line.includes(FIGMA_MCP_REMOTE_URL)
      );
    });
}

async function checkFrontendSkill(): Promise<boolean> {
  const skillsDir = join(homedir(), '.claude', 'skills');
  const candidates = [join(skillsDir, 'frontend-design'), join(skillsDir, 'frontend-design.md')];
  return candidates.some((p) => existsSync(p));
}

export async function registerFigmaMcp(): Promise<{ success: boolean; error?: string }> {
  try {
    await execFileAsync('codex', ['mcp', 'add', FIGMA_MCP_NAME, '--url', FIGMA_MCP_REMOTE_URL], {
      timeout: 60_000,
    });
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to register Figma MCP',
    };
  }
}

export async function installFrontendSkill(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(
      'npx',
      ['skills', 'add', 'https://github.com/anthropics/skills', '--skill', 'frontend-design'],
      {
        shell: true,
        timeout: 120_000,
        env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' },
      },
    );

    let stderr = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('design:install-output', line);
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr.trim() || `Process exited with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}
