import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CodexCliStatus, CodexDetectedModel, ReasoningEffort } from '../../shared/types.js';
import { normaliseReasoningEffort } from '../../shared/codex-models.js';

const execFileAsync = promisify(execFile);

let cachedStatus: { at: number; status: CodexCliStatus } | null = null;
const STATUS_CACHE_MS = 30_000;

/**
 * Detect if Codex CLI is installed and get its status.
 */
export async function detectCodexCli(): Promise<CodexCliStatus> {
  if (cachedStatus && Date.now() - cachedStatus.at < STATUS_CACHE_MS) {
    return cachedStatus.status;
  }

  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout: codexPath } = await execFileAsync(whichCmd, ['codex']);
    const trimmedPath = codexPath.trim();

    let version: string | undefined;
    try {
      const { stdout } = await execFileAsync('codex', ['--version']);
      const match = stdout.match(/(\d+\.\d+\.\d+)/);
      version = match?.[1];
    } catch {
      /* version check failed, CLI still exists */
    }

    const config = readCodexConfigSummary();
    const [features, models] = await Promise.all([listCodexFeatureFlags(), listCodexModels()]);

    const status = {
      installed: true,
      version,
      path: trimmedPath,
      configuredForFoundry: config.configuredProvider === 'azure',
      authConfigured: fs.existsSync(path.join(getCodexHome(), 'auth.json')),
      configPath: config.configPath,
      configuredModel: config.configuredModel,
      configuredProvider: config.configuredProvider,
      configuredReasoningEffort: config.configuredReasoningEffort,
      agentMaxThreads: config.agentMaxThreads,
      webSearchMode: config.webSearchMode,
      features,
      models,
    };
    cachedStatus = { at: Date.now(), status };
    return status;
  } catch {
    return { installed: false, configuredForFoundry: false };
  }
}

async function listCodexModels(): Promise<CodexDetectedModel[] | undefined> {
  try {
    const { stdout } = await execFileAsync('codex', ['debug', 'models'], {
      timeout: 10_000,
      maxBuffer: 12 * 1024 * 1024,
    });
    const payload = JSON.parse(stdout) as { models?: unknown[] };
    if (!Array.isArray(payload.models)) return undefined;

    return payload.models
      .map(normaliseDebugModel)
      .filter((model): model is CodexDetectedModel => Boolean(model))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  } catch {
    return undefined;
  }
}

