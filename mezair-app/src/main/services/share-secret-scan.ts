// Secret scan for outgoing shares (spec §11.5). Runs on desktop over the
// final plaintext — bundle JSON or raw text — before anything is sealed or
// uploaded; the backend never sees plaintext.
//
// Findings are keyed by a stable id derived from the rule and the matched
// value, so the id a user toggles in the preview is the same id publish
// sees, and one secret repeated across the document is one finding.
// Excerpts are masked: the full value never leaves this module.

import { createHash } from 'node:crypto';
import type { ShareSecretFinding } from '../../shared/shares-ipc.js';

export const REDACTED_PLACEHOLDER = '[redacted]';

interface SecretRule {
  id: string;
  label: string;
  pattern: RegExp;
  /** Capture group holding the secret value (0 = whole match). */
  group?: number;
  /** Extra check for generic patterns to keep false positives down. */
  accept?: (value: string) => boolean;
}

interface InternalFinding {
  id: string;
  ruleId: string;
  label: string;
  value: string;
  occurrences: number;
  context: string;
}

// Values never include quotes, backslashes or whitespace, so redacting them
// inside serialised JSON keeps the document valid.
const SECRET_KEY_NAMES =
  '[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth[_-]?key)[A-Za-z0-9_.-]*';

const PLACEHOLDER =
  /^(?:\*+|x{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[^%]+%|null|undefined|none|true|false|changeme|change[_-]?me|example|placeholder|redacted|\[redacted\]|your[_-].*|my[_-].*|process\.env.*|env\..*)$/i;

function looksSecretValue(value: string): boolean {
  if (value.length < 8 || PLACEHOLDER.test(value)) return false;
  if (/^(.)\1+$/.test(value)) return false;
  // Counts, timestamps, dates and versions.
  if (/^[\d.,:+TZ-]+$/.test(value)) return false;
  // Plain words and identifiers are config names, not credentials.
  if (/^[a-z]+$/i.test(value) && value.length < 20) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*\(/.test(value)) return false;
  if (/^https?:\/\//i.test(value) && !/:[^/@]+@/.test(value)) return false;
  return /\d/.test(value) || value.length >= 16;
}

const RULES: SecretRule[] = [
  {
    id: 'private-key',
    label: 'Private key block',
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  {
    id: 'aws-access-key',
    label: 'AWS access key id',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'slack-webhook',
    label: 'Slack webhook URL',
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/]{20,}/g,
  },
  {
    id: 'anthropic-key',
    label: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'openai-key',
    label: 'OpenAI-style API key',
    pattern: /\bsk-(?:proj-|svcacct-|admin-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'stripe-key',
    label: 'Stripe key',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: 'google-api-key',
    label: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'jwt',
    label: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: 'connection-string',
    label: 'Connection string password',
    pattern: /\b[a-z][a-z0-9+.-]{1,30}:\/\/[^\s:/@"'\\<>]+:([^\s@/"'\\<>]+)@[^\s"'\\<>]+/gi,
    group: 1,
    accept: (value) => value.length >= 3 && !PLACEHOLDER.test(value),
  },
  {
    id: 'env-assignment',
    label: 'Secret-looking assignment',
    // Raw continuation strings and their JSON-escaped quote pairs must be
    // scanned too; punctuation such as '&' belongs to the quoted value.
    pattern: new RegExp(
      `(?:^|[^A-Za-z0-9_])(${SECRET_KEY_NAMES})(?:\\\\?["'])?\\s*[:=]\\s*(\\\\?["'])([^\\s<]*?)\\2`,
      'gim',
    ),
    group: 3,
    accept: looksSecretValue,
  },
  {
    id: 'env-assignment',
    label: 'Secret-looking assignment',
    // An unquoted raw continuation value can contain '&'. HTML entities are
    // handled separately below, without mistaking their prefix for the value.
    pattern: new RegExp(
      `(?:^|[^A-Za-z0-9_])(${SECRET_KEY_NAMES})(?:\\\\?["'])?\\s*[:=]\\s*([^\\s'"\\\\<>,;\`)]{8,})`,
      'gim',
    ),
    group: 2,
    accept: (value) =>
      value.includes('&') &&
      !/&(?:amp|lt|gt|quot|#39)(?:;|$)/.test(value) &&
      looksSecretValue(value),
  },
  {
    id: 'env-assignment',
    label: 'Secret-looking assignment',
    // HTML snapshot text quotes become entities before the bundle is JSON
    // encoded. Match inside the quote pair so replacement retains the pair.
    pattern: new RegExp(
      `(?:^|[^A-Za-z0-9_])(${SECRET_KEY_NAMES})(?:&quot;|&#39;)?\\s*[:=]\\s*(&quot;|&#39;)([^\\s<]*?)\\2`,
      'gim',
    ),
    group: 3,
    accept: (value) => looksSecretValue(htmlDecoded(value)),
  },
  {
    id: 'env-assignment',
    label: 'Secret-looking assignment',
    // Consume entities as part of an unquoted value, rather than reporting
    // only the prefix before '&'. Bound the alternation to avoid deep regex
    // stacks on large snapshots and require a delimiter to avoid truncation.
    pattern: new RegExp(
      `(?:^|[^A-Za-z0-9_])(${SECRET_KEY_NAMES})(?:&quot;|&#39;)?\\s*[:=]\\s*((?:&(?:amp|lt|gt);|[^\\s'"\\\\<>,;&\`)]){8,4096})(?=$|[\\s'"\\\\<>,;&\`)])`,
      'gim',
    ),
    group: 2,
    accept: (value) => /&(?:amp|lt|gt);/.test(value) && looksSecretValue(htmlDecoded(value)),
  },
  {
    id: 'env-assignment',
    label: 'Secret-looking assignment',
    pattern: new RegExp(
      `(?:^|[^A-Za-z0-9_])(${SECRET_KEY_NAMES})(?:\\\\?["'])?\\s*[:=]\\s*(?:\\\\?["'])?([^\\s'"\\\\<>,;&\`)]{8,})`,
      'gim',
    ),
    group: 2,
    accept: looksSecretValue,
  },
];

function findingId(ruleId: string, value: string): string {
  return `${ruleId}:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function mask(value: string): string {
  const flat = value.replace(/\s+/g, ' ');
  if (flat.startsWith('-----BEGIN')) {
    const header = /^-----BEGIN [^-]+-----/.exec(flat)?.[0] ?? '-----BEGIN PRIVATE KEY-----';
    return `${header} …`;
  }
  if (flat.length <= 10) return `${flat.slice(0, 2)}${'•'.repeat(6)}`;
  return `${flat.slice(0, 4)}${'•'.repeat(8)}${flat.slice(-2)}`;
}

function contextLabel(text: string, index: number): string {
  // A short key-ish prefix ("DATABASE_URL=", "apiKey:") helps the user
  // place the hit without exposing any of the value.
  const before = text.slice(Math.max(0, index - 32), index);
  const match = /([A-Za-z0-9_.-]{2,32})\\?["']?\s*[:=]\s*\\?["']?$/.exec(before);
  return match ? `${match[1]}=` : '';
}

function countOccurrences(text: string, value: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(value, from);
    if (at < 0) return count;
    count += 1;
    from = at + value.length;
  }
}

/** Decode exactly the entities emitted by our snapshot text escaper. */
function htmlDecoded(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|#39);/g,
    (entity) =>
      ({
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'",
      })[entity] ?? entity,
  );
}

/** Match the escaping used for conversation and attachment snapshot text. */
function htmlEscaped(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON-escaped form of a value as it appears inside a serialised string. */
function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function scanInternal(text: string, knownSecrets: readonly string[]): InternalFinding[] {
  const byValue = new Map<string, InternalFinding>();
  const add = (ruleId: string, label: string, value: string, index: number, stableId?: string) => {
    if (value.length === 0 || value.includes(REDACTED_PLACEHOLDER)) return;
    if (byValue.has(value)) return;
    // A value already covered by a longer, more specific hit (e.g. the
    // token inside `GITHUB_TOKEN=ghp_…`) is the same finding.
    for (const existing of byValue.values()) {
      if (ruleId !== 'known-secret' && existing.value.includes(value)) {
        const start = text.lastIndexOf(existing.value, index);
        if (start >= 0 && start + existing.value.length >= index + value.length) return;
      }
    }
    byValue.set(value, {
      id: stableId ?? findingId(ruleId, value),
      ruleId,
      label,
      value,
      occurrences: countOccurrences(text, value),
      context: contextLabel(text, index),
    });
  };

  for (const secret of knownSecrets) {
    if (typeof secret !== 'string' || secret.trim().length < 8) continue;
    const html = htmlEscaped(secret);
    const jsonInHtml = htmlEscaped(jsonEscaped(secret));
    // Snapshot HTML is then serialised into bundle JSON. Scan every form that
    // can reach the recipient; redact the matched encoded bytes themselves.
    for (const form of new Set([
      secret,
      jsonEscaped(secret),
      html,
      jsonEscaped(html),
      jsonInHtml,
      jsonEscaped(jsonInHtml),
    ])) {
      const at = text.indexOf(form);
      if (at >= 0)
        add('known-secret', 'Saved Mezair credential', form, at, findingId('known-secret', secret));
    }
  }

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[rule.group ?? 0];
      if (typeof value !== 'string') continue;
      if (rule.accept && !rule.accept(value)) continue;
      const offset = rule.group ? match[0].lastIndexOf(value) : 0;
      add(rule.id, rule.label, value, (match.index ?? 0) + Math.max(0, offset));
    }
  }
  return [...byValue.values()];
}

export interface SecretScanOptions {
  /** Values held in Mezair's credential storage (exact-match hits). */
  knownSecrets?: readonly string[];
}

/** Scans plaintext for secrets. Findings carry masked excerpts only. */
export function scanForSecrets(
  text: string,
  options: SecretScanOptions = {},
): ShareSecretFinding[] {
  const findings = new Map<string, ShareSecretFinding>();
  for (const finding of scanInternal(text, options.knownSecrets ?? [])) {
    const existing = findings.get(finding.id);
    if (existing) {
      existing.occurrences = (existing.occurrences ?? 0) + finding.occurrences;
    } else {
      findings.set(finding.id, {
        id: finding.id,
        label: finding.label,
        excerpt: `${finding.context}${mask(finding.value)}`,
        occurrences: finding.occurrences,
      });
    }
  }
  return [...findings.values()];
}

/**
 * Replaces every occurrence of the selected findings' values with
 * `[redacted]`. Ids that no longer match anything are ignored.
 */
export function redactSecrets(
  text: string,
  findingIds: readonly string[],
  options: SecretScanOptions = {},
): string {
  if (findingIds.length === 0) return text;
  const wanted = new Set(findingIds);
  const targets = scanInternal(text, options.knownSecrets ?? [])
    .filter((finding) => wanted.has(finding.id))
    // Longest first so a value containing another is replaced whole.
    .sort((a, b) => b.value.length - a.value.length);
  let result = text;
  for (const finding of targets) {
    result = result.split(finding.value).join(REDACTED_PLACEHOLDER);
  }
  return result;
}

/** Ids of findings that are neither redacted nor explicitly acknowledged. */
export function unresolvedFindings(
  findings: readonly ShareSecretFinding[],
  redactIds: readonly string[] = [],
  acknowledgeIds: readonly string[] = [],
): ShareSecretFinding[] {
  const resolved = new Set([...redactIds, ...acknowledgeIds]);
  return findings.filter((finding) => !resolved.has(finding.id));
}
