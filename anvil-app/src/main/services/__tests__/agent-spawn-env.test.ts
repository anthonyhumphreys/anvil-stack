import { afterEach, describe, expect, it } from 'vitest';
import { providerSpawnEnv } from '../agent-spawn-env.js';

const STASHED: Record<string, string | undefined> = {};
const VARS = [
  'PATH',
  'HOME',
  'GH_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'ANVIL_INTERNAL_TOKEN',
  'SSH_AUTH_SOCK',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'CODEX_HOME',
  'HTTPS_PROXY',
  'OTEL_SDK_DISABLED',
];

function stash() {
  for (const name of VARS) STASHED[name] = process.env[name];
}
function restore() {
  for (const name of VARS) {
    if (STASHED[name] === undefined) delete process.env[name];
    else process.env[name] = STASHED[name];
  }
}

describe('providerSpawnEnv', () => {
  afterEach(restore);

  it('keeps base session vars and drops ambient credentials', () => {
    stash();
    process.env['GH_TOKEN'] = 'gh-secret';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'aws-secret';
    process.env['ANVIL_INTERNAL_TOKEN'] = 'anvil-secret';
    const env = providerSpawnEnv();
    expect(env['PATH']).toBe(process.env['PATH']);
    expect(env['HOME']).toBe(process.env['HOME']);
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['ANVIL_INTERNAL_TOKEN']).toBeUndefined();
  });

  it('passes provider credential vars as target-local bindings', () => {
    stash();
    process.env['OPENAI_API_KEY'] = 'sk-openai';
    process.env['AZURE_OPENAI_API_KEY'] = 'azure-key';
    const env = providerSpawnEnv();
    expect(env['OPENAI_API_KEY']).toBe('sk-openai');
    expect(env['AZURE_OPENAI_API_KEY']).toBe('azure-key');
  });

  it('keeps git transport and provider config vars', () => {
    stash();
    process.env['SSH_AUTH_SOCK'] = '/tmp/ssh-agent.sock';
    process.env['CODEX_HOME'] = '/tmp/codex-home';
    process.env['HTTPS_PROXY'] = 'http://proxy:8080';
    const env = providerSpawnEnv();
    expect(env['SSH_AUTH_SOCK']).toBe('/tmp/ssh-agent.sock');
    expect(env['CODEX_HOME']).toBe('/tmp/codex-home');
    expect(env['HTTPS_PROXY']).toBe('http://proxy:8080');
  });

  it('lets explicit bindings win and undefined remove a var', () => {
    stash();
    process.env['OTEL_SDK_DISABLED'] = 'false';
    const env = providerSpawnEnv({
      OTEL_SDK_DISABLED: 'true',
      HTTPS_PROXY: undefined,
    });
    expect(env['OTEL_SDK_DISABLED']).toBe('true');
    expect(env['HTTPS_PROXY']).toBeUndefined();
  });
});
