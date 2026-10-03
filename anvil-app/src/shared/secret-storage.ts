export type SecretStorageProvider = 'keychain' | 'vault';
export type SecretReadState = 'available' | 'not-configured' | 'locked' | 'unavailable' | 'invalid';

export type SecretVaultSetup =
  | { mode: 'passphrase'; passphrase: string }
  | { mode: 'key-file'; keyFilePath: string };

export interface SecretStorageStatus {
  provider: SecretStorageProvider;
  state: 'ready' | 'locked' | 'unavailable' | 'invalid';
  keychainAvailable: boolean;
  keyFileSupported: boolean;
  /** Backward compatibility for daemon installations using .daemon-key. */
  legacyFileStorage?: boolean;
  vault: {
    configured: boolean;
    mode?: SecretVaultSetup['mode'];
    state: 'ready' | 'locked' | 'unavailable' | 'invalid';
    keyFilePath?: string;
  };
}

export interface CredentialStorageStatus extends SecretStorageStatus {
  /** Saved values remain configured even when their storage cannot be opened. */
  credentials: Record<string, SecretReadState>;
}

export interface CredentialMigrationResult {
  migrated: number;
  retained: number;
}
