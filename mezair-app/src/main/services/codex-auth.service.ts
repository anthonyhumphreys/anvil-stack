import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface CodexAuthData {
  OPENAI_API_KEY: string | null;
  tokens?: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh?: string;
}

const AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');

/**
 * Check if Codex CLI auth tokens are available on disk.
 */
export function isCodexAuthAvailable(): boolean {
  try {
    if (!fs.existsSync(AUTH_PATH)) return false;
    const data = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8')) as CodexAuthData;
    return !!data.tokens?.access_token;
  } catch {
    return false;
  }
}

/**
 * Decode a JWT payload without verification (we only need the expiry claim).
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Check whether a JWT access token has expired (with 60s buffer).
 */
function isTokenExpired(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') {
    // Can't determine expiry — assume valid and let the API reject if not
    return false;
  }
  return Date.now() / 1000 > payload.exp - 60;
}

/**
 * Read the current Codex CLI access token.
 * Throws if no token is available or the token has expired.
 */
export function getCodexAccessToken(): string {
  if (!fs.existsSync(AUTH_PATH)) {
    throw new Error('Codex CLI auth not found. Run `codex` and sign in, then try again.');
  }

  let data: CodexAuthData;
  try {
    data = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
  } catch {
    throw new Error('Failed to read Codex CLI auth file. Try running `codex` to re-authenticate.');
  }

  const token = data.tokens?.access_token;
  if (!token) {
    throw new Error('No access token in Codex CLI auth. Run `codex` and sign in.');
  }

  if (isTokenExpired(token)) {
    throw new Error('Codex CLI access token has expired. Run `codex` to refresh your session.');
  }

  return token;
}
