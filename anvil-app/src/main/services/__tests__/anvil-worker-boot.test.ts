import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseBootstrapPayload,
  prepareWorkerStorage,
  readBootstrap,
} from '../../../../cloud/images/anvil-worker/boot.mjs';

const VALID = {
  kind: 'anvil.mesh-environment',
  schemaVersion: '0.2',
  environmentId: 'env_1',
  provider: 'vercel-sandbox',
  backendUrl: 'https://api.test',
  enrollmentCode: 'anvil-ec-AAAAA-BBBBB-CCCCC-DDDDD',
  ttlSeconds: 1800,
};

describe('anvil-worker boot payload', () => {
  it('parses a valid bootstrap document', () => {
    const doc = parseBootstrapPayload(JSON.stringify(VALID));
    expect(doc.environmentId).toBe('env_1');
    expect(doc.provider).toBe('vercel-sandbox');
    expect(doc.enrollmentCode).toBe('anvil-ec-AAAAA-BBBBB-CCCCC-DDDDD');
    expect(doc.ttlSeconds).toBe(1800);
  });

  it('rejects non-JSON and wrong document kinds', () => {
    expect(() => parseBootstrapPayload('not json')).toThrow('not valid JSON');
    expect(() => parseBootstrapPayload(JSON.stringify({ kind: 'anvil.agent-sandbox' }))).toThrow(
      'unrecognized bootstrap document',
    );
  });

  it('rejects documents missing required fields', () => {
    for (const field of ['environmentId', 'backendUrl', 'enrollmentCode'] as const) {
      const doc = { ...VALID, [field]: '' };
      expect(() => parseBootstrapPayload(JSON.stringify(doc))).toThrow(`missing ${field}`);
    }
    expect(() => parseBootstrapPayload(JSON.stringify({ ...VALID, ttlSeconds: 0 }))).toThrow(
      'ttlSeconds',
    );
  });

  it('fails closed on keying material — pairing payloads are never bootstrap', () => {
    // Legacy 0.1 shape with a `pairing` field.
    expect(() =>
      parseBootstrapPayload(
        JSON.stringify({
          ...VALID,
          pairing: 'anvil-pair-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF',
        }),
      ),
    ).toThrow('keying material');
    // A pairing payload smuggled through the code field.
    expect(() =>
      parseBootstrapPayload(
        JSON.stringify({
          ...VALID,
          enrollmentCode: 'anvil-pair-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF',
        }),
      ),
    ).toThrow('keying material');
  });

  it('reads the payload from argv first, then env, then file', () => {
    const argvDoc = JSON.stringify({ ...VALID, environmentId: 'env_argv' });
    const envDoc = JSON.stringify({ ...VALID, environmentId: 'env_env' });
    const fileDoc = JSON.stringify({ ...VALID, environmentId: 'env_file' });

    expect(
      readBootstrap(['node', 'boot.mjs', argvDoc], {
        ANVIL_BOOTSTRAP_JSON: envDoc,
      }).environmentId,
    ).toBe('env_argv');

    expect(
      readBootstrap(['node', 'boot.mjs'], { ANVIL_BOOTSTRAP_JSON: envDoc }).environmentId,
    ).toBe('env_env');

    expect(
      readBootstrap(['node', 'boot.mjs'], { ANVIL_BOOTSTRAP_FILE: '/tmp/boot.json' }, () => fileDoc)
        .environmentId,
    ).toBe('env_file');
  });

  it('fails loudly when no channel carries a payload', () => {
    expect(() => readBootstrap(['node', 'boot.mjs'], {})).toThrow('no bootstrap payload');
  });
});

describe('anvil-worker credential storage preflight', () => {
  const unconfigured = {
    provider: 'keychain',
    state: 'unavailable',
    vault: { configured: false, state: 'unavailable' },
  };
  const ready = {
    provider: 'vault',
    state: 'ready',
    vault: { configured: true, mode: 'key-file', state: 'ready' },
  };

  it('sets up an owner-only key-file vault before enrollment on a fresh worker', () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-worker-vault-'));
    const calls: string[][] = [];
    const responses = [unconfigured, ready];
    try {
      prepareWorkerStorage(
        join(root, 'data'),
        join(root, 'run', 'vault', 'worker.key'),
        (_command, args, options) => {
          calls.push(args.slice(1));
          expect(options.env.ANVIL_DATA_DIR).toBe(join(root, 'data'));
          const status = args.at(-1) === 'status';
          return {
            pid: 1,
            output: [null, null],
            stdout: status
              ? `[Database] Opening database at ${join(root, 'data', 'anvil.db')}\n${JSON.stringify(responses.shift())}`
              : '{}',
            stderr: '',
            status: 0,
            signal: null,
          };
        },
      );
      expect(calls).toEqual([
        ['vault', 'status'],
        ['vault', 'setup', '--key-file', join(root, 'run', 'vault', 'worker.key')],
        ['vault', 'status'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a configured but unavailable vault and refuses enrollment', () => {
    let calls = 0;
    expect(() =>
      prepareWorkerStorage('/data', '/run/vault/worker.key', () => {
        calls += 1;
        return {
          pid: 1,
          output: [null, null],
          stdout: JSON.stringify({
            provider: 'vault',
            state: 'unavailable',
            vault: { configured: true, mode: 'key-file', state: 'unavailable' },
          }),
          stderr: '',
          status: 0,
          signal: null,
        };
      }),
    ).toThrow('restore its original key');
    expect(calls).toBe(1);
  });

  it('does not replace invalid existing storage', () => {
    let calls = 0;
    expect(() =>
      prepareWorkerStorage('/data', '/run/vault/worker.key', () => {
        calls += 1;
        return {
          pid: 1,
          output: [null, null],
          stdout: JSON.stringify({
            provider: 'keychain',
            state: 'invalid',
            vault: { configured: false, state: 'invalid' },
          }),
          stderr: '',
          status: 0,
          signal: null,
        };
      }),
    ).toThrow('restore its original key');
    expect(calls).toBe(1);
  });
});
