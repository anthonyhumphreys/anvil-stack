import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ArgentCliStatus,
  ArgentCommandDefinition,
  ArgentCommandId,
  ArgentCommandResult,
  ArgentDeviceStatus,
  ArgentMcpStatus,
  ArgentMetroStatus,
  ArgentNodeStatus,
  ArgentPromptTemplate,
  ArgentReadinessCheck,
  ArgentWorkbenchSnapshot,
} from '../../shared/types.js';
import { getSimulatorPreviewStatus, startSimulatorPreview } from './simulator-preview.service.js';

const MAX_OUTPUT_BUFFER = 1024 * 1024 * 4;
const COMMAND_TIMEOUT_MS = 180_000;
const STATUS_TIMEOUT_MS = 10_000;
const METRO_STATUS_URL = 'http://localhost:8081/status';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appWorkspacePath = resolve(__dirname, '../../..');
const mobileProjectPath = join(appWorkspacePath, 'mobile');

const COMMAND_DEFINITIONS: ArgentCommandDefinition[] = [
  {
    id: 'install-cli',
    label: 'Install CLI',
    description: 'Install @swmansion/argent globally so editors can launch the argent command.',
    command: 'npm install -g @swmansion/argent',
    category: 'setup',
  },
  {
    id: 'init-mcp',
    label: 'Init MCP',
    description: 'Run the Argent init wizard from the Expo companion project root.',
    command: 'npx @swmansion/argent init',
    category: 'setup',
  },
  {
    id: 'update',
    label: 'Update',
    description: 'Refresh Argent and its generated configuration.',
    command: 'argent update',
    category: 'maintenance',
  },
  {
    id: 'flags',
    label: 'Flags',
    description: 'List Argent feature flags and their current state.',
    command: 'argent flags',
    category: 'maintenance',
  },
];

const PROMPT_TEMPLATES: ArgentPromptTemplate[] = [
  {
    id: 'launch-attach',
    label: 'Launch / Attach',
    description: 'Attach to the running app or ask Argent to launch it on a device.',
    evidence: ['device target', 'screenshot', 'logs'],
    prompt: [
      'Use Argent to launch or attach to the Expo companion app on a running iOS Simulator or Android Emulator.',
      'If the app is already running, attach to it. If it is not running and Argent can launch it, launch it on the available device.',
      'Confirm the target device, capture the current screen, and include relevant startup logs.',
    ].join('\n'),
  },
  {
    id: 'verify-screenshot',
    label: 'Verify Screenshot',
    description: 'Confirm Argent can see the running Expo companion.',
    evidence: ['screenshot', 'screen summary'],
    prompt: [
      'Use Argent against the running Expo companion app.',
      'Take a screenshot of the current simulator or emulator screen and describe what is visible.',
      'Include the screenshot evidence or explain exactly why Argent cannot capture it.',
    ].join('\n'),
  },
  {
    id: 'smoke-flow',
    label: 'Smoke Flow',
    description: 'Drive the app through a short flow and report where it breaks.',
    evidence: ['tap sequence', 'console logs', 'screenshot'],
    prompt: [
      'Use Argent to launch or attach to the running Expo companion app.',
      'Smoke-test the main flow: inspect the first screen, tap through the primary path, and stop at the first broken or confusing state.',
      'Report the tap sequence, screenshots, and relevant console logs.',
    ].join('\n'),
  },
  {
    id: 'debug-logs',
    label: 'Debug Logs',
    description: 'Read logs around the current mobile state.',
    evidence: ['console logs', 'native logs', 'screen state'],
    prompt: [
      'Use Argent to inspect the running Expo companion app.',
      'Capture the current screen state and read the console/native logs around it.',
      'Summarise suspicious errors or warnings and name the likely source files before changing code.',
    ].join('\n'),
  },
  {
    id: 'network-request',
    label: 'Network Request',
    description: 'Inspect failing requests and response payloads.',
    evidence: ['network request', 'response payload', 'logs'],
    prompt: [
      'Use Argent to inspect network traffic in the running Expo companion app.',
      'Navigate to the screen with the failing or interesting request, capture the request and response payload, and explain whether the bug is client-side, server-side, or configuration.',
    ].join('\n'),
  },
  {
    id: 'react-tree',
    label: 'React Tree',
    description: 'Inspect the component hierarchy for the current screen.',
    evidence: ['React component tree', 'accessibility tree'],
    prompt: [
      'Use Argent to inspect the React component tree for the current Expo companion screen.',
      'Identify the component names around the focused UI, include relevant props/state where Argent exposes them, and map them back to likely files.',
    ].join('\n'),
  },
  {
    id: 'profile-slowdown',
    label: 'Profile Slowdown',
    description: 'Record React/native profiling evidence for a sluggish interaction.',
    evidence: ['React profile', 'native profile', 'slow commit'],
    prompt: [
      'Use Argent to profile the running Expo companion app.',
      'Record the slow interaction, identify the slowest React commit or native work, and explain the smallest code change likely to improve it.',
    ].join('\n'),
  },
  {
    id: 'deep-link',
    label: 'Deep Link',
    description: 'Open a deep link and verify the target screen.',
    evidence: ['deep link result', 'screenshot', 'logs'],
    prompt: [
      'Use Argent to open a deep link in the running Expo companion app.',
      'Verify whether the expected screen loads, capture screenshot/log evidence, and report the route or linking code that likely owns the behavior.',
      'Ask me for the exact deep link first if it is not obvious from the workspace.',
    ].join('\n'),
  },
];

