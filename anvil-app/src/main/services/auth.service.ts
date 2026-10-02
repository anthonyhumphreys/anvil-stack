import { app, safeStorage } from 'electron';
import type {
  SecretReadState,
  SecretStorageProvider,
  SecretStorageStatus,
  SecretVaultSetup,
} from '../../shared/secret-storage.js';
import {
  SECRET_ENVELOPE_PREFIX,
  SecretVaultStore,
  type SecretEncryptionLease,
} from './secret-vault.service.js';

let vault: SecretVaultStore | null = null;
let vaultPath: string | undefined;

function vaultStore(): SecretVaultStore | null {
  // Some service tests intentionally supply only safeStorage in their Electron mock.
  try {
    if (typeof app?.getPath !== 'function') return null;
    const path = app.getPath('userData');
    if (path !== vaultPath) {
      vault?.lock();
      vault = new SecretVaultStore(path);
      vaultPath = path;
    }
    return vault;
  } catch {
    return null;
  }
}

function availableStorage(): typeof safeStorage | null {
  try {
    const store = safeStorage ?? null;
    if (store === null || !store.isEncryptionAvailable()) return null;
    // Electron's basic_text backend uses a hard-coded key, not OS custody.
    if (
      typeof store.getSelectedStorageBackend === 'function' &&
      store.getSelectedStorageBackend() === 'basic_text'
    )
      return null;
    return store;
  } catch {
    return null;
  }
}

function isLegacyFileStorage(): boolean {
  try {
    return (
      (
        safeStorage as { getSelectedStorageBackend?: () => string }
      )?.getSelectedStorageBackend?.() === 'anvil_daemon_legacy_file'
    );
  } catch {
    return false;
  }
}

export function getSecretStorageStatus(): SecretStorageStatus {
  const store = vaultStore();
  const legacyFileStorage = isLegacyFileStorage();
  const storageAvailable = availableStorage() !== null;
  const keychainAvailable = storageAvailable && !legacyFileStorage;
  const vaultStatus = store?.status() ?? { configured: false, state: 'unavailable' as const };
  try {
    const provider = store?.preferredProvider() ?? 'keychain';
    return {
      provider,
      keychainAvailable,
      keyFileSupported: process.platform !== 'win32',
      legacyFileStorage,
      vault: vaultStatus,
      state: provider === 'vault' ? vaultStatus.state : storageAvailable ? 'ready' : 'unavailable',
    };
  } catch {
    return {
      provider: 'keychain',
      keychainAvailable,
      keyFileSupported: process.platform !== 'win32',
      vault: vaultStatus,
      state: 'invalid',
    };
  }
}

export function isSecretStorageAvailable(): boolean {
  return getSecretStorageStatus().state === 'ready';
}

export async function configureSecretVault(input: SecretVaultSetup): Promise<SecretStorageStatus> {
  const store = vaultStore();
  if (store === null) throw new Error('Credential storage is unavailable in this process.');
  await store.setup(input);
  return getSecretStorageStatus();
}

export async function unlockSecretVault(passphrase?: string): Promise<SecretStorageStatus> {
  const store = vaultStore();
  if (store === null) throw new Error('Credential storage is unavailable in this process.');
  await store.unlock(passphrase);
  return getSecretStorageStatus();
}

export function lockSecretVault(): SecretStorageStatus {
  vaultStore()?.lock();
  return getSecretStorageStatus();
}

export function selectSecretStorageProvider(provider: SecretStorageProvider): SecretStorageStatus {
  if (provider !== 'keychain' && provider !== 'vault')
    throw new Error('Invalid credential storage provider.');
  if (provider === 'keychain' && availableStorage() === null)
    throw new Error('OS credential storage is unavailable.');
  const store = vaultStore();
  if (store === null) throw new Error('Credential storage is unavailable in this process.');
  store.select(provider);
  return getSecretStorageStatus();
}

export function encryptSecret(value: string): Buffer {
  const lease = createSecretEncryptionLease();
  try {
    return lease.encrypt(value);
  } finally {
    lease.dispose();
  }
}

