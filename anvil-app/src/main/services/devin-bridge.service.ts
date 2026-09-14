import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { DevinCliStatus, DevinDetectedModel } from '../../shared/types.js';

const execFileAsync = promisify(execFile);
const STATUS_CACHE_MS = 30_000;
const ACP_HANDSHAKE_TIMEOUT_MS = 15_000;
let cachedStatus: { at: number; status: DevinCliStatus } | null = null;

interface AcpSessionCatalog {
  models: DevinDetectedModel[];
  defaultModel?: string;
}

/**
 * Parse the model catalog from an ACP `session/new` result. Devin exposes
 * models through `configOptions` (category "model"); the newer ACP `models`
 * field is also accepted so the parser stays provider-neutral.
 */
export function parseDevinAcpModels(output: string): DevinDetectedModel[] {
  return parseAcpSessionCatalog(output).models;
}

export function parseAcpSessionCatalog(output: string): AcpSessionCatalog {
  const models: DevinDetectedModel[] = [];
  const seen = new Set<string>();
  let defaultModel: string | undefined;

  for (const line of output.split(/\r?\n/)) {
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      const result = isRecord(message.result) ? message.result : undefined;

      const modelCatalog = isRecord(result?.models) ? result.models : undefined;
      if (typeof modelCatalog?.currentModelId === 'string' && modelCatalog.currentModelId) {
        defaultModel ??= modelCatalog.currentModelId;
      }
      const availableModels = Array.isArray(modelCatalog?.availableModels)
        ? modelCatalog.availableModels
        : [];
      for (const candidate of availableModels) {
        if (!isRecord(candidate) || typeof candidate.modelId !== 'string') continue;
        pushModel(models, seen, candidate.modelId, candidate.name);
      }

      const configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
      for (const option of configOptions) {
        if (!isRecord(option)) continue;
        const isModelOption = option.id === 'model' || option.category === 'model';
        if (!isModelOption) continue;
        if (typeof option.currentValue === 'string' && option.currentValue) {
          defaultModel ??= option.currentValue;
        }
        const options = Array.isArray(option.options) ? option.options : [];
        for (const candidate of options) {
          if (!isRecord(candidate) || typeof candidate.value !== 'string') continue;
          pushModel(models, seen, candidate.value, candidate.name);
        }
      }
    } catch {
      // ACP logs and partial lines are not catalog responses.
    }
  }

  return { models, defaultModel };
}

function pushModel(
  models: DevinDetectedModel[],
  seen: Set<string>,
  id: string,
  name: unknown,
): void {
  const trimmed = id.trim();
  if (!trimmed || seen.has(trimmed)) return;
  seen.add(trimmed);
  models.push({
    id: trimmed,
    label: typeof name === 'string' && name.trim() ? name.trim() : trimmed,
  });
}

export function parseDevinAuthStatus(output: string): boolean | undefined {
  const text = output.trim().toLowerCase();
  if (!text) return undefined;
  if (text.startsWith('not logged in') || text.includes('not authenticated')) return false;
  if (text.startsWith('logged in') || text.includes('authenticated')) return true;
  return undefined;
}

export async function detectDevinCli(force = false): Promise<DevinCliStatus> {
  if (!force && cachedStatus && Date.now() - cachedStatus.at < STATUS_CACHE_MS) {
    return cachedStatus.status;
  }

  const whichCommand = process.platform === 'win32' ? 'where' : 'which';
  try {
    const [{ stdout: pathOutput }, { stdout: versionOutput }] = await Promise.all([
      execFileAsync(whichCommand, ['devin'], { timeout: 5_000 }),
      execFileAsync('devin', ['--version'], { timeout: 5_000 }),
    ]);
    const path = String(pathOutput).trim().split(/\r?\n/)[0];

    const authenticated = await execFileAsync('devin', ['auth', 'status'], { timeout: 5_000 })
      .then(({ stdout }) => parseDevinAuthStatus(String(stdout)))
      .catch(() => undefined);

    let models: DevinDetectedModel[] = [];
    let defaultModel: string | undefined;
    let error: string | undefined;
    if (authenticated !== false) {
      const catalog = await discoverDevinAcpModels();
      models = catalog.models;
      defaultModel = catalog.defaultModel;
      error = catalog.error;
    }

    const status: DevinCliStatus = {
      installed: true,
      path,
      version: String(versionOutput).trim() || undefined,
      authenticated,
      models,
      defaultModel,
      error,
    };
    cachedStatus = { at: Date.now(), status };
    return status;
  } catch {
    const status: DevinCliStatus = { installed: false, models: [] };
    cachedStatus = { at: Date.now(), status };
    return status;
  }
}

export function invalidateDevinCliCache(): void {
  cachedStatus = null;
}

/**
 * Kick off `devin auth login`, which opens a browser for the hosted sign-in
 * flow. Returns immediately; callers poll `detectDevinCli(true)` to observe the
 * resulting credential state.
 */
export async function startDevinAuthLogin(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('devin', ['auth', 'login'], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (error) => {
      resolve({ ok: false, error: error.message });
    });
    child.on('spawn', () => {
      child.unref();
      invalidateDevinCliCache();
      resolve({ ok: true });
    });
  });
}

async function discoverDevinAcpModels(): Promise<AcpSessionCatalog & { error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('devin', ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (catalog: AcpSessionCatalog, error?: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      child.kill();
      resolve({ ...catalog, error });
    };

    const send = (id: number, method: string, params: Record<string, unknown>) => {
      if (!child.stdin) {
        finish({ models: [] }, 'Devin ACP unavailable: stdin is not writable.');
        return;
      }
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (caught) {
        finish(
          { models: [] },
          caught instanceof Error ? `Devin ACP unavailable: ${caught.message}` : undefined,
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

      if (message.error && message.id !== undefined) {
        const error = isRecord(message.error) ? message.error : undefined;
        finish(
          { models: [] },
          `Devin ACP unavailable: ${typeof error?.message === 'string' ? error.message : 'request failed'}`,
        );
        return;
      }

      if (message.id === 1) {
        // Devin authenticates from `devin auth login` credentials or
        // WINDSURF_API_KEY; no runtime authenticate request is needed for
        // catalog discovery.
        send(2, 'session/new', { cwd: process.cwd(), mcpServers: [] });
      } else if (message.id === 2) {
        finish(parseAcpSessionCatalog(JSON.stringify(message)));
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
      finish(
        { models: [] },
        caught instanceof Error ? `Devin ACP unavailable: ${caught.message}` : undefined,
      );
    });
    child.on('exit', () => {
      if (!settled) {
        const finalLine = stdout.trim();
        if (finalLine) handleLine(finalLine);
      }
      if (!settled) {
        finish(
          { models: [] },
          stderr.trim() ? `Devin ACP unavailable: ${stderr.trim()}` : undefined,
        );
      }
    });

    timeout = setTimeout(() => {
      finish({ models: [] }, 'Devin ACP model discovery timed out.');
    }, ACP_HANDSHAKE_TIMEOUT_MS);

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
