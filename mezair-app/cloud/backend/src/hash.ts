/** SHA-256 hex over a UTF-8 string using the Workers Web Crypto API. */
export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** UTF-8 byte length (contract limits are bytes, not characters). */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
