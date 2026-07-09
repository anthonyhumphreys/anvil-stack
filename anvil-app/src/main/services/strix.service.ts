// src/main/services/strix.service.ts

import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import type {
  DockerStatus,
  PentestScanConfig,
  PentestScanEvent,
} from '../../shared/pentest-types.js';
import {
  createScan,
  getScan,
  updateScanContainerId,
  updateScanStatus,
  markRunningScansCancelled,
} from './pentest-persistence.service.js';
import { decryptSecret } from './auth.service.js';
import { getDb } from '../db/database.js';
import { notifyIfUnfocused } from './notification.service.js';
import { parseStrixResults } from './strix-results.service.js';
import {
  PRIMARY_STRIX_PREFIX,
  getStrixContainerPrefixes,
} from '../../shared/app-identity.js';
import { DEFAULT_CODEX_MODEL } from '../../shared/codex-models.js';

// Track active scans for cleanup
const activeProcesses = new Map<
  string,
  { process: ReturnType<typeof spawn>; timer: NodeJS.Timeout; tempDir: string }
>();

function getPrimaryContainerName(scanId: string): string {
  return `${PRIMARY_STRIX_PREFIX}${scanId}`;
}

function getContainerNames(scanId: string): string[] {
  return getStrixContainerPrefixes().map((prefix) => `${prefix}${scanId}`);
}

// ---------------------------------------------------------------------------
// Docker checks
// ---------------------------------------------------------------------------

export async function checkDocker(): Promise<DockerStatus> {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) {
          resolve({ available: false });
        } else {
          resolve({ available: true, version: stdout.trim() });
        }
      },
    );
  });
}

