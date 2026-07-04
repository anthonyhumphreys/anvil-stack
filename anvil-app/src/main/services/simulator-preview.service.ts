import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SimulatorPreviewStartOptions, SimulatorPreviewStatus } from '../../shared/types.js';

const DEFAULT_SERVE_SIM_PORT = 3200;
const DEFAULT_METRO_PORT = 8081;
const MAX_OUTPUT_CHARS = 12_000;

let processHandle: ChildProcessWithoutNullStreams | null = null;
let status: SimulatorPreviewStatus = { running: false };

export function getSimulatorPreviewStatus(): SimulatorPreviewStatus {
  return status;
}

export function startSimulatorPreview(
  options: SimulatorPreviewStartOptions = {},
): SimulatorPreviewStatus {
  if (processHandle && status.running) return status;

  const cwd = options.cwd?.trim() || defaultMobileCwd();
  const port = options.port ?? DEFAULT_SERVE_SIM_PORT;
  const command = 'npx --yes serve-sim@latest';
  const startedAt = new Date().toISOString();

  processHandle = spawn('npx', ['--yes', 'serve-sim@latest'], {
    cwd,
    env: {
      ...(process.env as Record<string, string>),
      SERVE_SIM_PORT: String(port),
      PORT: String(port),
    },
  });

  status = {
    running: true,
    url: `http://localhost:${port}`,
    metroUrl: `http://localhost:${DEFAULT_METRO_PORT}/.sim`,
    pid: processHandle.pid,
    cwd,
    command,
    startedAt,
    lastOutput: '',
  };

  processHandle.stdout.on('data', (chunk: Buffer) => {
    status = {
      ...status,
      lastOutput: appendOutput(status.lastOutput, chunk.toString()),
    };
  });

  processHandle.stderr.on('data', (chunk: Buffer) => {
    status = {
      ...status,
      lastOutput: appendOutput(status.lastOutput, chunk.toString()),
    };
  });

  processHandle.on('error', (err) => {
    status = {
      ...status,
      running: false,
      lastError: err.message,
    };
    processHandle = null;
  });

  processHandle.on('exit', (code, signal) => {
    status = {
      ...status,
      running: false,
      lastError:
        code === 0
          ? undefined
          : `serve-sim exited${typeof code === 'number' ? ` with code ${code}` : ''}${
              signal ? ` (${signal})` : ''
            }`,
    };
    processHandle = null;
  });

  return status;
}

export function stopSimulatorPreview(): void {
  if (!processHandle) {
    status = { ...status, running: false };
    return;
  }

  try {
    processHandle.kill('SIGTERM');
  } catch {
    // Already gone.
  }
  processHandle = null;
  status = { ...status, running: false };
}

export function cleanupSimulatorPreview(): void {
  stopSimulatorPreview();
}

function defaultMobileCwd(): string {
  const candidate = path.join(process.cwd(), 'mobile');
  if (existsSync(candidate)) return candidate;
  return process.cwd();
}

function appendOutput(current: string | undefined, addition: string): string {
  const next = `${current ?? ''}${addition}`;
  return next.length > MAX_OUTPUT_CHARS ? next.slice(-MAX_OUTPUT_CHARS) : next;
}