export function createSecretEncryptionLease(): SecretEncryptionLease {
  const status = getSecretStorageStatus();
  if (status.state === 'invalid')
    throw new Error('Credential storage configuration is unreadable; secret was not stored.');
  if (status.provider === 'vault') return vaultStore()!.encryptionLease();
  const store = availableStorage();
  if (store === null)
    throw new Error(
      'Secure storage is unavailable; secret was not stored. Configure an encrypted vault in Settings > Privacy > Credential storage.',
    );
  const provider = isLegacyFileStorage() ? 'daemon-file' : 'keychain';
  let disposed = false;
  return {
    encrypt: (value) => {
      if (disposed) throw new Error('Credential encryption operation has finished.');
      try {
        return Buffer.concat([
          Buffer.from(`${SECRET_ENVELOPE_PREFIX}${provider}:`),
          store.encryptString(value),
        ]);
      } catch {
        throw new Error('Credential storage could not encrypt the value; secret was not stored.');
      }
    },
    dispose: () => {
      disposed = true;
    },
  };
}

function looksLikePlainTextBuffer(buffer: Buffer): boolean {
  // Known ciphertext formats must never be mistaken for legacy plaintext.
  if (/^v(?:1|10|11|20)/.test(buffer.subarray(0, 3).toString('utf8'))) return false;
  const decoded = buffer.toString('utf8');
  if (!decoded || decoded.includes('\u0000') || decoded.includes('\ufffd')) return false;
  let printable = 0;
  for (const char of decoded) {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126) || code >= 160)
      printable += 1;
  }
  return printable / decoded.length > 0.9;
}

export type SecretReadResult =
  | { state: 'available'; value: string; provider: 'keychain' | 'vault' | 'legacy' | 'daemon-file' }
  | { state: Exclude<SecretReadState, 'available'> };

/** Inspect without logging ciphertext, secret contents or underlying crypto errors. */
export function readStoredSecret(
  encrypted: Buffer | null,
  allowLegacyPlaintext = true,
): SecretReadResult {
  if (encrypted === null || encrypted.length === 0) return { state: 'not-configured' };
  const value = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
  if (
    value.subarray(0, 'anvil-secret:'.length).toString() === 'anvil-secret:' &&
    value.subarray(0, SECRET_ENVELOPE_PREFIX.length).toString() !== SECRET_ENVELOPE_PREFIX
  )
    return { state: 'invalid' };
  const tagged =
    value.subarray(0, SECRET_ENVELOPE_PREFIX.length).toString() === SECRET_ENVELOPE_PREFIX;
  const keychainPrefix = `${SECRET_ENVELOPE_PREFIX}keychain:`;
  const daemonPrefix = `${SECRET_ENVELOPE_PREFIX}daemon-file:`;
  const daemonTagged = tagged && value.subarray(0, daemonPrefix.length).toString() === daemonPrefix;
  const vaultPrefix = `${SECRET_ENVELOPE_PREFIX}vault:`;
  if (tagged && value.subarray(0, vaultPrefix.length).toString() === vaultPrefix) {
    const store = vaultStore();
    const state = store?.status().state ?? 'unavailable';
    if (state !== 'ready')
      return {
        state: state === 'locked' ? 'locked' : state === 'invalid' ? 'invalid' : 'unavailable',
      };
    try {
      return { state: 'available', value: store!.decrypt(value), provider: 'vault' };
    } catch {
      return { state: 'invalid' };
    }
  }
  if (daemonTagged && !isLegacyFileStorage()) return { state: 'unavailable' };
  if (
    tagged &&
    !daemonTagged &&
    value.subarray(0, keychainPrefix.length).toString() !== keychainPrefix
  )
    return { state: 'invalid' };
  const store = availableStorage();
  if (store !== null) {
    try {
      return {
        state: 'available',
        value: store.decryptString(
          tagged
            ? value.subarray(daemonTagged ? daemonPrefix.length : keychainPrefix.length)
            : value,
        ),
        provider: isLegacyFileStorage() ? 'daemon-file' : 'keychain',
      };
    } catch {
      /* Only untagged legacy plaintext is eligible for migration. */
    }
  }
  if (
    !tagged &&
    allowLegacyPlaintext &&
    isSecretStorageAvailable() &&
    looksLikePlainTextBuffer(value)
  )
    return { state: 'available', value: value.toString('utf8'), provider: 'legacy' };
  return { state: store === null ? 'unavailable' : 'invalid' };
}

export function decryptSecret(encrypted: Buffer | null, _label = 'secret'): string | undefined {
  const result = readStoredSecret(encrypted);
  return result.state === 'available' ? result.value : undefined;
}

/** Recovery/key custody never accepts the historical plaintext representation. */
export function decryptSecretStrict(encrypted: Buffer | null): string | undefined {
  const result = readStoredSecret(encrypted, false);
  return result.state === 'available' ? result.value : undefined;
}

export function resetSecretStorageForTests(): void {
  vault?.lock();
  vault = null;
  vaultPath = undefined;
}
