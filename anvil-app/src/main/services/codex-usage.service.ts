import { spawn, execFile } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import type {
  CodexUsageCreditsSnapshot,
  CodexUsageLimitSnapshot,
  CodexUsageRateLimitWindow,
  CodexUsageSnapshot,
  CodexUsageTokenSummary,
} from '../../shared/types.js';

const execFileAsync = promisify(execFile);
const APP_SERVER_TIMEOUT_MS = 18_000;

type JsonObject = Record<string, unknown>;

interface AppServerCallResult {
  initialize: JsonObject;
  rateLimits: JsonObject;
  usage: JsonObject | null;
}

interface CodexCliDetails {
  installed: boolean;
  version?: string;
}

export async function getCodexUsageSnapshot(): Promise<CodexUsageSnapshot> {
  const refreshedAt = new Date().toISOString();
  const cli = await getCodexCliDetails();

  if (!cli.installed) {
    return {
      status: 'unavailable',
      refreshedAt,
      cliInstalled: false,
      defaultLimit: null,
      limits: [],
      tokenUsage: null,
      resetCreditsAvailable: null,
      error: 'Codex CLI is not installed or is not on PATH.',
    };
  }

  try {
    const result = await readCodexAccountUsage();
    const rateLimitsResult = asObject(result.rateLimits.result);
    const defaultRawLimit = asObject(rateLimitsResult?.rateLimits);
    const rawLimitsById = asObject(rateLimitsResult?.rateLimitsByLimitId);
    const defaultLimit = normalizeLimit(defaultRawLimit, 'codex');
    const limits = normalizeLimits(rawLimitsById, defaultLimit);
    const usageResult = result.usage ? asObject(result.usage.result) : null;
    const initializeResult = asObject(result.initialize.result);

    return {
      status: 'available',
      refreshedAt,
      cliInstalled: true,
      cliVersion: cli.version,
      codexHome: asString(initializeResult?.codexHome) ?? undefined,
      appServerUserAgent: asString(initializeResult?.userAgent) ?? undefined,
      defaultLimit,
      limits,
      tokenUsage: normalizeTokenUsage(usageResult),
      resetCreditsAvailable: asNumber(
        asObject(rateLimitsResult?.rateLimitResetCredits)?.availableCount,
      ),
    };
  } catch (err) {
    return {
      status: 'unavailable',
      refreshedAt,
      cliInstalled: true,
      cliVersion: cli.version,
      defaultLimit: null,
      limits: [],
      tokenUsage: null,
      resetCreditsAvailable: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getCodexCliDetails(): Promise<CodexCliDetails> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', ['codex'], {
      timeout: 5_000,
    });
  } catch {
    return { installed: false };
  }

  try {
    const { stdout } = await execFileAsync('codex', ['--version'], { timeout: 5_000 });
    return { installed: true, version: String(stdout).trim() || undefined };
  } catch {
    return { installed: true };
  }
}

