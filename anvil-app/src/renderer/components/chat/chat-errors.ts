/**
 * CH5 — classify raw chat/turn errors into actionable categories so the
 * composer can offer the right recovery (retry, switch provider, open
 * diagnostics, or the relevant Settings section) instead of a bare string.
 */

export type ChatErrorKind = 'auth' | 'rate-limit' | 'provider' | 'sandbox' | 'generic';

export interface ChatErrorClassification {
  kind: ChatErrorKind;
  /** Short, calm headline for the notice. */
  title: string;
  /** Guidance shown under the raw message. */
  hint: string;
  /** Deep link for the relevant settings surface. */
  settingsPath: string;
  /** Label for the settings link. */
  settingsLabel: string;
}

const AUTH_PATTERN =
  /(401|403|unauthori[sz]ed|forbidden|invalid[-\s]?api[-\s]?key|api[-\s]?key|authentication|auth failed|not logged in|login required|token (expired|invalid|revoked)|credentials)/i;
const RATE_LIMIT_PATTERN =
  /(429|rate[-\s]?limit|too many requests|quota (exceeded|exhausted)|usage limit|throttl)/i;
const SANDBOX_PATTERN =
  /(sandbox|EPERM|EACCES|permission denied|operation not permitted|not permitted|blocked by (policy|sandbox)|outside the (workspace|sandbox))/i;
const PROVIDER_PATTERN =
  /(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|network|socket hang up|502|503|504|500 Internal|overloaded|service unavailable|provider (error|unavailable|down)|spawn .*ENOENT|not installed|command not found|agent (crashed|exited))/i;

export function classifyChatError(message: string): ChatErrorClassification {
  const text = message ?? '';

  // Sandbox first: sandbox errors often contain "permission denied" wording
  // that could read as auth, and auth errors can mention "token" — ordering
  // keeps the most specific surface first.
  if (SANDBOX_PATTERN.test(text)) {
    return {
      kind: 'sandbox',
      title: 'Blocked by sandbox permissions',
      hint: 'The action needed access outside the allowed scope. Retry after raising the access level, or approve the pending request.',
      // Per-workspace access defaults live in Settings → Workspace (ST9).
      settingsPath: '/settings/workspace#chat-access',
      settingsLabel: 'Workspace settings',
    };
  }
  if (RATE_LIMIT_PATTERN.test(text)) {
    return {
      kind: 'rate-limit',
      title: 'Provider rate limit reached',
      hint: 'The provider is throttling requests. Retry in a moment, or switch provider.',
      settingsPath: '/settings/providers#agent-providers',
      settingsLabel: 'Provider settings',
    };
  }
  if (AUTH_PATTERN.test(text)) {
    return {
      kind: 'auth',
      title: 'Authentication problem',
      hint: 'The provider rejected the request credentials. Check the API key or sign-in for this provider.',
      settingsPath: '/settings/providers#agent-providers',
      settingsLabel: 'Provider settings',
    };
  }
  if (PROVIDER_PATTERN.test(text)) {
    return {
      kind: 'provider',
      title: 'Provider unavailable',
      hint: 'The model provider could not be reached. Retry, or switch provider.',
      settingsPath: '/settings/providers#agent-providers',
      settingsLabel: 'Provider settings',
    };
  }
  return {
    kind: 'generic',
    title: 'Something went wrong',
    hint: 'Retry the request, or open diagnostics for the full error details.',
    settingsPath: '/settings/providers#agent-providers',
    settingsLabel: 'Provider settings',
  };
}

/** Whether a "Switch provider" action is worth offering. */
export function chatErrorSupportsProviderSwitch(kind: ChatErrorKind): boolean {
  return kind === 'auth' || kind === 'rate-limit' || kind === 'provider';
}
