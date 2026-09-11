import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decryptSecret, encryptSecret } from './auth.service.js';
import {
  base64UrlEncode,
  buildLoopbackRedirectUri,
  createPkceS256Pair,
  isAllowedOidcRedirectUri,
  OIDC_CODE_CHALLENGE_METHOD,
  OIDC_DEFAULT_SCOPES,
  OIDC_MAX_PORT,
  OIDC_MIN_PORT,
  OIDC_PLACEHOLDER_CLIENT_ID,
  OIDC_PLACEHOLDER_ISSUER,
  type AuthErrorCode,
  type DeviceSession,
  type EnrollParams,
  type EnrollResult,
  type SessionRefreshParams,
  type SessionRefreshResult,
  type SessionRevokeParams,
  type SessionRevokeResult,
} from '../../../cloud/contract/auth.js';

export type SyncAuthState = 'signed-out' | 'enrolling' | 'signed-in';

/**
 * Public auth snapshot for IPC/renderer. Tokens MUST NOT appear here; only
 * account identity and expiry cross the boundary.
 */
export interface SyncAuthSnapshot {
  state: SyncAuthState;
  accountId: string | null;
  enrollmentId: string | null;
  expiresAt: string | null;
}

/** Injected HTTP boundary (owned by BYOB-01): exchanges a proof for a session. */
export type EnrollFn = (params: EnrollParams) => Promise<EnrollResult>;

/** Injected HTTP boundary: rotates the device session credentials. */
export type RefreshFn = (params: SessionRefreshParams) => Promise<SessionRefreshResult>;

/** Injected HTTP boundary: idempotently revokes the device session. */
export type RevokeFn = (params: SessionRevokeParams) => Promise<SessionRevokeResult>;

/** Opens the system browser. Injected so unit tests never touch Electron. */
export type OpenExternalFn = (url: string) => Promise<void>;

/**
 * Starts an ephemeral 127.0.0.1 callback listener. Injected so unit tests
 * can stub the redirect URI instead of binding real ports.
 */
export type ListenLoopbackFn = () => Promise<{ redirectUri: string; close: () => void }>;

export interface SyncAuthServiceDeps {
  userDataDir: string;
  installationId?: string;
  openExternal?: OpenExternalFn;
  listenLoopback?: ListenLoopbackFn;
}

export interface CreatePkceLoginOptions {
  issuer?: string;
  clientId?: string;
  scopes?: readonly string[];
  launchBrowser?: boolean;
}

export interface CreatePkceLoginResult {
  authorizationUrl: string;
  redirectUri: string;
  state: string;
}

export interface CompletePkceLoginInput {
  state: string;
  authorizationCode: string;
}

const SESSION_FILE_NAME = 'sync-mesh-session.json';
const SESSION_FILE_VERSION = 1;

interface PersistedSyncSession {
  version: number;
  accountId: string;
  enrollmentId: string;
  datasetEpoch: string;
  credentialGeneration: number;
  accessExpiresAt: string;
  displayName?: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
}

interface PendingPkceLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  issuer: string;
  clientId: string;
  closeListener: () => void;
}

function errorCodeOf(error: unknown): AuthErrorCode | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code = (error as { code: unknown }).code;
  switch (code) {
    case 'refresh-reuse-detected':
    case 'enrollment-code-used':
    case 'invalid-proof':
      return code;
    default:
      return null;
  }
}

