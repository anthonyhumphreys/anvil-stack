import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CursorCliStatus, CursorDetectedModel } from '../../shared/types.js';

const execFileAsync = promisify(execFile);
const STATUS_CACHE_MS = 30_000;
let cachedStatus: { at: number; status: CursorCliStatus } | null = null;

export function parseCursorModels(output: string): CursorDetectedModel[] {
  const models: CursorDetectedModel[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+-\s+(.+)$/);
    if (!match || match[1] === 'Available' || seen.has(match[1])) continue;
    seen.add(match[1]);
    models.push({ id: match[1], label: match[2].trim() });
  }
  return models;
}

export async function detectCursorCli(force = false): Promise<CursorCliStatus> {
  if (!force && cachedStatus && Date.now() - cachedStatus.at < STATUS_CACHE_MS) {
    return cachedStatus.status;
  }

  const whichCommand = process.platform === 'win32' ? 'where' : 'which';
  try {
    const [{ stdout: pathOutput }, { stdout: versionOutput }] = await Promise.all([
      execFileAsync(whichCommand, ['cursor-agent'], { timeout: 5_000 }),
      execFileAsync('cursor-agent', ['--version'], { timeout: 5_000 }),
    ]);
    const path = String(pathOutput).trim().split(/\r?\n/)[0];
    let models: CursorDetectedModel[] = [];
    let error: string | undefined;
    try {
      const result = await execFileAsync('cursor-agent', ['models'], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      models = parseCursorModels(String(result.stdout));
    } catch (caught) {
      error =
        caught instanceof Error
          ? `Cursor models unavailable: ${caught.message}`
          : 'Cursor models unavailable.';
    }
    const status: CursorCliStatus = {
      installed: true,
      path,
      version: String(versionOutput).trim() || undefined,
      models,
      error,
    };
    cachedStatus = { at: Date.now(), status };
    return status;
  } catch {
    const status: CursorCliStatus = { installed: false, models: [] };
    cachedStatus = { at: Date.now(), status };
    return status;
  }
}
