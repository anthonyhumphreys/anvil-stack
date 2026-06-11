import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
}));

vi.mock('electron', () => ({
  safeStorage: safeStorageMock,
}));

import { decryptSecret } from '../auth.service.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('decryptSecret', () => {
  it('returns decrypted secrets when safeStorage succeeds', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.decryptString.mockReturnValue('token-123');

    const result = decryptSecret(Buffer.from('ciphertext'), 'settings.openaiApiKey');

    expect(result).toBe('token-123');
    expect(safeStorageMock.decryptString).toHaveBeenCalled();
  });

  it('falls back to plain utf-8 values when legacy unencrypted buffers are encountered', () => {
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
