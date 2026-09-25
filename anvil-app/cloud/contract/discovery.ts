// Connection-descriptor shape, validation, and endpoint resolution.
//
// The descriptor is untrusted configuration until the user reviews it: TLS
// authenticates the origin, while displayName/deploymentId never establish
// trust. Validation here is purely structural; trust decisions stay in the app.

import { DESCRIPTOR_VERSION, PROFILES, PROTOCOL } from './version';

export type KnownProtocol = typeof PROTOCOL;

export type KnownProfile = (typeof PROFILES)[number];

export type AuthMode = 'oidc-pkce' | 'workos-device' | 'enrollment-code';

const KNOWN_AUTH_MODES: readonly AuthMode[] = [
  'oidc-pkce',
  'workos-device',
  'enrollment-code',
];

export interface DescriptorAuth {
  issuer: string;
  publicClientId: string;
  scopes: string[];
}

export interface DescriptorLimits {
  entityBytes: number;
  pageBytes: number;
  batchChanges: number;
  liveFrameBytes: number;
}

/** Mirrors integration-contract section 2 discovery example exactly. */
export interface BackendDescriptor {
  descriptorVersion: number;
  deploymentId: string;
  displayName: string;
  protocols: string[];
  profiles: string[];
  apiPath: string;
  socketPath: string;
  authModes: string[];
  auth: DescriptorAuth;
  limits: DescriptorLimits;
  /** Optional additive features negotiated independently of frozen profiles. */
  features?: string[];
}

export type DescriptorValidationResult =
  | { ok: true; descriptor: BackendDescriptor }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateRelativePath(field: string, value: unknown, errors: string[]): void {
  if (!isNonEmptyString(value)) {
    errors.push(`${field} must be a non-empty string`);
    return;
  }
  if (value.startsWith('/')) {
    errors.push(`${field} must be relative (no leading slash)`);
  }
  if (value.includes('\\')) {
    errors.push(`${field} must not contain backslashes`);
  }
  if (value.includes('?') || value.includes('#')) {
    errors.push(`${field} must not contain a query or fragment`);
  }
  if (value.includes('://') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    errors.push(`${field} must not contain a scheme or authority`);
  }
  if (/\s/.test(value)) {
    errors.push(`${field} must not contain whitespace`);
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      errors.push(`${field} must not contain parent traversal (..)`);
      break;
    }
    if (segment === '.' || segment === '') {
      errors.push(`${field} must not contain empty or dot segments`);
      break;
    }
  }
}

/**
 * Structural validation of an untrusted discovery payload. Returns every
 * problem found rather than throwing, so connection UX can explain them.
 */