function normaliseDebugModel(value: unknown): CodexDetectedModel | null {
  if (!value || typeof value !== 'object') return null;
  const model = value as Record<string, unknown>;
  const id = readString(model.slug) ?? readString(model.id) ?? readString(model.model);
  if (!id) return null;

  const supportedReasoningEfforts = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
        .map((item) =>
          item && typeof item === 'object'
            ? normaliseReasoningEffort(readString((item as Record<string, unknown>).effort))
            : null,
        )
        .filter((effort): effort is ReasoningEffort => Boolean(effort))
    : [];

  return {
    id,
    displayName: readString(model.display_name) ?? readString(model.displayName) ?? id,
    description: readString(model.description),
    hidden: model.visibility === 'hidden' || model.hidden === true,
    defaultReasoningEffort: readString(model.default_reasoning_level)
      ? normaliseReasoningEffort(readString(model.default_reasoning_level))
      : undefined,
    supportedReasoningEfforts,
    serviceTiers: Array.isArray(model.service_tiers)
      ? model.service_tiers
          .map((tier) => {
            if (!tier || typeof tier !== 'object') return null;
            const item = tier as Record<string, unknown>;
            const tierId = readString(item.id);
            if (!tierId) return null;
            return {
              id: tierId,
              name: readString(item.name) ?? tierId,
              description: readString(item.description),
            };
          })
          .filter((tier): tier is { id: string; name: string; description?: string } =>
            Boolean(tier),
          )
      : [],
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Check if Codex CLI is configured to use Azure Foundry.
 */
function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function readCodexConfigSummary(): Pick<
  CodexCliStatus,
  | 'configPath'
  | 'configuredModel'
  | 'configuredProvider'
  | 'configuredReasoningEffort'
  | 'agentMaxThreads'
  | 'webSearchMode'
> {
  const configPaths = [
    path.join(getCodexHome(), 'config.toml'),
    path.join(os.homedir(), '.codex', 'config.json'),
    path.join(os.homedir(), '.config', 'codex', 'config.toml'),
    path.join(os.homedir(), '.config', 'codex', 'config.json'),
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        if (configPath.endsWith('.json')) {
          const config = JSON.parse(content);
          return {
            configPath,
            configuredModel: typeof config.model === 'string' ? config.model : undefined,
            configuredProvider:
              typeof config.model_provider === 'string'
                ? config.model_provider
                : typeof config.provider === 'string'
                  ? config.provider
                  : undefined,
            configuredReasoningEffort:
              typeof config.model_reasoning_effort === 'string'
                ? config.model_reasoning_effort
                : undefined,
            agentMaxThreads: readPositiveInteger(config.agents?.max_threads),
            webSearchMode: parseWebSearchMode(config.web_search),
          };
        }

        return {
          configPath,
          configuredModel: readTomlString(content, 'model'),
          configuredProvider: readTomlString(content, 'model_provider'),
          configuredReasoningEffort: readTomlString(content, 'model_reasoning_effort'),
          agentMaxThreads: readTomlAgentsMaxThreads(content),
          webSearchMode: parseWebSearchMode(readTomlString(content, 'web_search')),
        };
      } catch {
        /* ignore parse errors */
      }
    }
  }

  return {};
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function readTomlAgentsMaxThreads(content: string): number | undefined {
  const agentsSection = content.match(
    /^\s*\[agents\]\s*$([\s\S]*?)(?=^\s*\[[^\]]+\]\s*$|(?![\s\S]))/m,
  )?.[1];
  if (!agentsSection) return undefined;
  const value = agentsSection.match(/^\s*max_threads\s*=\s*(\d+)\s*(?:#.*)?$/m)?.[1];
  return value ? readPositiveInteger(Number(value)) : undefined;
}

export function setCodexAgentMaxThreads(maxThreads: number): void {
  const configPath = path.join(getCodexHome(), 'config.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
  const updated = updateTomlAgentsMaxThreads(content, maxThreads);
  const temporaryPath = `${configPath}.anvil-tmp`;
  fs.writeFileSync(temporaryPath, updated, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(temporaryPath, configPath);
  cachedStatus = null;
}

export function updateTomlAgentsMaxThreads(content: string, maxThreads: number): string {
  if (!Number.isInteger(maxThreads) || maxThreads < 1 || maxThreads > 64) {
    throw new Error('Maximum concurrent agents must be an integer between 1 and 64.');
  }

  const sectionMatch = /^\s*\[agents\]\s*$/m.exec(content);
  let updated: string;

  if (!sectionMatch) {
    const separator =
      content.length === 0 || content.endsWith('\n\n')
        ? ''
        : content.endsWith('\n')
          ? '\n'
          : '\n\n';
    updated = `${content}${separator}[agents]\nmax_threads = ${maxThreads}\n`;
  } else {
    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    const nextSectionOffset = content.slice(sectionStart).search(/^\s*\[[^\]]+\]\s*$/m);
    const sectionEnd = nextSectionOffset === -1 ? content.length : sectionStart + nextSectionOffset;
    const section = content.slice(sectionStart, sectionEnd);
    const maxThreadsPattern = /^(\s*)max_threads\s*=\s*\d+(\s*(?:#.*)?)$/m;
    const nextSection = maxThreadsPattern.test(section)
      ? section.replace(maxThreadsPattern, `$1max_threads = ${maxThreads}$2`)
      : `${section.replace(/\s*$/, '')}\nmax_threads = ${maxThreads}\n`;
    updated = content.slice(0, sectionStart) + nextSection + content.slice(sectionEnd);
  }

  return updated;
}

function readTomlString(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'));
  return match?.[1];
}

function parseWebSearchMode(value: unknown): CodexCliStatus['webSearchMode'] {
  return value === 'disabled' || value === 'cached' || value === 'indexed' || value === 'live'
    ? value
    : undefined;
}

async function listCodexFeatureFlags(): Promise<CodexCliStatus['features']> {
  try {
    const { stdout } = await execFileAsync('codex', ['features', 'list'], { timeout: 8_000 });
    const features: NonNullable<CodexCliStatus['features']> = {};
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^(\S+)\s{2,}(.+?)\s{2,}(true|false)\s*$/);
      if (!match) continue;
      features[match[1]] = { stage: match[2].trim(), enabled: match[3] === 'true' };
    }
    return features;
  } catch {
    return undefined;
  }
}

/**
 * Get install instructions for Codex CLI.
 */
export function getCodexInstallInstructions(): string {
  return [
    'Codex CLI is required for the chat feature.',
    '',
    'Install or update Codex:',
    '  curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    '',
    'Then run `codex` and sign in with ChatGPT.',
    '',
    'API-key and Azure provider paths remain available for workflows that need them.',
  ].join('\n');
}
