import { describe, expect, it } from 'vitest';
import {
  parseBootstrapPayload,
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