export function validateDescriptor(input: unknown): DescriptorValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ['descriptor must be a JSON object'] };
  }

  if (input['descriptorVersion'] !== DESCRIPTOR_VERSION) {
    errors.push(`descriptorVersion must be ${DESCRIPTOR_VERSION}`);
  }
  if (!isNonEmptyString(input['deploymentId'])) {
    errors.push('deploymentId must be a non-empty string');
  }
  if (!isNonEmptyString(input['displayName'])) {
    errors.push('displayName must be a non-empty string');
  }

  if (!Array.isArray(input['protocols']) || !input['protocols'].includes(PROTOCOL)) {
    errors.push(`protocols must include ${PROTOCOL}`);
  } else if (!input['protocols'].every(isNonEmptyString)) {
    errors.push('protocols must be non-empty strings');
  }

  if (!Array.isArray(input['profiles']) || input['profiles'].length === 0) {
    errors.push('profiles must be a non-empty array');
  } else {
    const known: readonly string[] = PROFILES;
    for (const profile of input['profiles']) {
      if (typeof profile !== 'string' || !known.includes(profile)) {
        errors.push(`unknown profile: ${String(profile)}`);
      }
    }
  }

  validateRelativePath('apiPath', input['apiPath'], errors);
  validateRelativePath('socketPath', input['socketPath'], errors);

  if (!Array.isArray(input['authModes']) || input['authModes'].length === 0) {
    errors.push('authModes must be a non-empty array');
  } else {
    for (const mode of input['authModes']) {
      if (typeof mode !== 'string' || !KNOWN_AUTH_MODES.includes(mode as AuthMode)) {
        errors.push(`unknown authMode: ${String(mode)}`);
      }
    }
  }

  if (input['features'] !== undefined) {
    if (!Array.isArray(input['features']) || !input['features'].every(isNonEmptyString)) {
      errors.push('features must be an array of non-empty strings');
    }
  }

  if (!isRecord(input['auth'])) {
    errors.push('auth must be an object');
  } else {
    const auth = input['auth'];
    if (!isNonEmptyString(auth['issuer'])) {
      errors.push('auth.issuer must be a non-empty string');
    }
    if (!isNonEmptyString(auth['publicClientId'])) {
      errors.push('auth.publicClientId must be a non-empty string');
    }
    if (
      !Array.isArray(auth['scopes']) ||
      auth['scopes'].length === 0 ||
      !auth['scopes'].every(isNonEmptyString)
    ) {
      errors.push('auth.scopes must be a non-empty array of strings');
    }
  }

  if (!isRecord(input['limits'])) {
    errors.push('limits must be an object');
  } else {
    const limits = input['limits'];
    for (const key of ['entityBytes', 'pageBytes', 'batchChanges', 'liveFrameBytes'] as const) {
      if (!isPositiveInteger(limits[key])) {
        errors.push(`limits.${key} must be a positive integer`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, descriptor: input as unknown as BackendDescriptor };
}

export interface ResolvedBackendPaths {
  apiUrl: string;
  socketUrl: string;
}

export interface ResolveOptions {
  /**
   * Permit plain HTTP only for explicitly selected loopback development
   * endpoints. Never enabled for non-loopback hosts.
   */
  allowLoopbackHttp?: boolean;
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower === '[::1]' ||
    /^127\./.test(lower)
  );
}

/**
 * Normalizes the user-entered base to a trailing slash and resolves the
 * descriptor's relative API/socket paths inside the same origin and base
 * path. Throws when the descriptor is invalid, the scheme is not permitted,
 * or a resolved URL would leave the base origin. The socket always uses the
 * secure (wss) or loopback (ws) WebSocket scheme.
 */
export function resolveBackendPaths(
  baseUrl: string,
  descriptor: BackendDescriptor,
  options: ResolveOptions = {},
): ResolvedBackendPaths {
  const validated = validateDescriptor(descriptor);
  if (!validated.ok) {
    throw new Error(`invalid backend descriptor: ${validated.errors.join('; ')}`);
  }
  const valid = validated.descriptor;

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error('base URL is not a valid absolute URL');
  }
  if (base.username !== '' || base.password !== '') {
    throw new Error('base URL must not embed credentials');
  }
  if (!base.pathname.endsWith('/')) {
    base.pathname += '/';
  }
  const baseHref = base.href;

  const secure = base.protocol === 'https:';
  const loopbackHttp =
    base.protocol === 'http:' && options.allowLoopbackHttp === true && isLoopbackHostname(base.hostname);
  if (!secure && !loopbackHttp) {
    throw new Error('base URL must use https (http is allowed only for loopback with explicit opt-in)');
  }

  const api = new URL(valid.apiPath, baseHref);
  const socket = new URL(valid.socketPath, baseHref);
  for (const [label, url] of [['api', api], ['socket', socket]] as const) {
    if (url.origin !== base.origin) {
      throw new Error(`${label} URL leaves the base origin`);
    }
    if (!url.pathname.startsWith(base.pathname)) {
      throw new Error(`${label} URL leaves the base path`);
    }
  }

  socket.protocol = secure ? 'wss:' : 'ws:';
  return { apiUrl: api.href, socketUrl: socket.href };
}
