import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  SecretStorageProvider,
  SecretStorageStatus,
  SecretVaultSetup,
} from '../../shared/secret-storage.js';

interface VaultConfiguration {
  id: string;
  mode: SecretVaultSetup['mode'];
  salt?: string;
  keyFilePath?: string;
  verifier: string;
}
interface StorageConfiguration {
  version: 1;
  provider: SecretStorageProvider;
  vault?: VaultConfiguration;
}
export interface SecretEncryptionLease {
  encrypt(value: string): Buffer;
  dispose(): void;
}

const VERIFIER = 'anvil-vault-key-check-v1';
export const SECRET_ENVELOPE_PREFIX = 'anvil-secret:v1:';
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function acquireSetupLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'secret-storage.setup-lock');
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw new Error('Could not reserve vault setup.');
    // A crashed setup cannot hold the reservation forever. Never remove an
    // unreadable lock or one whose owning process is still alive.
    let stale = false;
    try {
      const pid = Number(readFileSync(path, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (failure) {
          stale = (failure as NodeJS.ErrnoException).code === 'ESRCH';
        }
      }
    } catch {
      /* Another process may be writing its reservation. */
    }
    if (!stale)
      throw new Error('Another process is configuring the vault. Try again after it finishes.');
    unlinkSync(path);
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch {
      throw new Error('Another process is configuring the vault.');
    }
  }
  try {
    writeFileSync(fd, String(process.pid));
  } catch {
    closeSync(fd);
    unlinkSync(path);
    throw new Error('Could not reserve vault setup.');
  }
  return () => {
    closeSync(fd);
    unlinkSync(path);
  };
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  if (typeof passphrase !== 'string' || Buffer.byteLength(passphrase) > 4096)
    throw new Error('Invalid vault passphrase.');
  return new Promise((resolveKey, reject) => {
    scrypt(passphrase, salt, 32, SCRYPT_OPTIONS, (error, key) =>
      error === null ? resolveKey(key) : reject(new Error('Could not derive the vault key.')),
    );
  });
}

