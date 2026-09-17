import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

describe('daemon electron stub', () => {
  let safeStorage: typeof import('../electron-stub.js').safeStorage;
  let app: typeof import('../electron-stub.js').app;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'anvil-daemon-test-'));
    process.env.ANVIL_DATA_DIR = dataDir;
    const stub = await import('../electron-stub.js');
    safeStorage = stub.safeStorage;
    app = stub.app;
  });

  it('resolves userData under ANVIL_DATA_DIR', () => {
    expect(app.getPath('userData')).toBe(dataDir);
  });

  it('round-trips safeStorage encrypt/decrypt', () => {
    const secret = 'device-session-token-abc123';
    const encrypted = safeStorage.encryptString(secret);
    expect(encrypted.toString('utf8')).not.toContain(secret);
    expect(safeStorage.decryptString(encrypted)).toBe(secret);
  });

  it('stores the master key with 0600 permissions', () => {
    safeStorage.encryptString('x');
    const mode = statSync(join(dataDir, '.daemon-key')).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(join(dataDir, '.daemon-key')).length).toBe(32);
  });

  it('rejects ciphertext with a bad version tag', () => {
    const encrypted = safeStorage.encryptString('y');
    encrypted[0] = 0x78; // 'v1' → 'x1'
    expect(() => safeStorage.decryptString(encrypted)).toThrow();
  });
});
