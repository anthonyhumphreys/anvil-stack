import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
}));

vi.mock('electron', () => ({
  safeStorage: safeStorageMock,
}));

import { decryptSecret, encryptSecret } from '../auth.service.js';

beforeEach(() => {
  vi.clearAllMocks();
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
