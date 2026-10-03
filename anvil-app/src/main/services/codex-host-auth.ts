import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_CREDENTIAL_GRANT_CODEX_AUTH_JSON_BYTES } from '../../../cloud/contract/sealed.js';

export interface CodexHostAuthIdentity {
  /** Stable identity used to reject a different account's worker cache. */
  identity: string;
  /** Optional organization/workspace identity used by account/read when available. */
  accountId?: string;
}

/** Validate a host Codex account cache without exposing tokens in errors. */
export function validateCodexHostAuthJson(value: string): void {
  parseCodexHostAuthJson(value);
}

export function codexHostAuthIdentity(value: string): CodexHostAuthIdentity {
  return parseCodexHostAuthJson(value);
}

/** Read the host's ChatGPT auth cache from CODEX_HOME or the standard home. */
export function readCodexHostAuthJson(): string {
  const authPath = path.join(resolveCodexHostAuthHome(), 'auth.json');
  let value: string;
  try {
    value = fs.readFileSync(authPath, 'utf8');
  } catch {
    throw new Error('codex-host-auth-missing');
  }
  validateCodexHostAuthJson(value);
  return value;
}

export function resolveCodexHostAuthHome(): string {
  const configuredHome = process.env.CODEX_HOME?.trim();
  return path.resolve(configuredHome || path.join(os.homedir(), '.codex'));
}

function parseCodexHostAuthJson(value: string): CodexHostAuthIdentity {
  if (Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_GRANT_CODEX_AUTH_JSON_BYTES) {
    throw new Error('codex-host-auth-too-large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('codex-host-auth-invalid');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('codex-host-auth-invalid');
  }
  const tokens = (parsed as Record<string, unknown>)['tokens'];
  if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) {
    throw new Error('codex-host-auth-invalid');
  }
  const cache = parsed as Record<string, unknown>;
  if (
    (cache['auth_mode'] !== undefined && cache['auth_mode'] !== 'chatgpt') ||
    (typeof cache['OPENAI_API_KEY'] === 'string' && cache['OPENAI_API_KEY'].length > 0)
  ) {
    throw new Error('codex-host-auth-invalid');
  }
  const tokenFields = tokens as Record<string, unknown>;
  if (
    typeof tokenFields['access_token'] !== 'string' ||
    tokenFields['access_token'].length === 0 ||
    typeof tokenFields['refresh_token'] !== 'string' ||
    tokenFields['refresh_token'].length === 0 ||
    (tokenFields['account_id'] !== undefined &&
      tokenFields['account_id'] !== null &&
      (typeof tokenFields['account_id'] !== 'string' || tokenFields['account_id'].length === 0)) ||
    typeof tokenFields['id_token'] !== 'string' ||
    tokenFields['id_token'].length === 0
  ) {
    throw new Error('codex-host-auth-invalid');
  }
  const tokenIdentity = parseIdTokenIdentity(tokenFields['id_token']);
  const accountId =
    (typeof tokenFields['account_id'] === 'string' ? tokenFields['account_id'] : undefined) ??
    tokenIdentity.chatgptAccountId;
  const userId = tokenIdentity.chatgptUserId ?? tokenIdentity.subject;
  if (accountId === undefined && userId === undefined) {
    throw new Error('codex-host-auth-invalid');
  }
  // Workspace identifiers alone can be shared by different users. Include
  // whichever user identity Codex exposes so one user's cache cannot resume
  // another user's thread under the same organization.
  const identity = JSON.stringify({ accountId: accountId ?? null, userId: userId ?? null });
  return { identity, ...(accountId === undefined ? {} : { accountId }) };
}

interface IdTokenIdentity {
  chatgptAccountId?: string;
  chatgptUserId?: string;
  subject?: string;
}

/** Mirrors Codex TokenData's JWT payload parsing; never returns or logs the token. */
function parseIdTokenIdentity(idToken: string): IdTokenIdentity {
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error('codex-host-auth-invalid');
  }
  const payloadPart = parts[1];
  if (payloadPart === undefined || !/^[A-Za-z0-9_-]+$/.test(payloadPart)) {
    throw new Error('codex-host-auth-invalid');
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('codex-host-auth-invalid');
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    throw new Error('codex-host-auth-invalid');
  }
  const record = claims as Record<string, unknown>;
  const auth = record['https://api.openai.com/auth'];
  const authClaims =
    typeof auth === 'object' && auth !== null && !Array.isArray(auth)
      ? (auth as Record<string, unknown>)
      : undefined;
  const stringClaim = (...values: unknown[]): string | undefined =>
    values.find((item): item is string => typeof item === 'string' && item.length > 0);
  return {
    chatgptAccountId: stringClaim(authClaims?.['chatgpt_account_id']),
    chatgptUserId: stringClaim(authClaims?.['chatgpt_user_id'], authClaims?.['user_id']),
    subject: stringClaim(record['sub']),
  };
}