export async function ensureStrixImage(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if image exists
    execFile('docker', ['image', 'inspect', 'strix-agent'], (err) => {
      if (!err) {
        resolve(); // Image exists
        return;
      }
      // Pull the image
      const pull = spawn('docker', ['pull', 'strix-agent'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      pull.stdout?.on('data', (data: Buffer) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send('pentest:scan-event', {
          scanId: '',
          repoId: '',
          type: 'progress',
          message: `Pulling Strix image: ${data.toString().trim()}`,
          timestamp: new Date().toISOString(),
        });
      });
      pull.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('Failed to pull strix-agent image'));
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Scan lifecycle
// ---------------------------------------------------------------------------

function sendScanEvent(event: PentestScanEvent): void {
  const win = BrowserWindow.getAllWindows()[0];
  win?.webContents.send('pentest:scan-event', event);
}

function rewriteLocalhostUrl(url: string): string {
  return url
    .replace(/localhost/gi, 'host.docker.internal')
    .replace(/127\.0\.0\.1/g, 'host.docker.internal');
}

export async function startScan(
  repoId: string,
  repoPath: string,
  config: PentestScanConfig,
): Promise<string> {
  // Check for existing running scan
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id FROM pentest_scans WHERE repo_id = ? AND status IN ('pending', 'running') LIMIT 1`,
    )
    .get(repoId) as { id: string } | undefined;
  if (existing) throw new Error('A scan is already running for this repository');

  const scanId = createScan({
    repoId,
    targetType: config.targetType,
    targetValue: config.targetValue,
    categories: config.categories,
    maxDurationMs: config.maxDurationMs,
  });

  // Ensure Strix image is available
  await ensureStrixImage();

  // Create temp directory for output
  const tempDir = await mkdtemp(path.join(tmpdir(), PRIMARY_STRIX_PREFIX));

  // Build docker args
  const args = [
    'run',
    '--add-host=host.docker.internal:host-gateway',
    '--name',
    getPrimaryContainerName(scanId),
  ];

  if (config.targetType === 'local') {
    args.push('-v', `${repoPath}:/target:ro`);
    args.push('-v', `${tempDir}:/output`);
  } else {
    args.push('-v', `${tempDir}:/output`);
  }

  // LLM env vars
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as
    | Record<string, unknown>
    | undefined;
  if (settings?.openai_api_key) {
    const apiKey = decryptSecret(settings.openai_api_key as Buffer);
    args.push('-e', `LLM_API_KEY=${apiKey}`);
    args.push('-e', `STRIX_LLM=openai/${settings.openai_model || DEFAULT_CODEX_MODEL}`);
  }

  args.push('strix-agent');

  // Target
  if (config.targetType === 'local') {
    args.push('--target', '/target');
  } else {
    args.push('--target', rewriteLocalhostUrl(config.targetValue));
  }

  // Categories
  if (config.categories.length > 0) {
    args.push('--categories', config.categories.join(','));
  }

  args.push('-n'); // headless mode

  // Spawn container
  const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Record container name and mark as running
  const containerName = getPrimaryContainerName(scanId);
  updateScanContainerId(scanId, containerName);
  updateScanStatus(scanId, 'running');

  // Stream stdout
  let stderrBuffer = '';
  proc.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      const eventType =
        line.toLowerCase().includes('vulnerability') || line.toLowerCase().includes('found')
          ? ('vulnerability-found' as const)
          : ('agent-activity' as const);

      sendScanEvent({
        scanId,
        repoId,
        type: eventType,
        message: line,
        timestamp: new Date().toISOString(),
      });
    }
  });

  proc.stderr?.on('data', (data: Buffer) => {
    stderrBuffer += data.toString();
    sendScanEvent({
      scanId,
      repoId,
      type: 'error',
      message: data.toString(),
      timestamp: new Date().toISOString(),
    });
  });

  // Timeout timer
  const timer = setTimeout(async () => {
    try {
      execFile('docker', ['stop', containerName], () => {});
      updateScanStatus(
        scanId,
        'failed',
        `Scan timed out after ${Math.round(config.maxDurationMs / 60_000)} minutes`,
      );
      sendScanEvent({
        scanId,
        repoId,
        type: 'error',
        message: 'Scan timed out',
        timestamp: new Date().toISOString(),
      });
    } catch {
      /* container may already be stopped */
    }
  }, config.maxDurationMs);

  // Handle exit
  proc.on('close', async (code) => {
    clearTimeout(timer);
    activeProcesses.delete(scanId);

    try {
      // Parse results regardless of exit code (partial results are valuable)
      await parseStrixResults(scanId, tempDir);

      const scan = getScan(scanId);
      if (scan && scan.status === 'running') {
        if (code === 0) {
          const findingCount = db
            .prepare('SELECT COUNT(*) as count FROM pentest_findings WHERE scan_id = ?')
            .get(scanId) as { count: number };
          updateScanStatus(
            scanId,
            'completed',
            `Scan completed. ${findingCount.count} findings discovered.`,
          );
        } else {
          updateScanStatus(
            scanId,
            'failed',
            stderrBuffer.slice(0, 500) || `Exited with code ${code}`,
          );
        }
      }

      // Notify
      const repoRow = db.prepare('SELECT name FROM repos WHERE id = ?').get(repoId) as
        | { name: string }
        | undefined;
      notifyIfUnfocused('Pentest Complete', `Scan finished for ${repoRow?.name || 'repository'}.`);

      // Cleanup container
      execFile('docker', ['rm', containerName], () => {});
    } catch (err) {
      console.error('[Strix] Error processing results:', err);
      updateScanStatus(
        scanId,
        'failed',
        err instanceof Error ? err.message : 'Failed to process results',
      );
    }

    // Clean up temp directory
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  activeProcesses.set(scanId, { process: proc, timer, tempDir });
  return scanId;
}

export function stopScan(scanId: string): void {
  const active = activeProcesses.get(scanId);
  if (active) {
    clearTimeout(active.timer);
    active.process.kill();
    activeProcesses.delete(scanId);
    rm(active.tempDir, { recursive: true, force: true }).catch(() => {});
  }

  for (const containerName of getContainerNames(scanId)) {
    execFile('docker', ['stop', containerName], () => {
      execFile('docker', ['rm', containerName], () => {});
    });
  }

  updateScanStatus(scanId, 'cancelled');
}

export function cleanupStrix(repoId?: string): void {
  // Stop all active processes
  for (const [, active] of activeProcesses) {
    clearTimeout(active.timer);
    active.process.kill();
  }
  activeProcesses.clear();

  // Stop any running containers by prefix
  for (const prefix of getStrixContainerPrefixes()) {
    execFile('docker', ['ps', '-q', '--filter', `name=${prefix}`], (err, stdout) => {
      if (err || !stdout.trim()) return;
      const ids = stdout.trim().split('\n');
      for (const id of ids) {
        execFile('docker', ['stop', id], () => {});
      }
    });
  }

  // Mark DB records — repoId is required by the actual persistence service signature
  if (repoId) {
    markRunningScansCancelled(repoId);
  }
}

export async function reconnectOnStartup(): Promise<void> {
  // Check for containers from previous session
  return new Promise((resolve) => {
    let pendingPrefixes = getStrixContainerPrefixes().length;
    const maybeResolve = () => {
      pendingPrefixes -= 1;
      if (pendingPrefixes <= 0) resolve();
    };

    for (const prefix of getStrixContainerPrefixes()) {
      execFile(
        'docker',
        ['ps', '-a', '--filter', `name=${prefix}`, '--format', '{{.Names}}\t{{.Status}}'],
        (err, stdout) => {
          if (!err && stdout.trim()) {
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
              const [name, status] = line.split('\t');
              const scanId = name?.startsWith(prefix) ? name.slice(prefix.length) : null;
              if (!scanId) continue;

              const scan = getScan(scanId);
              if (!scan) {
                execFile('docker', ['rm', '-f', name], () => {});
                continue;
              }

              if (status?.startsWith('Up')) {
                console.log(`[Strix] Found running container for scan ${scanId}`);
              } else {
                execFile(
                  'docker',
                  ['inspect', '--format', '{{.State.ExitCode}}', name],
                  async (_inspectErr, exitStdout) => {
                    const exitCode = parseInt(exitStdout?.trim() || '1', 10);
                    if (scan.status === 'running') {
                      updateScanStatus(
                        scanId,
                        exitCode === 0 ? 'completed' : 'failed',
                        exitCode === 0
                          ? 'Completed (recovered after restart)'
                          : `Failed with exit code ${exitCode}`,
                      );
                    }
                    execFile('docker', ['rm', name], () => {});
                  },
                );
              }
            }
          }

          maybeResolve();
        },
      );
    }
  });
}
