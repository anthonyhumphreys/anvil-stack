import { deploymentVariable } from "@/lib/deployment-env.js";

// Hosted service-channel signing — byte-compatible with the backend
// verifier in anvil-app/cloud/backend/src/hosted/service-auth.ts.
//
// The signed payload is a UTF-8 string of newline-joined lines:
//   anvil-hosted/1
//   anvil-hosted            (audience)
//   <keyId>
//   <METHOD>                (uppercase)
//   <pathname + search>     (path and query only, never origin)
//   <timestamp>             (String(Date.now()))
//   <requestId>             (crypto.randomUUID())
//   <sha256 hex of body>
// HMAC-SHA256 over that payload with the raw UTF-8 secret, hex-encoded.
//
// This module stays free of `server-only` so the plain-node check script
// (scripts/verify-hosted-signing.mjs) can import it directly. It is only
// re-exported through lib/hosted/client.ts, which is server-only.

const encoder = new TextEncoder();

export const HOSTED_SERVICE_AUDIENCE = "anvil-hosted";
export const HOSTED_PROTOCOL_TAG = "anvil-hosted/1";

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Newline-joined payload the HMAC covers — order and casing are contractual. */
export function buildHostedSigningPayload(input: {
  keyId: string;
  method: string;
  pathWithQuery: string;
  timestamp: string;
  requestId: string;
  bodySha256Hex: string;
}): string {
  return [
    HOSTED_PROTOCOL_TAG,
    HOSTED_SERVICE_AUDIENCE,
    input.keyId,
    input.method.toUpperCase(),
    input.pathWithQuery,
    input.timestamp,
    input.requestId,
    input.bodySha256Hex
  ].join("\n");
}

export interface HostedSignedHeaders {
  "x-anvil-key-id": string;
  "x-anvil-timestamp": string;
  "x-anvil-request-id": string;
  "x-anvil-signature": string;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  if (encoder.encode(secret).byteLength < 32) {
    throw new Error("ANVIL_HOSTED_SERVICE_SECRET must contain at least 32 bytes");
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

/**
 * Normalizes a request path (which may already carry a query string) to the
 * `pathname + search` form the backend derives from the request URL.
 */
export function normalizePathWithQuery(path: string): string {
  const url = new URL(path, "https://hosted.invalid");
  return url.pathname + url.search;
}

/**
 * Low-level signer with explicit inputs so the verification script can
 * reproduce an exact vector. Mirrors `signHostedServiceRequest` in the
 * backend: same validation, same payload, same header names.
 */
export async function signHostedRequest(input: {
  keyId: string;
  secret: string;
  method: string;
  pathWithQuery: string;
  body: Uint8Array;
  now: number;
  requestId: string;
}): Promise<HostedSignedHeaders> {
  if (!KEY_ID_PATTERN.test(input.keyId)) {
    throw new Error("Invalid hosted key id");
  }
  if (!REQUEST_ID_PATTERN.test(input.requestId)) {
    throw new Error("Invalid hosted request id");
  }
  if (!Number.isSafeInteger(input.now)) {
    throw new Error("Invalid hosted signature timestamp");
  }
  const timestamp = String(input.now);
  const bodySha256Hex = hex(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(input.body).buffer as ArrayBuffer)
  );
  const payload = encoder.encode(
    buildHostedSigningPayload({
      keyId: input.keyId,
      method: input.method,
      pathWithQuery: input.pathWithQuery,
      timestamp,
      requestId: input.requestId,
      bodySha256Hex
    })
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importSigningKey(input.secret),
    Uint8Array.from(payload).buffer as ArrayBuffer
  );
  return {
    "x-anvil-key-id": input.keyId,
    "x-anvil-timestamp": timestamp,
    "x-anvil-request-id": input.requestId,
    "x-anvil-signature": hex(signature)
  };
}

/**
 * Signs one request against the env-configured service key
 * (`ANVIL_HOSTED_KEY_ID` + `ANVIL_HOSTED_SERVICE_SECRET`) with a fresh
 * timestamp and request id. `path` may include a query string; only the
 * `pathname + search` portion is signed, matching the backend.
 */
export async function signRequest(
  path: string,
  method: string,
  body: Uint8Array
): Promise<HostedSignedHeaders> {
  return signHostedRequest({
    keyId: deploymentVariable("HOSTED_KEY_ID", "ANVIL_HOSTED_KEY_ID") ?? "",
    secret: deploymentVariable("HOSTED_SERVICE_SECRET", "ANVIL_HOSTED_SERVICE_SECRET") ?? "",
    method,
    pathWithQuery: normalizePathWithQuery(path),
    body,
    now: Date.now(),
    requestId: crypto.randomUUID()
  });
}
