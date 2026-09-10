import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { CursorCliStatus, CursorDetectedModel } from '../../shared/types.js';

const execFileAsync = promisify(execFile);
const STATUS_CACHE_MS = 30_000;
const ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
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

export function parseCursorAcpModels(output: string): CursorDetectedModel[] {
  const models: CursorDetectedModel[] = [];
  const seen = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      const result = isRecord(message.result) ? message.result : undefined;
      const modelCatalog = isRecord(result?.models) ? result.models : undefined;
      const availableModels = Array.isArray(modelCatalog?.availableModels)
        ? modelCatalog.availableModels
        : [];

      for (const candidate of availableModels) {
        if (!isRecord(candidate) || typeof candidate.modelId !== 'string') continue;
        const id = candidate.modelId.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({
          id,
          label:
            typeof candidate.name === 'string' && candidate.name.trim()
              ? candidate.name.trim()
              : id,
        });
      }
    } catch {
      // ACP logs and partial lines are not model catalog responses.
    }
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
    const acpCatalog = await discoverCursorAcpModels();
    models = acpCatalog.models;
    error = acpCatalog.error;

    if (models.length === 0) {
      try {
        const result = await execFileAsync('cursor-agent', ['models'], {
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        });
        models = parseCursorModels(String(result.stdout));
        if (models.length > 0) error = undefined;
      } catch (caught) {
        error ??=
          caught instanceof Error
            ? `Cursor models unavailable: ${caught.message}`
            : 'Cursor models unavailable.';
      }
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

async function discoverCursorAcpModels(): Promise<{
  models: CursorDetectedModel[];
  error?: string;
}> {
  return new Promise((resolve) => {
    const child = spawn('cursor-agent', ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (models: CursorDetectedModel[], error?: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      child.kill();
      resolve({ models, error });
    };

    const send = (id: number, method: string, params: Record<string, unknown>) => {
      if (!child.stdin) {
        finish([], 'Cursor ACP unavailable: stdin is not writable.');
        return;
      }
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (caught) {
        finish(
          [],
          caught instanceof Error ? `Cursor ACP unavailable: ${caught.message}` : undefined,
        );
      }
    };

    const handleLine = (line: string) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      if (message.error) {
        const error = isRecord(message.error) ? message.error : undefined;
        finish(
          [],
          `Cursor ACP unavailable: ${typeof error?.message === 'string' ? error.message : 'request failed'}`,
        );
        return;
      }

      if (message.id === 1) {
        send(2, 'authenticate', { methodId: 'cursor_login' });
      } else if (message.id === 2) {
        send(3, 'session/new', { cwd: process.cwd(), mcpServers: [] });
      } else if (message.id === 3) {
        finish(parseCursorAcpModels(JSON.stringify(message)));
      }
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (caught) => {
      finish([], caught instanceof Error ? `Cursor ACP unavailable: ${caught.message}` : undefined);
    });
    child.on('exit', () => {
      if (!settled) {
        const finalLine = stdout.trim();
        if (finalLine) handleLine(finalLine);
      }
      if (!settled) {
        finish([], stderr.trim() ? `Cursor ACP unavailable: ${stderr.trim()}` : undefined);
      }
    });

    timeout = setTimeout(() => {
      finish([], 'Cursor ACP model discovery timed out.');
    }, ACP_MODEL_DISCOVERY_TIMEOUT_MS);

    send(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
      },
      clientInfo: { name: 'anvil', version: 'model-discovery' },
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
