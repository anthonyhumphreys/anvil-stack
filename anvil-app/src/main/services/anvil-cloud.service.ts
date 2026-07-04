import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AnvilCloudCliStatus,
  AnvilCloudCommandDefinition,
  AnvilCloudCommandId,
  AnvilCloudCommandResult,
  AnvilCloudWorkbenchSnapshot,
} from '../../shared/types.js';

const MAX_OUTPUT_BUFFER = 1024 * 1024 * 8;
const COMMAND_TIMEOUT_MS = 120_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const appWorkspacePath = resolve(__dirname, '../../..');
const monorepoRoot = resolve(appWorkspacePath, '..');
const cloudWorkspacePath = join(monorepoRoot, 'anvil-cloud');
const workspaceCliEntry = join(cloudWorkspacePath, 'packages', 'cli', 'dist', 'index.js');

const COMMAND_DEFINITIONS: AnvilCloudCommandDefinition[] = [
  {
    id: 'doctor',
    label: 'Doctor',
    description:
      'Check local runtime, ports, build artifacts, generated client, and AWS preview env.',
    command: 'anvil cloud doctor --json',
    category: 'health',
  },
  {
    id: 'check',
    label: 'Guard Check',
    description: 'Run Anvil Guard and TypeScript diagnostics without writing build artifacts.',
    command: 'anvil cloud check --json',
    category: 'build',
  },
  {
    id: 'build',
    label: 'Build Cell',
    description: 'Compile the Cell and refresh generated client and manifest artifacts.',
    command: 'anvil cloud build --json',
    category: 'build',
  },
  {
    id: 'inspect-local',
    label: 'Inspect Local',
    description:
      'Read the local manifest, auth state, database snapshot, logs, and runtime metadata.',
    command: 'anvil cloud inspect --local --json',
    category: 'runtime',
  },
  {
    id: 'lens',
    label: 'Lens URL',
    description: 'Check the local runtime and return the Anvil Lens URL.',
    command: 'anvil cloud lens --json',
    category: 'runtime',
  },
  {
    id: 'logs-local',
    label: 'Local Logs',
    description: 'Read recent local runtime log events.',
    command: 'anvil cloud logs --local --json',
    category: 'runtime',
  },
  {
    id: 'db-list',
    label: 'Local DB',
    description: 'List local database tables and row counts.',
    command: 'anvil cloud db list --local --json',
    category: 'runtime',
  },
  {
    id: 'workflows-list',
    label: 'Workflows',
    description: 'List local workflow runs recorded by Anvil Local.',
    command: 'anvil cloud workflows list --json',
    category: 'runtime',
  },
  {
    id: 'services-list',
    label: 'Services',
    description: 'Show the last recorded local service state snapshot.',
    command: 'anvil cloud services list --json',
    category: 'runtime',
  },
  {
    id: 'agents-validate',
    label: 'Validate Agents',
    description: 'Validate mounted agents and AWS preview compatibility.',
    command: 'anvil cloud agents validate --json',
    category: 'agents',
  },
  {
    id: 'agents-manifest',
    label: 'Agent Manifest',
    description: 'Read the Cell agent manifest.',
    command: 'anvil cloud agents manifest --json',
    category: 'agents',
  },
  {
    id: 'agents-sandboxes',
    label: 'Agent Sandboxes',
    description: 'Inspect sandbox requirements for mounted agents.',
    command: 'anvil cloud agents sandboxes --json',
    category: 'agents',
  },
];

const COMMAND_ARGS: Record<AnvilCloudCommandId, string[]> = {
  doctor: ['doctor', '--json'],
  check: ['check', '--json'],
  build: ['build', '--json'],
  'inspect-local': ['inspect', '--local', '--json'],
  lens: ['lens', '--json'],
  'logs-local': ['logs', '--local', '--json'],
  'db-list': ['db', 'list', '--local', '--json'],
  'workflows-list': ['workflows', 'list', '--json'],
  'services-list': ['services', 'list', '--json'],
  'agents-validate': ['agents', 'validate', '--json'],
  'agents-manifest': ['agents', 'manifest', '--json'],
  'agents-sandboxes': ['agents', 'sandboxes', '--json'],
};