function readCodexAccountUsage(): Promise<AppServerCallResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const rl = readline.createInterface({ input: proc.stdout });
    const pending = new Map<number, (message: JsonObject) => void>();
    const stderrChunks: string[] = [];
    let settled = false;
    let nextId = 1;

    const timer = setTimeout(() => {
      const stderr = stderrChunks.join('').trim();
      fail(
        new Error(
          stderr
            ? `Timed out reading Codex usage from app-server: ${stderr}`
            : 'Timed out reading Codex usage from app-server.',
        ),
      );
    }, APP_SERVER_TIMEOUT_MS);

    const cleanup = () => {
      rl.close();
      pending.clear();
      if (!proc.killed) proc.kill();
      clearTimeout(timer);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    proc.on('error', (err) => fail(err));
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString('utf-8'));
    });
    proc.on('exit', (code) => {
      if (!settled && code !== 0) {
        const stderr = stderrChunks.join('').trim();
        fail(new Error(stderr || `Codex app-server exited with code ${code ?? 'unknown'}.`));
      }
    });

    rl.on('line', (line) => {
      let message: JsonObject;
      try {
        message = JSON.parse(line) as JsonObject;
      } catch {
        return;
      }

      const id = asNumber(message.id);
      if (id === null) return;

      const resolver = pending.get(id);
      if (!resolver) return;
      pending.delete(id);
      resolver(message);
    });

    const sendRequest = (method: string, params?: unknown): Promise<JsonObject> => {
      const id = nextId++;
      const request = params === undefined ? { method, id } : { method, id, params };
      proc.stdin.write(`${JSON.stringify(request)}\n`);

      return new Promise((requestResolve, requestReject) => {
        pending.set(id, (message) => {
          if (message.error) {
            requestReject(new Error(readJsonRpcError(message.error)));
            return;
          }
          requestResolve(message);
        });
      });
    };

    const sendNotification = (method: string, params: unknown) => {
      proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
    };

    void (async () => {
      try {
        const initialize = await sendRequest('initialize', {
          clientInfo: {
            name: 'anvil_app',
            title: 'Anvil',
            version: '0.0.0',
          },
          capabilities: {
            experimentalApi: true,
          },
        });
        sendNotification('initialized', {});
        const rateLimits = await sendRequest('account/rateLimits/read');

        let usage: JsonObject | null = null;
        try {
          usage = await sendRequest('account/usage/read');
        } catch {
          usage = null;
        }

        if (settled) return;
        settled = true;
        cleanup();
        resolve({ initialize, rateLimits, usage });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}

function normalizeLimits(
  rawLimitsById: JsonObject | null,
  defaultLimit: CodexUsageLimitSnapshot | null,
): CodexUsageLimitSnapshot[] {
  const limits = rawLimitsById
    ? Object.entries(rawLimitsById)
        .map(([id, raw]) => normalizeLimit(asObject(raw), id))
        .filter((limit): limit is CodexUsageLimitSnapshot => Boolean(limit))
    : [];

  if (limits.length === 0 && defaultLimit) return [defaultLimit];
  return limits.sort((a, b) => {
    if (a.id === 'codex') return -1;
    if (b.id === 'codex') return 1;
    return a.label.localeCompare(b.label);
  });
}

function normalizeLimit(
  raw: JsonObject | null,
  fallbackId: string,
): CodexUsageLimitSnapshot | null {
  if (!raw) return null;

  const id = asString(raw.limitId) ?? fallbackId;
  const label = asString(raw.limitName) ?? (id === 'codex' ? 'Codex' : id);

  return {
    id,
    label,
    planType: asString(raw.planType),
    rateLimitReachedType: asString(raw.rateLimitReachedType),
    primary: normalizeWindow(asObject(raw.primary)),
    secondary: normalizeWindow(asObject(raw.secondary)),
    credits: normalizeCredits(asObject(raw.credits)),
  };
}

function normalizeWindow(raw: JsonObject | null): CodexUsageRateLimitWindow | null {
  if (!raw) return null;

  const usedPercent = clampPercent(asNumber(raw.usedPercent) ?? 0);
  const resetsAtSeconds = asNumber(raw.resetsAt);

  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowDurationMins: asNumber(raw.windowDurationMins),
    resetsAt: resetsAtSeconds ? new Date(resetsAtSeconds * 1000).toISOString() : null,
  };
}

function normalizeCredits(raw: JsonObject | null): CodexUsageCreditsSnapshot | null {
  if (!raw) return null;
  return {
    hasCredits: Boolean(raw.hasCredits),
    unlimited: Boolean(raw.unlimited),
    balance: asString(raw.balance),
  };
}

function normalizeTokenUsage(raw: JsonObject | null): CodexUsageTokenSummary | null {
  if (!raw) return null;

  const summary = asObject(raw.summary);
  const buckets = Array.isArray(raw.dailyUsageBuckets) ? raw.dailyUsageBuckets : [];

  return {
    lifetimeTokens: asNumber(summary?.lifetimeTokens),
    peakDailyTokens: asNumber(summary?.peakDailyTokens),
    longestRunningTurnSec: asNumber(summary?.longestRunningTurnSec),
    currentStreakDays: asNumber(summary?.currentStreakDays),
    longestStreakDays: asNumber(summary?.longestStreakDays),
    recentDailyBuckets: buckets
      .map((bucket) => {
        const item = asObject(bucket);
        const startDate = asString(item?.startDate);
        const tokens = asNumber(item?.tokens);
        if (!startDate || tokens === null) return null;
        return { startDate, tokens };
      })
      .filter((bucket): bucket is { startDate: string; tokens: number } => Boolean(bucket))
      .slice(-14),
  };
}

function readJsonRpcError(error: unknown): string {
  const err = asObject(error);
  return asString(err?.message) ?? 'Codex app-server returned an error.';
}

function asObject(value: unknown): JsonObject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
