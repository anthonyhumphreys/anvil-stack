import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CredentialStorageStatus } from '../../../../shared/secret-storage';
import type { CredentialStorageController } from '../../../hooks/useCredentialStorage';
import { CredentialStorageSetup } from '../CredentialStorageSetup';

const unavailable: CredentialStorageStatus = {
  provider: 'keychain',
  state: 'unavailable',
  keychainAvailable: false,
  keyFileSupported: true,
  vault: { configured: false, state: 'unavailable' },
  credentials: {},
};

function render(status: CredentialStorageStatus | null, loading = false): string {
  const storage: CredentialStorageController = {
    status,
    loading,
    busy: false,
    error: null,
    isReady: status?.state === 'ready',
    refresh: vi.fn(),
    setupVault: vi.fn(),
    unlockVault: vi.fn(),
  };
  return renderToStaticMarkup(
    <CredentialStorageSetup storage={storage} actionLabel="sign in" onReady={vi.fn()} />,
  );
}

describe('inline credential storage setup', () => {
  it('offers local encrypted storage before sign-in when the OS keyring is unavailable', () => {
    const markup = render(unavailable);
    expect(markup).toContain('Create vault and sign in');
    expect(markup).toContain('Confirm passphrase');
    expect(markup).toContain('at least 12 characters');
    expect(markup).toContain('after each restart');
    expect(markup).not.toContain('Settings &gt;');
  });

  it('unlocks existing credentials without offering to replace the vault', () => {
    const markup = render({
      ...unavailable,
      provider: 'vault',
      state: 'locked',
      vault: { configured: true, mode: 'passphrase', state: 'locked' },
    });
    expect(markup).toContain('Unlock and sign in');
    expect(markup).not.toContain('Confirm passphrase');
    expect(markup).not.toContain('Create vault');
  });

  it('retains invalid storage and supports retry rather than destructive setup', () => {
    const markup = render({
      ...unavailable,
      state: 'invalid',
      vault: { configured: false, state: 'invalid' },
    });
    expect(markup).toContain('existing credentials have been kept');
    expect(markup).toContain('Retry storage check');
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain('Create vault');
  });

  it('tells a key-file user to restore the existing key instead of asking for a new passphrase', () => {
    const markup = render({
      ...unavailable,
      provider: 'vault',
      vault: {
        configured: true,
        mode: 'key-file',
        state: 'unavailable',
        keyFilePath: '/secure/vault.key',
      },
    });
    expect(markup).toContain('/secure/vault.key');
    expect(markup).toContain('Restore the existing vault key file');
    expect(markup).not.toContain('type="password"');
  });

  it('blocks unknown readiness and adds no step for working secure storage', () => {
    expect(render(null)).toContain('Retry storage check');
    expect(render(null, true)).toContain('Checking secure credential storage');
    expect(render({ ...unavailable, state: 'ready', keychainAvailable: true })).toBe('');
  });
});
