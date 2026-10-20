import { describe, expect, it } from 'vitest';
import { parseVaultCommand } from '../vault-cli.js';

describe('vault CLI', () => {
  it('requires explicit storage and a protected input channel', () => {
    expect(parseVaultCommand(['setup', '--passphrase-stdin'])).toEqual({
      kind: 'setup',
      mode: 'passphrase',
    });
    expect(parseVaultCommand(['setup', '--key-file', '/private/vault.key'])).toEqual({
      kind: 'setup',
      mode: 'key-file',
      keyFilePath: '/private/vault.key',
    });
    expect(parseVaultCommand(['migrate'])).toEqual({ kind: 'migrate' });
    expect(parseVaultCommand(['use', 'vault'])).toEqual({ kind: 'use', provider: 'vault' });
    expect(() => parseVaultCommand(['setup', '--passphrase', 'secret'])).toThrow('must never');
    expect(() =>
      parseVaultCommand(['setup', '--passphrase-stdin', '--key-file', '/key']),
    ).toThrow();
    expect(() => parseVaultCommand(['status', 'extra'])).toThrow();
  });
});
