// Browser-side E2EE for the hosted dashboard — the mirror image of
// anvil-app's sealToRecipientPub / sealJsonEnvelope (src/main/services/
// sync-keyring.service.ts). The interop contract:
//
//   DSK wrap : X25519 ephemeral DH → HKDF-SHA256
//              (salt = ephPub‖browserPub, info = 'anvil/keyring-wrap/v1')
//              → AES-256-GCM under the grant AAD
//   snapshot : AES-256-GCM under the DSK, AAD authenticates the seq
//
// X25519 runs as a pure-TS Montgomery ladder (RFC 7748) because WebCrypto
// X25519 is not yet universal; HKDF and AES-GCM use WebCrypto. The keypair
// is ephemeral by design — private bytes live only in this tab's memory
// and the dashboard re-requests access on reload.

"use client";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---- base64 helpers -----------------------------------------------------------

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- X25519 (RFC 7748) --------------------------------------------------------

const P = (1n << 255n) - 19n;
const A24 = 121665n;

function feMod(x: bigint): bigint {
  const r = x % P;
  return r >= 0n ? r : r + P;
}

function feInv(x: bigint): bigint {
  // Fermat inversion: x^(p-2) mod p.
  let base = feMod(x);
  let exp = P - 2n;
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = feMod(result * base);
    base = feMod(base * base);
    exp >>= 1n;
  }
  return result;
}

function decodeUCoord(bytes: Uint8Array): bigint {
  const masked = new Uint8Array(bytes);
  masked[31] &= 0x7f; // X25519 ignores the high bit of the u-coordinate.
  let u = 0n;
  for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(masked[i]);
  return u;
}

function encodeUCoord(u: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let v = feMod(u);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

function clampScalar(bytes: Uint8Array): Uint8Array {
  const scalar = new Uint8Array(bytes);
  scalar[0] &= 248;
  scalar[31] &= 0x7f;
  scalar[31] |= 0x40;
  return scalar;
}

/** X25519 scalar multiplication — Montgomery ladder over GF(2^255-19). */
export function x25519(scalarBytes: Uint8Array, uBytes: Uint8Array): Uint8Array {
  const scalar = clampScalar(scalarBytes);
  const x1 = decodeUCoord(uBytes);
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;
  for (let t = 254; t >= 0; t--) {
    const bit = (BigInt(scalar[t >> 3]) >> BigInt(t & 7)) & 1n;
    swap ^= bit;
    if (swap === 1n) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = bit;
    const a = feMod(x2 + z2);
    const aa = feMod(a * a);
    const b = feMod(x2 - z2);
    const bb = feMod(b * b);
    const e = feMod(aa - bb);
    const c = feMod(x3 + z3);
    const d = feMod(x3 - z3);
    const da = feMod(d * a);
    const cb = feMod(c * b);
    const t1 = feMod(da + cb);
    const t2 = feMod(da - cb);
    x3 = feMod(t1 * t1);
    z3 = feMod(x1 * t2 * t2);
    x2 = feMod(aa * bb);
    z2 = feMod(e * (aa + A24 * e));
  }
  if (swap === 1n) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }
  return encodeUCoord(x2 * feInv(z2));
}

const X25519_BASE = new Uint8Array(32).fill(0);
X25519_BASE[0] = 9;

/** Ephemeral dashboard keypair — 32-byte private scalar + raw public key. */
export function generateBrowserKeypair(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  return { priv, pub: x25519(priv, X25519_BASE) };
}

// ---- WebCrypto wrappers -------------------------------------------------------

async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveKey"
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: encoder.encode(info) as BufferSource
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

async function aesGcmOpen(
  key: CryptoKey,
  nonce: Uint8Array,
  aad: string,
  ct: Uint8Array
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: nonce as BufferSource,
      additionalData: encoder.encode(aad) as BufferSource
    },
    key,
    ct as BufferSource
  );
  return new Uint8Array(plaintext);
}

// ---- Dashboard envelopes ------------------------------------------------------

export interface DashboardGrantEnvelope {
  v: 1;
  enc: "x25519-aes-256-gcm";
  requestId: string;
  browserPub: string;
  expiresAt: string;
  ephPub: string;
  nonce: string;
  ct: string;
}

