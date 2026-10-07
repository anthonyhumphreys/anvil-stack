import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  getSelectedStorageBackend: vi.fn(),
}));
const environment = vi.hoisted(() => ({ dataDir: '' }));

vi.mock('electron', () => ({
  safeStorage: safeStorageMock,
  app: { getPath: () => environment.dataDir },
}));

import {
  configureSecretVault,
  assertSecretStorageReady,
  decryptSecret,
  decryptSecretStrict,
  encryptSecret,
  getSecretStorageStatus,
  lockSecretVault,
  readStoredSecret,
  resetSecretStorageForTests,
  selectSecretStorageProvider,
  unlockSecretVault,
} from '../auth.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
  environment.dataDir = mkdtempSync(join(tmpdir(), 'anvil-auth-vault-'));
  resetSecretStorageForTests();
});
afterEach(() => {
  resetSecretStorageForTests();
  rmSync(environment.dataDir, { recursive: true, force: true });
});

describe('decryptSecret', () => {
  it('returns undefined when secure storage is unavailable instead of decoding stored bytes', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    const result = decryptSecret(Buffer.from('plain-text-token', 'utf-8'), 'settings.openaiApiKey');

    expect(result).toBeUndefined();
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
  });

  it('treats storage availability errors as unavailable', () => {
    safeStorageMock.isEncryptionAvailable.mockImplementation(() => {
      throw new Error('keychain unavailable');
    });

    const result = decryptSecret(Buffer.from('ciphertext'), 'settings.openaiApiKey');

    expect(result).toBeUndefined();
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
  });

  it('returns decrypted secrets when safeStorage succeeds', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.decryptString.mockReturnValue('token-123');

    const result = decryptSecret(Buffer.from('ciphertext'), 'settings.openaiApiKey');

    expect(result).toBe('token-123');
    expect(safeStorageMock.decryptString).toHaveBeenCalled();
  });

  it('reads legacy plaintext buffers when secure storage is available', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error(
        'Error while decrypting the ciphertext provided to safeStorage.decryptString.',
      );
    });

    const result = decryptSecret(Buffer.from('plain-text-token', 'utf-8'), 'settings.openaiApiKey');

    expect(result).toBe('plain-text-token');
  });

  it('treats unreadable buffers as unset instead of throwing', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error(
        'Error while decrypting the ciphertext provided to safeStorage.decryptString.',
      );
    });

    const result = decryptSecret(Buffer.from([0, 159, 146, 150]), 'settings.openaiApiKey');

    expect(result).toBeUndefined();
  });
});

describe('assertSecretStorageReady', () => {
  it('fails with vault setup guidance when the OS keychain is unavailable', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    expect(() => assertSecretStorageReady()).toThrow(
      'Set up encrypted credential storage on this device before signing in.',
    );
  });

  it('asks to unlock a configured vault before sign-in', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    await configureSecretVault({ mode: 'passphrase', passphrase: 'test vault passphrase' });
    selectSecretStorageProvider('vault');
    lockSecretVault();

    expect(() => assertSecretStorageReady()).toThrow(
      'Unlock your encrypted credential vault before signing in.',
    );
  });
});

describe('storage providers', () => {
  it('uses the OS keychain by default and tags new encrypted values', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockReturnValue(Buffer.from('opaque-ciphertext'));
    safeStorageMock.decryptString.mockReturnValue('token');
    const stored = encryptSecret('token');
    expect(stored.toString()).toBe('anvil-secret:v1:keychain:opaque-ciphertext');
    expect(decryptSecretStrict(stored)).toBe('token');
    expect(safeStorageMock.decryptString).toHaveBeenCalledWith(Buffer.from('opaque-ciphertext'));
  });

  it('works without OS storage, reports lock distinctly and never falls back to plaintext', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    await configureSecretVault({ mode: 'passphrase', passphrase: 'test unlock passphrase' });
    const stored = encryptSecret('saved-key');
    expect(decryptSecretStrict(stored)).toBe('saved-key');
    lockSecretVault();
    expect(readStoredSecret(stored).state).toBe('locked');
    expect(() => encryptSecret('no-plaintext')).toThrow('locked');
    await expect(unlockSecretVault('wrong')).rejects.toThrow('retained');
    expect(readStoredSecret(stored).state).toBe('locked');
    await unlockSecretVault('test unlock passphrase');
    expect(decryptSecret(stored)).toBe('saved-key');
  });

  it('reads values by their own provider after an explicit switch', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockImplementation((value) => Buffer.from(`enc:${value}`));
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString().slice(4));
    const keychainValue = encryptSecret('old-keychain-key');
    await configureSecretVault({ mode: 'passphrase', passphrase: 'test vault passphrase' });
    const vaultValue = encryptSecret('new-vault-key');
    selectSecretStorageProvider('keychain');
    expect(decryptSecret(keychainValue)).toBe('old-keychain-key');
    expect(decryptSecret(vaultValue)).toBe('new-vault-key');
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(readStoredSecret(keychainValue).state).toBe('unavailable');
    expect(decryptSecret(vaultValue)).toBe('new-vault-key');
  });

  it('refuses the Electron basic_text backend and authenticated ciphertext fallback', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text');
    expect(getSecretStorageStatus().state).toBe('unavailable');
    expect(() => encryptSecret('key')).toThrow('Secure storage is unavailable');
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('secret-value-in-error');
    });
    expect(
      readStoredSecret(Buffer.from('anvil-secret:v1:keychain:printable-ciphertext')).state,
    ).toBe('invalid');
    expect(decryptSecretStrict(Buffer.from('legacy-plaintext'))).toBeUndefined();
    expect(readStoredSecret(Buffer.from('anvil-secret:v2:unknown:value')).state).toBe('invalid');
  });

  it('does not expose secret contents from storage errors', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockImplementation(() => {
      throw new Error('private-api-key');
    });
    expect(() => encryptSecret('private-api-key')).toThrow('Credential storage could not encrypt');
    try {
      encryptSecret('private-api-key');
    } catch (error) {
      expect(String(error)).not.toContain('private-api-key');
    }
  });
});

describe('encryptSecret', () => {
  it('fails without returning plaintext when secure storage is unavailable', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    expect(() => encryptSecret('plain-text-token')).toThrow(
      'Secure storage is unavailable; secret was not stored.',
    );
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });

  it('treats storage availability errors as unavailable', () => {
    safeStorageMock.isEncryptionAvailable.mockImplementation(() => {
      throw new Error('keychain unavailable');
    });

    expect(() => encryptSecret('plain-text-token')).toThrow(
      'Secure storage is unavailable; secret was not stored.',
    );
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });
});
