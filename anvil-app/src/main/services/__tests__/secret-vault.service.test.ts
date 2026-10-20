import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProtectedVaultKey, SecretVaultStore } from '../secret-vault.service.js';

const PASSPHRASE = 'a long test vault passphrase';
let root: string;
let vault: SecretVaultStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anvil-vault-'));
  vault = new SecretVaultStore(join(root, 'data'));
});
afterEach(() => {
  vault.lock();
  rmSync(root, { recursive: true, force: true });
});

describe('passphrase vault', () => {
  it('finishes an authorized encryption after lock without allowing new credential reads', async () => {
    await vault.setup({ mode: 'passphrase', passphrase: PASSPHRASE });
    const operation = vault.encryptionLease();
    vault.lock();
    const encrypted = operation.encrypt('rotated-session-token');
    expect(() => vault.decrypt(encrypted)).toThrow('locked');
    expect(() => vault.encryptionLease()).toThrow('locked');
    operation.dispose();
    expect(() => operation.encrypt('another')).toThrow('finished');
    await vault.unlock(PASSPHRASE);
    expect(vault.decrypt(encrypted)).toBe('rotated-session-token');
  });
  it('encrypts credentials, persists only metadata and requires unlock after restart', async () => {
    await vault.setup({ mode: 'passphrase', passphrase: PASSPHRASE });
    const encrypted = vault.encrypt('saved-api-token');
    const metadata = readFileSync(vault.configPath, 'utf8');
    expect(metadata).not.toContain(PASSPHRASE);
    expect(metadata).not.toContain('saved-api-token');
    expect(encrypted.toString()).not.toContain('saved-api-token');
    expect(vault.decrypt(encrypted)).toBe('saved-api-token');
    const restarted = new SecretVaultStore(vault.dataDir);
    expect(restarted.status().state).toBe('locked');
    expect(() => restarted.encrypt('new-secret')).toThrow('locked');
    await restarted.unlock(PASSPHRASE);
    expect(restarted.decrypt(encrypted)).toBe('saved-api-token');
    restarted.lock();
    if (process.platform !== 'win32') expect(statSync(vault.configPath).mode & 0o777).toBe(0o600);
  });

  it('preserves bytes and current unlock on a wrong passphrase; refuses replacement', async () => {
    await vault.setup({ mode: 'passphrase', passphrase: PASSPHRASE });
    const encrypted = vault.encrypt('original');
    const configuration = readFileSync(vault.configPath);
    await expect(vault.unlock('wrong but long enough')).rejects.toThrow('Check your passphrase');
    expect(vault.decrypt(encrypted)).toBe('original');
    await expect(
      vault.setup({ mode: 'passphrase', passphrase: 'different passphrase' }),
    ).rejects.toThrow('already exists');
    expect(readFileSync(vault.configPath)).toEqual(configuration);
    vault.lock();
    await expect(vault.unlock('wrong again')).rejects.toThrow('retained');
    expect(vault.status().state).toBe('locked');
  });

  it('authenticates ciphertext and vault identity', async () => {
    await vault.setup({ mode: 'passphrase', passphrase: PASSPHRASE });
    const encrypted = vault.encrypt('token');
    const corrupt = Buffer.from(encrypted);
    corrupt[corrupt.length - 1] ^= 1;
    expect(() => vault.decrypt(corrupt)).toThrow();
    const other = new SecretVaultStore(join(root, 'other'));
    await other.setup({ mode: 'passphrase', passphrase: PASSPHRASE });
    expect(() => other.decrypt(encrypted)).toThrow('different vault');
    other.lock();
  });

  it('does not replace corrupt metadata or silently select another provider', async () => {
    await vault.setup({ mode: 'passphrase', passphrase: PASSPHRASE });
    writeFileSync(vault.configPath, '{bad-json');
    expect(vault.status().state).toBe('invalid');
    expect(() => vault.preferredProvider()).toThrow('retained');
    await expect(vault.setup({ mode: 'passphrase', passphrase: PASSPHRASE })).rejects.toThrow();
    expect(readFileSync(vault.configPath, 'utf8')).toBe('{bad-json');
  });

  it('prevents competing processes from replacing a newly configured vault', async () => {
    const other = new SecretVaultStore(vault.dataDir);
    const setup = vault.setup({ mode: 'passphrase', passphrase: PASSPHRASE });
    await expect(
      other.setup({ mode: 'passphrase', passphrase: 'another passphrase' }),
    ).rejects.toThrow('Another process');
    await setup;
    expect(other.status().state).toBe('locked');
    await other.unlock(PASSPHRASE);
    expect(other.decrypt(vault.encrypt('retained'))).toBe('retained');
    other.lock();
  });
});

describe.skipIf(process.platform === 'win32')('key file vault', () => {
  it('keeps the key outside the database and unlocks across processes without a passphrase', async () => {
    const keyFilePath = join(root, 'vault.key');
    await vault.setup({ mode: 'key-file', keyFilePath });
    expect(statSync(keyFilePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyFilePath).length).toBe(32);
    const encrypted = vault.encrypt('unattended-token');
    vault.lock();
    expect(vault.status().state).toBe('locked');
    const restarted = new SecretVaultStore(vault.dataDir);
    expect(restarted.status().state).toBe('ready');
    expect(restarted.decrypt(encrypted)).toBe('unattended-token');
    restarted.lock();
  });

  it('refuses broad permissions, symlinks and key paths inside data backups', async () => {
    const unsafe = join(root, 'unsafe.key');
    writeFileSync(unsafe, Buffer.alloc(32), { mode: 0o644 });
    expect(() => readProtectedVaultKey(unsafe)).toThrow('owner-only');
    chmodSync(unsafe, 0o600);
    const linked = join(root, 'link.key');
    symlinkSync(unsafe, linked);
    expect(() => readProtectedVaultKey(linked)).toThrow('owner-only');
    await expect(
      vault.setup({ mode: 'key-file', keyFilePath: join(vault.dataDir, 'key') }),
    ).rejects.toThrow('outside');
    expect(existsSync(join(vault.dataDir, 'key'))).toBe(false);
    expect(existsSync(vault.configPath)).toBe(false);
  });

  it('does not regenerate a missing key or accept a replacement key', async () => {
    const keyFilePath = join(root, 'vault.key');
    await vault.setup({ mode: 'key-file', keyFilePath });
    const encrypted = vault.encrypt('retained');
    vault.lock();
    unlinkSync(keyFilePath);
    const restarted = new SecretVaultStore(vault.dataDir);
    expect(restarted.status().state).toBe('unavailable');
    expect(existsSync(keyFilePath)).toBe(false);
    writeFileSync(keyFilePath, Buffer.alloc(32), { mode: 0o600 });
    await expect(restarted.unlock()).rejects.toThrow('could not unlock');
    expect(() => restarted.decrypt(encrypted)).toThrow('unavailable');
  });
});
