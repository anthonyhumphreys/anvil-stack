import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import type { LlmGatewayModel } from '../../shared/types.js';

// Codex 0.154 ModelInfo. Keep optional capabilities conservative until verified with the gateway.
export function buildGatewayCodexCatalog(models: LlmGatewayModel[]) {
  return {
    models: models.map((model, priority) => ({
      slug: model.id,
      display_name: model.displayName ?? model.id,
      description: model.description ?? null,
      default_reasoning_level: model.defaultReasoningEffort ?? null,
      supported_reasoning_levels: model.supportedReasoningEfforts.map((effort) => ({
        effort,
        description: effort,
      })),
      shell_type: 'unified_exec',
      visibility: 'list',
      supported_in_api: true,
      priority,
      availability_nux: null,
      upgrade: null,
      base_instructions:
        'You are a coding agent. Follow the developer instructions and repository guidance. Inspect files before editing and verify your changes with the available tools.',
      model_messages: null,
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      experimental_supported_tools: [],
      input_modalities: ['text'],
      effective_context_window_percent: 95,
      ...(model.contextWindow
        ? { context_window: model.contextWindow, max_context_window: model.contextWindow }
        : {}),
      supports_reasoning_summary_parameter: false,
      supports_search_tool: false,
    })),
  };
}

async function atomicWrite(destination: string, content: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeGatewayCodexCatalog(
  home: string,
  models: LlmGatewayModel[],
): Promise<string[]> {
  const content = JSON.stringify(buildGatewayCodexCatalog(models));
  const hash = createHash('sha256').update(content).digest('hex');
  // Immutable per-catalog paths prevent concurrent sessions/billing modes replacing each other's metadata.
  const catalogPath = join(home, `model-catalog-${hash}.json`);
  await mkdir(home, { recursive: true });
  await atomicWrite(catalogPath, content);
  return [
    '-c',
    `model_catalog_json=${JSON.stringify(catalogPath)}`,
    '-c',
    'features.remote_models=false',
  ];
}

let integrationSync: Promise<void> = Promise.resolve();

/** Preserve only explicitly configured integrations, never personal model credentials or routing. */
export function syncGatewayCodexIntegrations(home: string, personalHome: string): Promise<void> {
  if (resolve(home) === resolve(personalHome)) {
    return Promise.reject(
      new Error('The LLMGateway coding engine needs a separate state directory.'),
    );
  }
  const operation = integrationSync
    .catch(() => undefined)
    .then(async () => {
      await mkdir(home, { recursive: true });
      let personalConfig = '';
      try {
        personalConfig = await readFile(join(personalHome, 'config.toml'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const parsed = personalConfig ? parse(personalConfig) : {};
      await atomicWrite(
        join(home, 'config.toml'),
        parsed.mcp_servers ? stringify({ mcp_servers: parsed.mcp_servers }) : '',
      );
      try {
        await atomicWrite(
          join(home, 'AGENTS.md'),
          await readFile(join(personalHome, 'AGENTS.md'), 'utf8'),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await rm(join(home, 'AGENTS.md'), { force: true });
      }
      const staging = join(home, `.skills-${randomUUID()}`);
      const skills = join(home, 'skills');
      try {
        try {
          await cp(join(personalHome, 'skills'), staging, { recursive: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await rm(skills, { recursive: true, force: true });
        try {
          await rename(staging, skills);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  integrationSync = operation;
  return operation;
}
