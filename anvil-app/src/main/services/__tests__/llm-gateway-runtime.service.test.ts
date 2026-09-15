import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import {
  buildGatewayCodexCatalog,
  syncGatewayCodexIntegrations,
  writeGatewayCodexCatalog,
} from '../llm-gateway-runtime.service.js';
import type { LlmGatewayModel } from '../../../shared/types.js';

let root: string;
let personal: string;
let managed: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'anvil-gateway-home-test-'));
  personal = join(root, 'personal');
  managed = join(root, 'managed');
  await mkdir(personal);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const models: LlmGatewayModel[] = [
  {
    id: 'gateway-a',
    displayName: 'A',
    contextWindow: 111111,
    supportedReasoningEfforts: [],
    serviceTiers: [],
  },
  {
    id: 'gateway-b',
    displayName: 'B',
    contextWindow: 222222,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['high'],
    serviceTiers: [],
  },
];

describe('gateway runtime configuration', () => {
  it('mirrors instructions, skills and parsed MCP config without copying personal auth or model settings', async () => {
    const config =
      'model_provider = "personal"\nexperimental_bearer_token = "personal-secret"\n[mcp_servers."quoted.server"]\ncommand = "node"\nargs = [\n "server.js",\n]\n[mcp_servers."quoted.server".env]\nMCP_TOKEN = "connector-secret"\n[model_providers.personal]\nbase_url = "https://personal.invalid"\n';
    await writeFile(join(personal, 'config.toml'), config);
    await writeFile(join(personal, 'auth.json'), '{"token":"personal-secret"}');
    await writeFile(join(personal, 'AGENTS.md'), 'Project instructions');
    await mkdir(join(personal, 'skills', 'example'), { recursive: true });
    await writeFile(join(personal, 'skills', 'example', 'SKILL.md'), 'Skill instructions');
    await Promise.all([
      syncGatewayCodexIntegrations(managed, personal),
      syncGatewayCodexIntegrations(managed, personal),
    ]);
    expect(parse(await readFile(join(managed, 'config.toml'), 'utf8'))).toEqual({
      mcp_servers: {
        'quoted.server': {
          command: 'node',
          args: ['server.js'],
          env: { MCP_TOKEN: 'connector-secret' },
        },
      },
    });
    expect(await readFile(join(managed, 'AGENTS.md'), 'utf8')).toBe('Project instructions');
    expect(await readFile(join(managed, 'skills', 'example', 'SKILL.md'), 'utf8')).toBe(
      'Skill instructions',
    );
    expect(await readdir(managed)).not.toContain('auth.json');
    expect(await readFile(join(personal, 'config.toml'), 'utf8')).toBe(config);
    expect(await readFile(join(personal, 'auth.json'), 'utf8')).toBe('{"token":"personal-secret"}');
    await rm(join(personal, 'skills'), { recursive: true });
    await rm(join(personal, 'AGENTS.md'));
    await syncGatewayCodexIntegrations(managed, personal);
    expect(await readdir(managed)).toEqual(['config.toml']);
  });

  it('refuses to mirror over the personal directory', async () => {
    await expect(syncGatewayCodexIntegrations(personal, personal)).rejects.toThrow('separate');
    expect(await readdir(personal)).toEqual([]);
  });

  it('writes immutable complete catalogs so parallel billing modes cannot replace each other', async () => {
    const [all, one] = await Promise.all([
      writeGatewayCodexCatalog(managed, models),
      writeGatewayCodexCatalog(managed, [models[0]]),
    ]);
    const allPath = JSON.parse(all[1].slice('model_catalog_json='.length));
    const onePath = JSON.parse(one[1].slice('model_catalog_json='.length));
    expect(allPath).not.toBe(onePath);
    const catalog = JSON.parse(await readFile(allPath, 'utf8'));
    expect(catalog.models.map((model: { context_window: number }) => model.context_window)).toEqual(
      [111111, 222222],
    );
    expect(catalog.models[0]).toMatchObject({
      default_reasoning_level: null,
      supported_reasoning_levels: [],
    });
    expect(catalog.models[1].supported_reasoning_levels).toEqual([
      { effort: 'high', description: 'high' },
    ]);
    expect(JSON.parse(await readFile(onePath, 'utf8')).models).toHaveLength(1);
    expect(buildGatewayCodexCatalog(models).models[0]).not.toHaveProperty('prefer_websockets');
  });
});