export async function getAnvilCloudWorkbenchSnapshot(): Promise<AnvilCloudWorkbenchSnapshot> {
  return {
    status: await detectAnvilCloudCli(),
    commands: COMMAND_DEFINITIONS,
  };
}

export async function runAnvilCloudCommand(
  commandId: AnvilCloudCommandId,
  cwd: string,
): Promise<AnvilCloudCommandResult> {
  const args = COMMAND_ARGS[commandId];
  if (!args) {
    throw new Error(`Unsupported Anvil Cloud command '${commandId}'.`);
  }

  const startedAt = Date.now();
  const cli = await resolveCloudCliInvocation();
  const command = formatCommand([cli.command, ...cli.prefixArgs, ...args]);

  try {
    const { stdout, stderr } = await execFileBuffered(cli.command, [...cli.prefixArgs, ...args], {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BUFFER,
      env: {
        ...process.env,
        DISABLE_TELEMETRY: '1',
        HOMEBREW_NO_AUTO_UPDATE: '1',
      },
    });

    const stdoutText = String(stdout);
    return {
      ok: true,
      commandId,
      command,
      cwd,
      stdout: stdoutText,
      stderr: String(stderr),
      parsed: parseJson(stdoutText),
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    };
  } catch (err) {
    const output = getExecOutput(err);
    return {
      ok: false,
      commandId,
      command,
      cwd,
      stdout: output.stdout,
      stderr: output.stderr,
      parsed: parseJson(output.stdout),
      exitCode: getExitCode(err),
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function detectAnvilCloudCli(): Promise<AnvilCloudCliStatus> {
  try {
    const cli = await resolveCloudCliInvocation();
    let version: string | undefined;
    try {
      const { stdout } = await execFileBuffered(cli.command, [...cli.prefixArgs, '--version'], {
        timeout: 10_000,
        maxBuffer: MAX_OUTPUT_BUFFER,
      });
      version = String(stdout).trim() || undefined;
    } catch {
      version = undefined;
    }

    return {
      available: true,
      command: formatCommand([cli.command, ...cli.prefixArgs]),
      version,
      source: cli.source,
      cloudWorkspacePath: cli.source === 'workspace' ? cloudWorkspacePath : undefined,
    };
  } catch (err) {
    return {
      available: false,
      command: 'anvil cloud',
      source: 'path',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function resolveCloudCliInvocation(): Promise<{
  command: string;
  prefixArgs: string[];
  source: AnvilCloudCliStatus['source'];
}> {
  if (existsSync(workspaceCliEntry)) {
    return {
      command: process.execPath,
      prefixArgs: [workspaceCliEntry],
      source: 'workspace',
    };
  }

  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileBuffered(whichCmd, ['anvil'], { timeout: 5_000 });
    return {
      command: 'anvil',
      prefixArgs: ['cloud'],
      source: 'wrapper',
    };
  } catch {
    // Fall back to the direct product binary for existing installs.
  }

  await execFileBuffered(whichCmd, ['anvil-cloud'], { timeout: 5_000 });
  return {
    command: 'anvil-cloud',
    prefixArgs: [],
    source: 'path',
  };
}

function parseJson(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function execFileBuffered(
  command: string,
  args: string[],
  options: Parameters<typeof execFile>[2],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        rejectExec(error);
        return;
      }

      resolveExec({
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

function getExecOutput(err: unknown): { stdout: string; stderr: string } {
  const output = err as { stdout?: unknown; stderr?: unknown };
  return {
    stdout: output.stdout === undefined ? '' : String(output.stdout),
    stderr: output.stderr === undefined ? '' : String(output.stderr),
  };
}

function getExitCode(err: unknown): number | undefined {
  const output = err as { code?: unknown };
  return typeof output.code === 'number' ? output.code : undefined;
}

function formatCommand(parts: string[]): string {
  return parts.map(quoteShellPart).join(' ');
}

function quoteShellPart(part: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`;
}
