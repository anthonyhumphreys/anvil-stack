import { execFileSync } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';

function readMacModel() {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('sysctl', ['-n', 'hw.model'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const cpus = os.cpus();
const memoryBytes = os.totalmem();
const record = {
  capturedAt: new Date().toISOString(),
  system: {
    model: readMacModel(),
    platform: os.platform(),
    platformRelease: os.release(),
    architecture: os.arch(),
    cpuModel: cpus[0]?.model ?? null,
    logicalCpuCount: cpus.length,
    memoryBytes,
    memoryGiB: Number((memoryBytes / 1024 ** 3).toFixed(2)),
  },
  runtime: {
    node: process.version,
  },
  measurements: {
    status: 'not-run',
    note: 'This script records machine metadata only; it does not claim performance results.',
  },
};

process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