type ExecFileError = Error & {
  code?: number | string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

type ExecOptions = NonNullable<Parameters<typeof execFile>[2]>;

export async function getArgentWorkbenchSnapshot(): Promise<ArgentWorkbenchSnapshot> {
  const [cli, mcp, ios, android, metro] = await Promise.all([
    detectArgentCli(),
    detectArgentMcp(),
    detectIosSimulator(),
    detectAndroidDevice(),
    detectMetro(),
  ]);

  const node = getNodeStatus();
  const mobileProjectExists = existsSync(join(mobileProjectPath, 'package.json'));
  const simulatorPreview = getSimulatorPreviewStatus();

  return {
    capturedAt: new Date().toISOString(),
    projectRoot: appWorkspacePath,
    mobileProjectPath,
    mobileProjectExists,
    node,
    cli,
    mcp,
    ios,
    android,
    metro,
    simulatorPreview,
    checks: buildReadinessChecks({
      node,
      cli,
      mcp,
      ios,
      android,
      metro,
      mobileProjectExists,
      mobileProjectPath,
      simulatorPreviewRunning: simulatorPreview.running,
    }),
    commands: COMMAND_DEFINITIONS,
    prompts: PROMPT_TEMPLATES,
  };
}

export async function runArgentCommand(commandId: ArgentCommandId): Promise<ArgentCommandResult> {
  const command = resolveCommand(commandId);
  const cwd = commandId === 'init-mcp' ? mobileProjectPath : appWorkspacePath;
  const startedAt = Date.now();

  try {
    const { stdout, stderr } = await execFileBuffered(command.executable, command.args, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BUFFER,
      env: {
        ...process.env,
        DISABLE_TELEMETRY: '1',
        HOMEBREW_NO_AUTO_UPDATE: '1',
      },
    });

    return {
      ok: true,
      commandId,
      command: command.display,
      cwd,
      stdout: String(stdout),
      stderr: String(stderr),
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    };
  } catch (err) {
    const output = getExecOutput(err);
    return {
      ok: false,
      commandId,
      command: command.display,
      cwd,
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode: getExitCode(err),
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function startArgentSimulatorPreview(): ReturnType<typeof startSimulatorPreview> {
  return startSimulatorPreview({ cwd: mobileProjectPath });
}

function getNodeStatus(): ArgentNodeStatus {
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
  return {
    version,
    major,
    supported: major >= 18,
  };
}

async function detectArgentCli(): Promise<ArgentCliStatus> {
  const whichCommand = process.platform === 'win32' ? 'where' : 'which';
  let resolvedPath: string | undefined;

  try {
    const { stdout } = await execFileBuffered(whichCommand, ['argent'], {
      timeout: 5_000,
      maxBuffer: MAX_OUTPUT_BUFFER,
    });
    resolvedPath = String(stdout).trim().split(/\r?\n/)[0];
  } catch {
    resolvedPath = undefined;
  }

  try {
    const { stdout } = await execFileBuffered('argent', ['--version'], {
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BUFFER,
    });

    return {
      installed: true,
      command: 'argent',
      version: String(stdout).trim() || undefined,
      path: resolvedPath,
    };
  } catch (err) {
    return {
      installed: false,
      command: 'argent',
      path: resolvedPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function detectArgentMcp(): Promise<ArgentMcpStatus> {
  try {
    const { stdout } = await execFileBuffered('codex', ['mcp', 'list'], {
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BUFFER,
    });
    const rawList = String(stdout);
    return {
      codexAvailable: true,
      registered: /\bargent\b|@swmansion\/argent/i.test(rawList),
      command: 'codex mcp list',
      rawList,
    };
  } catch (err) {
    return {
      codexAvailable: false,
      registered: false,
      command: 'codex mcp list',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function detectIosSimulator(): Promise<ArgentDeviceStatus> {
  const command = 'xcrun simctl list devices booted';

  if (process.platform !== 'darwin') {
    return {
      platform: 'ios',
      available: false,
      command,
      devices: [],
      detail: 'iOS Simulator requires macOS and Xcode.',
    };
  }

  try {
    const { stdout } = await execFileBuffered('xcrun', ['simctl', 'list', 'devices', 'booted'], {
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BUFFER,
    });
    const devices = parseBootedSimulators(String(stdout));
    return {
      platform: 'ios',
      available: devices.length > 0,
      command,
      devices,
      detail:
        devices.length > 0
          ? `${devices.length} booted iOS simulator${devices.length === 1 ? '' : 's'} found.`
          : 'No booted iOS simulator found.',
    };
  } catch (err) {
    return {
      platform: 'ios',
      available: false,
      command,
      devices: [],
      detail: 'Could not inspect iOS simulators.',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function detectAndroidDevice(): Promise<ArgentDeviceStatus> {
  const command = 'adb devices';

  try {
    const { stdout } = await execFileBuffered('adb', ['devices'], {
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BUFFER,
    });
    const devices = parseAndroidDevices(String(stdout));
    return {
      platform: 'android',
      available: devices.length > 0,
      command,
      devices,
      detail:
        devices.length > 0
          ? `${devices.length} Android emulator/device${devices.length === 1 ? '' : 's'} connected.`
          : 'No Android emulator or device reported by adb.',
    };
  } catch (err) {
    return {
      platform: 'android',
      available: false,
      command,
      devices: [],
      detail: 'Could not inspect Android devices. Install Android SDK platform-tools if needed.',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function detectMetro(): Promise<ArgentMetroStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);

  try {
    const response = await fetch(METRO_STATUS_URL, { signal: controller.signal });
    const text = await response.text();
    const running = response.ok && /running/i.test(text);
    return {
      running,
      url: METRO_STATUS_URL,
      detail: running
        ? 'Metro is responding on the default Expo port.'
        : `Metro responded with ${response.status}, but not with a running status.`,
    };
  } catch (err) {
    return {
      running: false,
      url: METRO_STATUS_URL,
      detail: 'Metro is not responding on the default Expo port.',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildReadinessChecks(input: {
  node: ArgentNodeStatus;
  cli: ArgentCliStatus;
  mcp: ArgentMcpStatus;
  ios: ArgentDeviceStatus;
  android: ArgentDeviceStatus;
  metro: ArgentMetroStatus;
  mobileProjectExists: boolean;
  mobileProjectPath: string;
  simulatorPreviewRunning: boolean;
}): ArgentReadinessCheck[] {
  const deviceReady = input.ios.available || input.android.available;

  return [
    {
      id: 'node',
      label: 'Node 18+',
      level: input.node.supported ? 'pass' : 'fail',
      detail: `Node ${input.node.version}`,
    },
    {
      id: 'mobile-project',
      label: 'Expo companion',
      level: input.mobileProjectExists ? 'pass' : 'fail',
      detail: input.mobileProjectExists
        ? input.mobileProjectPath
        : 'mobile/package.json was not found.',
    },
    {
      id: 'argent-cli',
      label: 'Argent CLI',
      level: input.cli.installed ? 'pass' : 'fail',
      detail: input.cli.installed
        ? `argent ${input.cli.version ?? ''}`.trim()
        : 'Install @swmansion/argent globally.',
    },
    {
      id: 'mcp',
      label: 'Codex MCP',
      level: input.mcp.registered ? 'pass' : input.mcp.codexAvailable ? 'warn' : 'fail',
      detail: input.mcp.registered
        ? 'Argent appears in Codex MCP registrations.'
        : input.mcp.codexAvailable
          ? 'Codex is available, but Argent was not found in mcp list.'
          : 'Codex MCP registration could not be inspected.',
    },
    {
      id: 'device',
      label: 'Simulator/emulator',
      level: deviceReady ? 'pass' : 'warn',
      detail: deviceReady
        ? [...input.ios.devices, ...input.android.devices].join(', ')
        : 'Boot an iOS Simulator or Android Emulator for Argent to control.',
    },
    {
      id: 'metro',
      label: 'Expo dev server',
      level: input.metro.running ? 'pass' : 'warn',
      detail: input.metro.detail,
    },
    {
      id: 'serve-sim',
      label: 'Anvil simulator preview',
      level: input.simulatorPreviewRunning ? 'pass' : 'unknown',
      detail: input.simulatorPreviewRunning
        ? 'serve-sim is running for the embedded preview.'
        : 'Optional: start serve-sim to preview the device inside Anvil.',
    },
  ];
}

function resolveCommand(commandId: ArgentCommandId): {
  executable: string;
  args: string[];
  display: string;
} {
  switch (commandId) {
    case 'install-cli':
      return {
        executable: 'npm',
        args: ['install', '-g', '@swmansion/argent'],
        display: 'npm install -g @swmansion/argent',
      };
    case 'init-mcp':
      return {
        executable: 'npx',
        args: ['@swmansion/argent', 'init'],
        display: 'npx @swmansion/argent init',
      };
    case 'update':
      return {
        executable: 'argent',
        args: ['update'],
        display: 'argent update',
      };
    case 'flags':
      return {
        executable: 'argent',
        args: ['flags'],
        display: 'argent flags',
      };
    default: {
      const exhaustive: never = commandId;
      throw new Error(`Unsupported Argent command '${exhaustive}'.`);
    }
  }
}

function parseBootedSimulators(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('(Booted)') && !line.includes('(unavailable)'))
    .map((line) => line.replace(/\s+\(Booted\).*$/, '').trim())
    .filter(Boolean);
}

function parseAndroidDevices(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^List of devices attached/i.test(line))
    .filter((line) => /\sdevice$/.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

function execFileBuffered(
  command: string,
  args: string[],
  options: ExecOptions,
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getExecOutput(err: unknown): { stdout: string; stderr: string } {
  const execError = err as ExecFileError;
  return {
    stdout: execError?.stdout ? String(execError.stdout) : '',
    stderr: execError?.stderr ? String(execError.stderr) : '',
  };
}

function getExitCode(err: unknown): number | string | undefined {
  return (err as ExecFileError | undefined)?.code;
}
