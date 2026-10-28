// src/main/services/run-process.service.ts

import { spawn, type ChildProcess } from 'node:child_process';
import { BrowserWindow } from 'electron';
import { getDefaultShell } from '../utils/shell.js';
import type { RunStatus } from '../../shared/run-types.js';

// ---------------------------------------------------------------------------
// Ring buffer for output
// ---------------------------------------------------------------------------

class RingBuffer {
  private lines: string[] = [];
  private maxLines: number;

  constructor(maxLines = 500) {
    this.maxLines = maxLines;
  }

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
  }

  toString(): string {
    return this.lines.join('\n');
  }

  clear(): void {
    this.lines = [];
  }
}

// ---------------------------------------------------------------------------
// Process tracking
// ---------------------------------------------------------------------------

interface RunningProcess {
  process: ChildProcess;
  repoId: string;
  command: string;
  startedAt: string;
  output: RingBuffer;
  killTimer?: NodeJS.Timeout;
}

const processes = new Map<string, RunningProcess>();

function sendEvent(channel: string, data: unknown): void {
  const win = BrowserWindow.getAllWindows()[0];
  win?.webContents.send(channel, data);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startProcess(repoId: string, command: string, cwd: string): void {
  // Kill existing process for this repo
  if (processes.has(repoId)) {
    stopProcess(repoId);
  }

  const shell = getDefaultShell();
  const proc = spawn(shell, ['-c', command], {
    cwd,
    env: process.env as Record<string, string>,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = new RingBuffer(500);
  const startedAt = new Date().toISOString();

  proc.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line) output.push(line);
    }
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line) output.push(line);
    }
  });

  proc.on('close', (exitCode, signal) => {
    const entry = processes.get(repoId);
    if (entry?.killTimer) clearTimeout(entry.killTimer);
    // Keep the entry in the map so output can be retrieved — but mark as done
    if (entry) {
      entry.process = null as unknown as ChildProcess; // release ref
    }
    sendEvent('run:stopped', { repoId, exitCode, signal: signal ?? undefined });
  });

  processes.set(repoId, { process: proc, repoId, command, startedAt, output });
  sendEvent('run:started', { repoId, command });
}

export function stopProcess(repoId: string): void {
  const entry = processes.get(repoId);
  if (!entry || !entry.process?.pid) return;

  // SIGTERM first
  entry.process.kill('SIGTERM');

  // SIGKILL after 5s if still alive
  entry.killTimer = setTimeout(() => {
    try {
      entry.process?.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }, 5000);
}

export function getStatus(repoId: string): RunStatus | null {
  const entry = processes.get(repoId);
  if (!entry) return null;

  const running = entry.process?.pid != null && !entry.process.killed;
  return {
    repoId: entry.repoId,
    command: entry.command,
    running,
    startedAt: entry.startedAt,
  };
}

export function getOutput(repoId: string): string {
  const entry = processes.get(repoId);
  return entry?.output.toString() ?? '';
}

export function cleanupRunProcesses(): void {
  for (const [repoId, entry] of processes) {
    if (entry.killTimer) clearTimeout(entry.killTimer);
    try {
      entry.process?.kill('SIGKILL');
    } catch {
      /* already dead */
    }
    processes.delete(repoId);
  }
}

export function getRunProcessDiagnostics(): { trackedProcesses: number; runningProcesses: number } {
  let runningProcesses = 0;
  for (const entry of processes.values()) {
    if (entry.process?.pid != null && !entry.process.killed) {
      runningProcesses += 1;
    }
  }

  return {
    trackedProcesses: processes.size,
    runningProcesses,
  };
}
