import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  codexHostAuthIdentity,
  readCodexHostAuthJson,
  validateCodexHostAuthJson,
} from '../codex-host-auth.js';

const tempDirs: string[] = [];

function fixtureIdToken(claims: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.fixture-signature`;
}

function fixtureAuthJson(
  options: {
    accountId?: string;
    idToken?: string;
  } = {},
): string {
  return JSON.stringify({
    tokens: {
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
      ...(options.accountId === undefined ? {} : { account_id: options.accountId }),
      id_token:
        options.idToken ??
        fixtureIdToken({
          sub: 'fixture-user',
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'fixture-account',
            chatgpt_user_id: 'fixture-user',
          },
        }),
    },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Codex host auth cache', () => {
  it('reads and validates the auth cache under CODEX_HOME', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-codex-auth-'));
    tempDirs.push(directory);
    const authJson = fixtureAuthJson({ accountId: 'fixture-account' });
    fs.writeFileSync(path.join(directory, 'auth.json'), authJson);
    vi.stubEnv('CODEX_HOME', directory);

    expect(readCodexHostAuthJson()).toBe(authJson);
    expect(() => validateCodexHostAuthJson(authJson)).not.toThrow();
  });

  it('rejects incomplete or oversized caches with redacted errors', () => {
    expect(() =>
      validateCodexHostAuthJson(
        JSON.stringify({
          tokens: {
            access_token: 'fixture-secret',
            refresh_token: 'fixture-refresh',
            id_token: 'invalid-secret-id-token',
          },
        }),
      ),
    ).toThrow('codex-host-auth-invalid');
    expect(() => validateCodexHostAuthJson('x'.repeat(64 * 1024 + 1))).toThrow(
      'codex-host-auth-too-large',
    );
    try {
      validateCodexHostAuthJson(
        JSON.stringify({
          tokens: {
            access_token: 'fixture-secret',
            refresh_token: 'fixture-refresh',
            id_token: 'invalid-secret-id-token',
          },
        }),
      );
      throw new Error('expected invalid auth cache');
    } catch (error) {
      expect((error as Error).message).toBe('codex-host-auth-invalid');
      expect((error as Error).message).not.toContain('invalid-secret-id-token');
    }
  });

  it('accepts Codex TokenData without account_id and falls back to JWT account/user identity', () => {
    const authJson = fixtureAuthJson({
      idToken: fixtureIdToken({
        sub: 'fixture-subject',
        'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user' },
      }),
    });

    expect(codexHostAuthIdentity(authJson)).toEqual({
      identity: JSON.stringify({ accountId: null, userId: 'fixture-user' }),
    });
    expect(() =>
      validateCodexHostAuthJson(
        fixtureAuthJson({
          idToken: fixtureIdToken({
            'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
          }),
        }),
      ),
    ).not.toThrow();
  });
});