function seal(value: string, key: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function unseal(value: Buffer, key: Buffer, aad: string): string {
  if (value.length < 28) throw new Error('Invalid vault value.');
  const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
}

/** Regular, owner-only files. Do not follow symlinks or create keys during a read. */
export function readProtectedVaultKey(path: string): Buffer {
  if (process.platform === 'win32')
    throw new Error(
      'Key-file vaults require POSIX file permissions. Use a passphrase vault or the OS keychain on Windows.',
    );
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(fd);
    if (
      !metadata.isFile() ||
      metadata.size !== 32 ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.uid !== process.getuid?.()
    )
      throw new Error('Invalid key file.');
    return readFileSync(fd);
  } catch {
    throw new Error('Vault key file must be an owner-only regular file containing a 32-byte key.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Device-local metadata. Only the salt, verifier and key path are persisted here. */
export class SecretVaultStore {
  private key: Buffer | null = null;
  private keyId: string | null = null;
  private manuallyLocked = false;
  private operationPending = false;
  readonly configPath: string;

  constructor(readonly dataDir: string) {
    this.configPath = join(dataDir, 'secret-storage.json');
  }

  private configuration(): StorageConfiguration {
    try {
      statSync(this.configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, provider: 'keychain' };
      throw new Error(
        'Credential storage configuration is unavailable. Existing credentials were retained.',
      );
    }
    try {
      if (statSync(this.configPath).size > 16_384) throw new Error();
      const config = JSON.parse(readFileSync(this.configPath, 'utf8')) as StorageConfiguration;
      if (config.version !== 1 || !['keychain', 'vault'].includes(config.provider))
        throw new Error();
      const vault = config.vault;
      if (
        vault !== undefined &&
        (!/^[a-f0-9-]{36}$/.test(vault.id) ||
          !['passphrase', 'key-file'].includes(vault.mode) ||
          typeof vault.verifier !== 'string' ||
          Buffer.from(vault.verifier, 'base64').length < 28 ||
          (vault.mode === 'passphrase' &&
            (typeof vault.salt !== 'string' || Buffer.from(vault.salt, 'base64').length !== 16)) ||
          (vault.mode === 'key-file' &&
            (typeof vault.keyFilePath !== 'string' || !isAbsolute(vault.keyFilePath))))
      )
        throw new Error();
      if (config.provider === 'vault' && vault === undefined) throw new Error();
      return config;
    } catch {
      throw new Error(
        'Credential storage configuration is unreadable. Existing credentials were retained.',
      );
    }
  }

  private save(config: StorageConfiguration): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(config));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.configPath);
      syncDirectory(this.dataDir);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  preferredProvider(): SecretStorageProvider {
    return this.configuration().provider;
  }

  status(): SecretStorageStatus['vault'] {
    try {
      const vault = this.configuration().vault;
      if (vault === undefined) return { configured: false, state: 'unavailable' };
      let state: SecretStorageStatus['vault']['state'] = 'locked';
      if (this.keyId === vault.id && this.key !== null) state = 'ready';
      else if (vault.mode === 'key-file' && !this.manuallyLocked) {
        try {
          this.loadFileKey(vault);
          state = 'ready';
        } catch {
          state = 'unavailable';
        }
      }
      return { configured: true, mode: vault.mode, state, keyFilePath: vault.keyFilePath };
    } catch {
      return { configured: false, state: 'invalid' };
    }
  }

  private loadFileKey(vault: VaultConfiguration): void {
    const key = readProtectedVaultKey(vault.keyFilePath!);
    try {
      if (unseal(Buffer.from(vault.verifier, 'base64'), key, vault.id) !== VERIFIER)
        throw new Error();
      this.replaceKey(key, vault.id);
    } catch {
      key.fill(0);
      throw new Error('The vault key file could not unlock existing credentials.');
    }
  }

  private replaceKey(key: Buffer, id: string): void {
    this.key?.fill(0);
    this.key = key;
    this.keyId = id;
    this.manuallyLocked = false;
  }

  async setup(input: SecretVaultSetup): Promise<void> {
    if (this.operationPending) throw new Error('A vault operation is already in progress.');
    this.operationPending = true;
    let key: Buffer | undefined;
    let releaseSetup: (() => void) | undefined;
    try {
      releaseSetup = acquireSetupLock(this.dataDir);
      const current = this.configuration();
      if (current.vault !== undefined)
        throw new Error('A vault already exists. Unlock it to use saved credentials.');
      const id = randomUUID();
      let vault: VaultConfiguration;
      if (input.mode === 'passphrase') {
        if (typeof input.passphrase !== 'string' || input.passphrase.length < 12)
          throw new Error('Use a vault passphrase of at least 12 characters.');
        const salt = randomBytes(16);
        key = await deriveKey(input.passphrase, salt);
        vault = {
          id,
          mode: input.mode,
          salt: salt.toString('base64'),
          verifier: seal(VERIFIER, key, id).toString('base64'),
        };
      } else if (input.mode === 'key-file') {
        if (process.platform === 'win32')
          throw new Error(
            'Key-file vaults require POSIX file permissions. Use a passphrase vault or the OS keychain on Windows.',
          );
        if (typeof input.keyFilePath !== 'string' || !isAbsolute(input.keyFilePath))
          throw new Error('Choose an absolute key file path outside the Anvil data directory.');
        mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
        const parent = realpathSync(dirname(input.keyFilePath));
        const keyPath = join(parent, basename(input.keyFilePath));
        const dataPath = realpathSync(this.dataDir);
        const inside = relative(dataPath, keyPath);
        if (
          inside === '' ||
          (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))
        )
          throw new Error('Keep the vault key outside the Anvil data directory and its backups.');
        const parentMetadata = statSync(parent);
        if ((parentMetadata.mode & 0o022) !== 0 || parentMetadata.uid !== process.getuid?.())
          throw new Error('Choose a key directory owned by you that other users cannot modify.');
        if (existsSync(keyPath)) key = readProtectedVaultKey(keyPath);
        else {
          key = randomBytes(32);
          const fd = openSync(
            keyPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
            0o600,
          );
          try {
            writeFileSync(fd, key);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          syncDirectory(parent);
        }
        vault = {
          id,
          mode: input.mode,
          keyFilePath: resolve(keyPath),
          verifier: seal(VERIFIER, key, id).toString('base64'),
        };
      } else throw new Error('Choose passphrase or key-file storage.');
      // Recheck after async derivation. Another process must not replace a vault.
      if (this.configuration().vault !== undefined)
        throw new Error('A vault was configured by another process. Unlock that vault.');
      this.save({ version: 1, provider: 'vault', vault });
      this.replaceKey(key, id);
      key = undefined;
    } finally {
      key?.fill(0);
      this.operationPending = false;
      releaseSetup?.();
    }
  }

  async unlock(passphrase?: string): Promise<void> {
    if (this.operationPending) throw new Error('A vault operation is already in progress.');
    this.operationPending = true;
    let key: Buffer | undefined;
    try {
      const vault = this.configuration().vault;
      if (vault === undefined) throw new Error('No encrypted vault is configured.');
      if (vault.mode === 'key-file') {
        this.loadFileKey(vault);
        return;
      }
      if (typeof passphrase !== 'string') throw new Error('Enter your vault passphrase.');
      key = await deriveKey(passphrase, Buffer.from(vault.salt!, 'base64'));
      try {
        if (unseal(Buffer.from(vault.verifier, 'base64'), key, vault.id) !== VERIFIER)
          throw new Error();
      } catch {
        throw new Error(
          'Could not unlock the vault. Check your passphrase; existing credentials were retained.',
        );
      }
      this.replaceKey(key, vault.id);
      key = undefined;
    } finally {
      key?.fill(0);
      this.operationPending = false;
    }
  }

  lock(): void {
    this.key?.fill(0);
    this.key = null;
    this.keyId = null;
    this.manuallyLocked = true;
  }

  select(provider: SecretStorageProvider): void {
    if (this.operationPending) throw new Error('A vault operation is already in progress.');
    const config = this.configuration();
    if (provider !== 'keychain' && provider !== 'vault')
      throw new Error('Invalid credential storage provider.');
    if (provider === 'vault' && config.vault === undefined)
      throw new Error('Configure an encrypted vault first.');
    this.save({ ...config, provider });
  }

  encrypt(value: string): Buffer {
    const lease = this.encryptionLease();
    try {
      return lease.encrypt(value);
    } finally {
      lease.dispose();
    }
  }

  /** An already authorized refresh can persist rotated tokens after a UI lock. */
  encryptionLease(): SecretEncryptionLease {
    const vault = this.configuration().vault;
    if (vault === undefined || this.status().state !== 'ready' || this.key === null)
      throw new Error(
        'Encrypted vault is locked or unavailable. Unlock it in Settings > Privacy > Credential storage.',
      );
    const prefix = `${SECRET_ENVELOPE_PREFIX}vault:${vault.id}:`;
    const key = Buffer.from(this.key);
    let disposed = false;
    return {
      encrypt: (value) => {
        if (disposed) throw new Error('Credential encryption operation has finished.');
        return Buffer.concat([Buffer.from(prefix), seal(value, key, prefix)]);
      },
      dispose: () => {
        key.fill(0);
        disposed = true;
      },
    };
  }

  decrypt(value: Buffer): string {
    const vault = this.configuration().vault;
    if (vault === undefined) throw new Error('Vault configuration is unavailable.');
    const prefix = `${SECRET_ENVELOPE_PREFIX}vault:${vault.id}:`;
    if (!value.subarray(0, prefix.length).equals(Buffer.from(prefix)))
      throw new Error('Credential belongs to a different vault.');
    if (this.status().state !== 'ready' || this.key === null)
      throw new Error('Vault is locked or unavailable.');
    return unseal(value.subarray(prefix.length), this.key, prefix);
  }
}
