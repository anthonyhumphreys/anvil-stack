import { safeStorage } from 'electron';

/**
 * Thin wrapper around Electron's safeStorage for encrypting/decrypting secrets.
 * All PATs and API keys go through this service before being stored in SQLite.
 */
function storage(): typeof safeStorage | null {
  // Non-Electron contexts (tests, daemons) may mock `electron` without a
  // safeStorage export; treat that the same as isEncryptionAvailable() →
  // false and take the plain-buffer path below.
  try {
    return safeStorage ?? null;
  } catch {
    return null;
  }
}

export function encryptSecret(value: string): Buffer {
  const store = storage();
  if (store === null || !store.isEncryptionAvailable()) {
    console.warn('[Auth] Encryption not available — storing as plain buffer');
    return Buffer.from(value, 'utf-8');
  }
  return store.encryptString(value);
}

function looksLikePlainTextBuffer(buffer: Buffer): boolean {
  const decoded = buffer.toString('utf-8');
  if (!decoded) return false;
  if (decoded.includes('\u0000') || decoded.includes('\ufffd')) return false;

  let printable = 0;
  for (const char of decoded) {
    const code = char.charCodeAt(0);
    const isWhitespace = code === 9 || code === 10 || code === 13;
    const isPrintableAscii = code >= 32 && code <= 126;
    const isExtendedText = code >= 160;
    if (isWhitespace || isPrintableAscii || isExtendedText) printable += 1;
  }

  return printable / decoded.length > 0.9;
}

export function decryptSecret(encrypted: Buffer | null, label = 'secret'): string | undefined {
  if (!encrypted) return undefined;
  const store = storage();
  if (store === null || !store.isEncryptionAvailable()) {
    console.warn('[Auth] Encryption not available — reading as plain buffer');
    return encrypted.toString('utf-8');
  }

  try {
    return store.decryptString(encrypted);
  } catch (err) {
    if (looksLikePlainTextBuffer(encrypted)) {
      console.warn(`[Auth] ${label} was stored as plain text buffer — reading legacy value`);
      return encrypted.toString('utf-8');
    }

    console.warn(
      `[Auth] Failed to decrypt ${label}; treating it as unset: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
