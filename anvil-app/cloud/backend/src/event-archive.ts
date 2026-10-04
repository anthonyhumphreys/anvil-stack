import { decodeCanonicalBase64, encodeBase64 } from './compact-sync';

export interface SealedEventArchive {
  nonceBase64: string;
  plaintextSha256: string;
  ciphertextSha256: string;
  ciphertext: Uint8Array;
}

export async function sealEventArchive(
  keyBase64: string,
  plaintext: string,
  additionalData: string,
  nonceBase64?: string,
): Promise<SealedEventArchive> {
  const nonce =
    nonceBase64 === undefined
      ? crypto.getRandomValues(new Uint8Array(12))
      : decodeCanonicalBase64(nonceBase64);
  if (nonce.byteLength !== 12) throw new Error('invalid event archive nonce');
  const keyBytes = decodeCanonicalBase64(keyBase64);
  if (keyBytes.byteLength !== 32) throw new Error('invalid event archive key');
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const cleartext = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: new TextEncoder().encode(additionalData),
      },
      key,
      cleartext,
    ),
  );
  return {
    nonceBase64: encodeBase64(nonce),
    plaintextSha256: await sha256HexBytes(cleartext),
    ciphertextSha256: await sha256HexBytes(ciphertext),
    ciphertext,
  };
}

export async function openEventArchive(
  keyBase64: string,
  ciphertext: Uint8Array,
  nonceBase64: string,
  additionalData: string,
  expectedCiphertextSha256: string,
  expectedPlaintextSha256: string,
): Promise<string> {
  if ((await sha256HexBytes(ciphertext)) !== expectedCiphertextSha256) {
    throw new Error('event archive ciphertext digest mismatch');
  }
  const keyBytes = decodeCanonicalBase64(keyBase64);
  const nonce = decodeCanonicalBase64(nonceBase64);
  if (keyBytes.byteLength !== 32 || nonce.byteLength !== 12) {
    throw new Error('invalid event archive key material');
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const cleartext = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: new TextEncoder().encode(additionalData),
      },
      key,
      ciphertext,
    ),
  );
  if ((await sha256HexBytes(cleartext)) !== expectedPlaintextSha256) {
    throw new Error('event archive plaintext digest mismatch');
  }
  return new TextDecoder().decode(cleartext);
}

async function sha256HexBytes(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
  let result = '';
  for (const byte of digest) result += byte.toString(16).padStart(2, '0');
  return result;
}