export interface DashboardGrantInner {
  v: 1;
  dsk: string;
  scopes: string[];
  expiresAt: string;
}

export interface SealedSnapshot {
  enc: "aes-256-gcm";
  seq: number;
  nonce: string;
  ct: string;
}

/** Matches dashboardGrantAssociatedData in anvil-app/cloud/contract/sealed.ts. */
export function grantAssociatedData(input: {
  backendId: string;
  accountId: string;
  requestId: string;
  browserPub: string;
  expiresAt: string;
}): string {
  return [
    "anvil/dashboard-grant/v1",
    input.backendId,
    input.accountId,
    input.requestId,
    input.browserPub,
    input.expiresAt
  ].join("|");
}

/** Matches dashboardSnapshotAssociatedData in anvil-app/cloud/contract/sealed.ts. */
export function snapshotAssociatedData(input: {
  backendId: string;
  accountId: string;
  requestId: string;
  seq: number;
}): string {
  return [
    "anvil/dashboard/v1",
    input.backendId,
    input.accountId,
    input.requestId,
    String(input.seq)
  ].join("|");
}

/**
 * Opens a sealed DSK grant: ECDH(priv, ephPub) → HKDF-SHA256(salt =
 * ephPub‖browserPub, 'anvil/keyring-wrap/v1') → AES-256-GCM under the
 * grant AAD. Returns null on any authentication or shape failure — the
 * caller treats it as "grant unreadable" and re-requests.
 */
export async function unwrapDashboardGrant(
  priv: Uint8Array,
  browserPub: Uint8Array,
  grant: DashboardGrantEnvelope,
  aadParts: { backendId: string; accountId: string }
): Promise<DashboardGrantInner | null> {
  try {
    const ephPub = b64decode(grant.ephPub);
    if (ephPub.length !== 32 || b64encode(browserPub) !== grant.browserPub) return null;
    const shared = x25519(priv, ephPub);
    const salt = new Uint8Array(64);
    salt.set(ephPub, 0);
    salt.set(browserPub, 32);
    const wrapKey = await hkdfSha256(shared, salt, "anvil/keyring-wrap/v1");
    const aad = grantAssociatedData({
      backendId: aadParts.backendId,
      accountId: aadParts.accountId,
      requestId: grant.requestId,
      browserPub: grant.browserPub,
      expiresAt: grant.expiresAt
    });
    const plaintext = await aesGcmOpen(wrapKey, b64decode(grant.nonce), aad, b64decode(grant.ct));
    const inner = JSON.parse(decoder.decode(plaintext)) as DashboardGrantInner;
    if (inner.v !== 1 || typeof inner.dsk !== "string") return null;
    const dsk = b64decode(inner.dsk);
    return dsk.length === 32 ? inner : null;
  } catch {
    return null;
  }
}

/**
 * Opens a sealed snapshot under the DSK. The seq is authenticated by the
 * AAD, so a replayed or reordered snapshot fails to open rather than
 * silently reverting rendered state.
 */
export async function openDashboardSnapshot(
  dsk: Uint8Array,
  snapshot: SealedSnapshot,
  aadParts: { backendId: string; accountId: string; requestId: string }
): Promise<Record<string, unknown> | null> {
  try {
    const key = await crypto.subtle.importKey("raw", dsk as BufferSource, "AES-GCM", false, [
      "decrypt"
    ]);
    const aad = snapshotAssociatedData({ ...aadParts, seq: snapshot.seq });
    const plaintext = await aesGcmOpen(
      key,
      b64decode(snapshot.nonce),
      aad,
      b64decode(snapshot.ct)
    );
    const inner = JSON.parse(decoder.decode(plaintext)) as Record<string, unknown>;
    return typeof inner === "object" && inner !== null ? inner : null;
  } catch {
    return null;
  }
}

export function encodeBrowserPub(pub: Uint8Array): string {
  return b64encode(pub);
}

export function randomRequestId(): string {
  return crypto.randomUUID();
}

export function randomChallenge(): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(32)));
}

export function decodeDsk(inner: DashboardGrantInner): Uint8Array {
  return b64decode(inner.dsk);
}