/** Human-readable label for auth failures. Never includes tokens or proofs. */
export function describeAuthError(code: AuthErrorCode): string {
  switch (code) {
    case 'refresh-reuse-detected':
      return 'The refresh credential was already rotated. The local session was signed out.';
    case 'enrollment-code-used':
      return 'The enrollment code was already used or has expired.';
    case 'invalid-proof':
      return 'The sign-in proof was rejected. Please try again.';
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

/**
 * Default system-browser opener. The Electron import is lazy (and injected
 * in tests via deps) so importing this module never requires Electron at
 * module top, which keeps unit tests runnable outside the app runtime.
 */
async function openExternalDefault(url: string): Promise<void> {
  const { shell } = await import('electron');
  await shell.openExternal(url);
}

function pickEphemeralPort(): number {
  return randomInt(OIDC_MIN_PORT, OIDC_MAX_PORT + 1);
}

/**
 * Default 127.0.0.1 listener: binds a random port in 49152-65535, answers
 * exactly one frozen `/callback` shape, and ignores everything else. The
 * authorization code is delivered to completePkceLogin explicitly, so the
 * listener only proves the redirect URI is live.
 */
async function listenLoopbackDefault(): Promise<{ redirectUri: string; close: () => void }> {
  const attempts = 10;
  let server: Server | null = null;
  let redirectUri: string | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = buildLoopbackRedirectUri(pickEphemeralPort());
    const candidateUrl = new URL(candidate);
    const candidateServer = createServer((req, res) => {
      if (typeof req.url === 'string' && req.url.startsWith('/callback')) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Sign-in complete. You can return to Anvil.');
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found.');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        candidateServer.once('error', reject);
        candidateServer.listen(Number(candidateUrl.port), '127.0.0.1', () => {
          candidateServer.removeAllListeners('error');
          resolve();
        });
      });
      server = candidateServer;
      redirectUri = candidate;
      break;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => {
        candidateServer.close(() => {
          resolve();
        });
      });
    }
  }
  if (server === null || redirectUri === null) {
    throw new Error(
      `Failed to bind an ephemeral 127.0.0.1 loopback port: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
  const active: Server = server;
  return {
    redirectUri,
    close: () => {
      active.close();
    },
  };
}

function buildAuthorizationUrl(input: {
  issuer: string;
  clientId: string;
  scopes: readonly string[];
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
}): string {
  const base = input.issuer.replace(/\/+$/, '');
  const params: Array<[string, string]> = [
    ['response_type', 'code'],
    ['client_id', input.clientId],
    ['redirect_uri', input.redirectUri],
    ['scope', input.scopes.join(' ')],
    ['state', input.state],
    ['nonce', input.nonce],
    ['code_challenge', input.challenge],
    ['code_challenge_method', OIDC_CODE_CHALLENGE_METHOD],
  ];
  const query = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${base}/authorize?${query}`;
}

function toEncryptedPayload(encrypted: Buffer): string {
  return encrypted.toString('base64');
}

function fromEncryptedPayload(payload: string): Buffer {
  return Buffer.from(payload, 'base64');
}

export class SyncAuthService {
  private readonly userDataDir: string;
  private readonly installationId: string;
  private readonly openExternal: OpenExternalFn;
  private readonly listenLoopback: ListenLoopbackFn;
  private pending: PendingPkceLogin | null = null;
  private cached: PersistedSyncSession | null = null;
  private cacheLoaded = false;

  constructor(deps: SyncAuthServiceDeps) {
    this.userDataDir = deps.userDataDir;
    this.installationId = deps.installationId ?? randomUUID();
    this.openExternal = deps.openExternal ?? openExternalDefault;
    this.listenLoopback = deps.listenLoopback ?? listenLoopbackDefault;
  }

  private sessionFilePath(): string {
    return join(this.userDataDir, SESSION_FILE_NAME);
  }

  private ensureCacheLoaded(): void {
    if (this.cacheLoaded) {
      return;
    }
    this.cacheLoaded = true;
    try {
      if (!existsSync(this.sessionFilePath())) {
        this.cached = null;
        return;
      }
      const raw = readFileSync(this.sessionFilePath(), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedSyncSession>;
      if (
        parsed.version !== SESSION_FILE_VERSION ||
        typeof parsed.accountId !== 'string' ||
        typeof parsed.enrollmentId !== 'string' ||
        typeof parsed.datasetEpoch !== 'string' ||
        typeof parsed.credentialGeneration !== 'number' ||
        typeof parsed.accessExpiresAt !== 'string' ||
        typeof parsed.accessTokenEncrypted !== 'string' ||
        typeof parsed.refreshTokenEncrypted !== 'string'
      ) {
        this.cached = null;
        return;
      }
      this.cached = parsed as PersistedSyncSession;
    } catch {
      this.cached = null;
    }
  }

  private persistSession(session: DeviceSession): void {
    mkdirSync(this.userDataDir, { recursive: true });
    const persisted: PersistedSyncSession = {
      version: SESSION_FILE_VERSION,
      accountId: session.accountId,
      enrollmentId: session.enrollmentId,
      datasetEpoch: session.datasetEpoch,
      credentialGeneration: session.credentialGeneration,
      accessExpiresAt: session.accessExpiresAt,
      accessTokenEncrypted: toEncryptedPayload(encryptSecret(session.accessToken)),
      refreshTokenEncrypted: toEncryptedPayload(encryptSecret(session.refreshToken)),
    };
    if (session.displayName !== undefined) {
      persisted.displayName = session.displayName;
    }
    writeFileSync(this.sessionFilePath(), JSON.stringify(persisted, null, 2), 'utf-8');
    this.cached = persisted;
    this.cacheLoaded = true;
  }

  private readRefreshToken(): string | null {
    this.ensureCacheLoaded();
    if (this.cached === null) {
      return null;
    }
    const decrypted = decryptSecret(fromEncryptedPayload(this.cached.refreshTokenEncrypted), 'sync-mesh refresh');
    return decrypted ?? null;
  }

  private wipeSession(): void {
    this.cached = null;
    this.cacheLoaded = true;
    try {
      if (existsSync(this.sessionFilePath())) {
        unlinkSync(this.sessionFilePath());
      }
    } catch {
      // Best effort: the in-memory session is already cleared.
    }
  }

  async createPkceLogin(options?: CreatePkceLoginOptions): Promise<CreatePkceLoginResult> {
    if (this.pending !== null) {
      this.pending.closeListener();
      this.pending = null;
    }
    const issuer = options?.issuer ?? OIDC_PLACEHOLDER_ISSUER;
    const clientId = options?.clientId ?? OIDC_PLACEHOLDER_CLIENT_ID;
    const scopes = options?.scopes ?? OIDC_DEFAULT_SCOPES;
    const pair = createPkceS256Pair(randomBytes(32), (data) =>
      createHash('sha256').update(data).digest(),
    );
    const state = base64UrlEncode(randomBytes(32));
    const nonce = base64UrlEncode(randomBytes(32));
    const { redirectUri, close } = await this.listenLoopback();
    if (!isAllowedOidcRedirectUri(redirectUri)) {
      close();
      throw new Error('Loopback listener returned a redirect URI outside the frozen form.');
    }
    this.pending = {
      state,
      nonce,
      codeVerifier: pair.verifier,
      redirectUri,
      issuer,
      clientId,
      closeListener: close,
    };
    const authorizationUrl = buildAuthorizationUrl({
      issuer,
      clientId,
      scopes,
      redirectUri,
      state,
      nonce,
      challenge: pair.challenge,
    });
    if (options?.launchBrowser === true) {
      await this.openExternal(authorizationUrl);
    }
    return { authorizationUrl, redirectUri, state };
  }

  async completePkceLogin(
    input: CompletePkceLoginInput,
    enrollFn: EnrollFn,
  ): Promise<SyncAuthSnapshot> {
    const pending = this.pending;
    if (pending === null || input.state !== pending.state) {
      throw new Error('PKCE state mismatch. No session was written.');
    }
    if (input.authorizationCode.length === 0) {
      throw new Error('Missing authorization code. No session was written.');
    }
    const session = await enrollFn({
      proof: {
        method: 'oidc-pkce',
        issuer: pending.issuer,
        authorizationCode: input.authorizationCode,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        nonce: pending.nonce,
      },
      installationId: this.installationId,
    });
    pending.closeListener();
    this.pending = null;
    this.persistSession(session);
    return this.getPublicSnapshot();
  }

  async enrollWithCode(code: string, enrollFn: EnrollFn): Promise<SyncAuthSnapshot> {
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      throw new Error('Missing enrollment code. No session was written.');
    }
    const session = await enrollFn({
      proof: { method: 'enrollment-code', code: trimmed },
      installationId: this.installationId,
    });
    this.persistSession(session);
    return this.getPublicSnapshot();
  }

  async refreshSession(refreshFn: RefreshFn): Promise<SyncAuthSnapshot> {
    this.ensureCacheLoaded();
    const cached = this.cached;
    if (cached === null) {
      return this.getPublicSnapshot();
    }
    const refreshToken = this.readRefreshToken();
    if (refreshToken === null) {
      this.wipeSession();
      return this.getPublicSnapshot();
    }
    try {
      const rotated = await refreshFn({ refreshToken, enrollmentId: cached.enrollmentId });
      this.persistSession(rotated);
      return this.getPublicSnapshot();
    } catch (error) {
      if (errorCodeOf(error) === 'refresh-reuse-detected') {
        this.wipeSession();
        return this.getPublicSnapshot();
      }
      throw error;
    }
  }

  async revokeSession(revokeFn: RevokeFn): Promise<SyncAuthSnapshot> {
    this.ensureCacheLoaded();
    const cached = this.cached;
    if (cached === null) {
      return this.getPublicSnapshot();
    }
    const refreshToken = this.readRefreshToken();
    try {
      await revokeFn({
        enrollmentId: cached.enrollmentId,
        ...(refreshToken === null ? {} : { refreshToken }),
      });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === null) {
        throw error;
      }
    }
    this.wipeSession();
    return this.getPublicSnapshot();
  }

  getPublicSnapshot(): SyncAuthSnapshot {
    this.ensureCacheLoaded();
    if (this.cached !== null) {
      return {
        state: 'signed-in',
        accountId: this.cached.accountId,
        enrollmentId: this.cached.enrollmentId,
        expiresAt: this.cached.accessExpiresAt,
      };
    }
    if (this.pending !== null) {
      return { state: 'enrolling', accountId: null, enrollmentId: null, expiresAt: null };
    }
    return { state: 'signed-out', accountId: null, enrollmentId: null, expiresAt: null };
  }

  cancelPendingLogin(): void {
    if (this.pending !== null) {
      this.pending.closeListener();
      this.pending = null;
    }
  }
}

export function createSyncAuthService(deps: SyncAuthServiceDeps): SyncAuthService {
  return new SyncAuthService(deps);
}
