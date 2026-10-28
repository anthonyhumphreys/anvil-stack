// Synthetic inline-surface fixtures for the chat replay preview
// (docs/plans/inline-artifacts-and-canvas-tools.md §14: one replay fixture per surface).
// Every payload is local, deterministic and validates against its kind schema
// (asserted in chat-replay.test.ts). Artifact, revision and sketch rows are
// served to the surface views by the preview's in-memory window.mezair stub.

import {
  AGENT_UI_PROTOCOL_VERSION,
  type AgentUISurfaceIntent,
} from '../../../../shared/agent-ui-intents';
import type { ArtifactSurfacePayload } from '../../../../shared/surfaces/kinds/artifact';
import type { DataSurfaceData } from '../../../../shared/surfaces/kinds/data';
import {
  classifyLicense,
  summarizeDependencies,
  type DependenciesSurfaceData,
  type DependencyPackage,
} from '../../../../shared/surfaces/kinds/dependencies';
import type {
  FindingsSurfaceData,
  SurfaceFinding,
} from '../../../../shared/surfaces/kinds/findings';
import type { PipelineSurfaceData } from '../../../../shared/surfaces/kinds/pipeline';
import type { ReviewFinding, ReviewSurfaceData } from '../../../../shared/surfaces/kinds/review';
import { parseUnifiedDiff } from '../../../../shared/surfaces/kinds/review/diff';
import { reconcileVerdict, reviewSurfaceKey } from '../../../../shared/surfaces/kinds/review/model';
import type { SketchSurfacePayload } from '../../../../shared/surfaces/kinds/sketch';
import type { ChatArtifactRevision } from '../../../../shared/surfaces/ipc';
import { getSurfaceKind } from '../../../../shared/surfaces/registry';
import type { ChatSketch } from '../../../../shared/surfaces/types';
import type { ChatArtifact, ChatMessage, CodexEvent } from '../../../../shared/types';
import type { ChatReplayScenario } from './chat-replay-fixtures';

export const REPLAY_SURFACE_REPO_ID = 'fixture-synthetic-repo';
export const REPLAY_SURFACE_REPO_NAME = 'mezair-demo (synthetic)';
const WORKSPACE_ID = 'fixture-workspace';
const BASE_TIME = Date.parse('2026-09-25T09:00:00.000Z');

/** Fixture clock: minutes after the shared replay timestamp. */
function at(minutes: number): string {
  return new Date(BASE_TIME + minutes * 60_000).toISOString();
}

interface SurfaceOptions {
  revision?: number;
  streaming?: boolean;
  key?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Builds a published surface intent the way main does: digest from the kind definition. */
export function buildReplaySurface(
  id: string,
  threadId: string,
  surfaceKind: string,
  title: string,
  data: unknown,
  options: SurfaceOptions = {},
): AgentUISurfaceIntent {
  const definition = getSurfaceKind(surfaceKind);
  if (!definition) throw new Error(`Unknown synthetic surface kind: ${surfaceKind}`);
  const createdAt = options.createdAt ?? at(0);
  return {
    protocolVersion: AGENT_UI_PROTOCOL_VERSION,
    id,
    kind: 'surface',
    revision: options.revision ?? 1,
    scope: { threadId, workspaceId: WORKSPACE_ID },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind,
      title,
      ...(options.key ? { key: options.key } : {}),
      streaming: options.streaming ?? false,
      digest: definition.digest(data),
      data,
    },
    createdAt,
    updatedAt: options.updatedAt ?? createdAt,
  };
}

function surfaceMessage(id: string, threadId: string, intent: AgentUISurfaceIntent): ChatMessage {
  return {
    id,
    threadId,
    personaId: 'coder',
    role: 'system',
    content: '',
    timestamp: intent.updatedAt,
    event: { type: 'agent_ui_intent', agentUIIntent: intent },
  };
}

function userMessage(id: string, threadId: string, content: string, minutes = 0): ChatMessage {
  return { id, threadId, personaId: 'coder', role: 'user', content, timestamp: at(minutes) };
}

function eventMessage(id: string, threadId: string, event: CodexEvent, minutes = 0): ChatMessage {
  return {
    id,
    threadId,
    personaId: 'coder',
    role: 'system',
    content: '',
    timestamp: at(minutes),
    event,
  };
}

function answerMessage(id: string, threadId: string, text: string, minutes = 0): ChatMessage {
  return eventMessage(
    id,
    threadId,
    { type: 'text', itemId: `${id}-item`, assistantPhase: 'final', text },
    minutes,
  );
}

function toolCall(
  id: string,
  threadId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
  minutes = 0,
): ChatMessage {
  return eventMessage(
    id,
    threadId,
    { type: 'tool_call', itemId: id, toolName, toolStatus: 'completed', toolInput, toolOutput },
    minutes,
  );
}

// ---------------------------------------------------------------------------
// Review (working tree)
// ---------------------------------------------------------------------------

const REVIEW_DIFF = [
  'diff --git a/src/auth/refresh.ts b/src/auth/refresh.ts',
  '--- a/src/auth/refresh.ts',
  '+++ b/src/auth/refresh.ts',
  "@@ -8,9 +8,11 @@ import { audit } from './audit';",
  ' ',
  ' export async function refresh(token: string) {',
  '   const session = await load(token);',
  '   if (!session) return null;',
  '-  const next = rotate(session);',
  '+  const next = await gateway.rotate(session);',
  '+  cache.set(token, next);',
  '+  audit(next);',
  '   return next;',
  ' }',
  ' ',
  ' function rotate(session: Session) {',
  '@@ -40,4 +42,4 @@ function rotate(session: Session) {',
  '   const id = session.id;',
  '-  return { id, at: Date.now() };',
  '+  return { id, at: clock.now(), ttl: session.ttl };',
  ' }',
  ' ',
  'diff --git a/src/gateway/token-gateway.ts b/src/gateway/token-gateway.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/gateway/token-gateway.ts',
  '@@ -0,0 +1,23 @@',
  "+import { logger } from '../log';",
  "+import { limiter } from './rate-limit';",
  "+import type { Session } from '../auth/session-store';",
  '+',
  '+export interface RotatedSession extends Session {',
  '+  rotatedAt: number;',
  '+}',
  '+',
  '+export const gateway = {',
  '+  async rotate(session: Session): Promise<RotatedSession> {',
  '+    await limiter.take(session.userId);',
  "+    logger.info('rotating session', { refreshToken: session.refreshToken });",
  '+    const response = await fetch(`${process.env.GATEWAY_URL}/rotate`, {',
  "+      method: 'POST',",
  '+      body: JSON.stringify({ id: session.id }),',
  '+    });',
  '+    if (!response.ok) {',
  '+      throw new Error(`Gateway rotation failed: ${response.status}`);',
  '+    }',
  '+    const body = (await response.json()) as Session;',
  '+    return { ...body, rotatedAt: Date.now() };',
  '+  },',
  '+};',
  'diff --git a/src/gateway/rate-limit.ts b/src/gateway/rate-limit.ts',
  '--- a/src/gateway/rate-limit.ts',
  '+++ b/src/gateway/rate-limit.ts',
  '@@ -1,10 +1,12 @@',
  ' const WINDOW_MS = 60_000;',
  '-const MAX_REQUESTS = 30;',
  '+const MAX_REQUESTS = 120;',
  '+const buckets = new Map<string, number[]>();',
  ' ',
  ' export const limiter = {',
  '-  async take(ip: string) {',
  '-    const hits = recent(ip);',
  '+  async take(key: string) {',
  '+    const hits = (buckets.get(key) ?? []).filter((at) => at > Date.now() - WINDOW_MS);',
  "     if (hits.length >= MAX_REQUESTS) throw new Error('Rate limited');",
  '-    record(ip);',
  '+    hits.push(Date.now());',
  '+    buckets.set(key, hits);',
  '   },',
  ' };',
  'diff --git a/src/auth/session-store.ts b/src/auth/session-store.ts',
  '--- a/src/auth/session-store.ts',
  '+++ b/src/auth/session-store.ts',
  '@@ -18,7 +18,7 @@ export interface Session {',
  ' ',
  ' export function persist(session: Session) {',
  '   const key = `session:${session.id}`;',
  '-  store.set(key, session, { ttl: session.ttl * 1000 });',
  '+  store.set(key, session, { ttl: session.ttl });',
  '   return key;',
  ' }',
  ' ',
  'diff --git a/test/auth/refresh.test.ts b/test/auth/refresh.test.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/test/auth/refresh.test.ts',
  '@@ -0,0 +1,14 @@',
  "+import { describe, expect, it, vi } from 'vitest';",
  "+import { refresh } from '../../src/auth/refresh';",
  '+',
  "+describe('refresh', () => {",
  "+  it('rotates through the gateway', async () => {",
  "+    vi.mock('../../src/gateway/token-gateway');",
  "+    const next = await refresh('token-1');",
  '+    expect(next).not.toBeNull();',
  '+  });',
  '+',
  "+  it('returns null for unknown tokens', async () => {",
  "+    expect(await refresh('missing')).toBeNull();",
  '+  });',
  '+});',
  'diff --git a/src/old/legacy-refresh.ts b/src/old/legacy-refresh.ts',
  'deleted file mode 100644',
  '--- a/src/old/legacy-refresh.ts',
  '+++ /dev/null',
  '@@ -1,4 +0,0 @@',
  '-export function legacyRefresh(token: string) {',
  "-  return fetch('/legacy/refresh', { method: 'POST', body: token });",
  '-}',
  '-',
  '',
].join('\n');

/** Parsed once; findings below are anchored to these hunks (asserted in tests). */
export const REPLAY_REVIEW_DIFF_FILES = parseUnifiedDiff(REVIEW_DIFF);

const REVIEW_CHAPTER_FILES: Record<string, string[]> = {
  'ch-gateway': [
    'src/auth/refresh.ts',
    'src/gateway/token-gateway.ts',
    'src/old/legacy-refresh.ts',
  ],
  'ch-limits': ['src/gateway/rate-limit.ts'],
  'ch-sessions': ['src/auth/session-store.ts', 'test/auth/refresh.test.ts'],
};

function chapterFiles(chapterId: string) {
  return REVIEW_CHAPTER_FILES[chapterId].map((path) => {
    const file = REPLAY_REVIEW_DIFF_FILES.find((candidate) => candidate.path === path);
    return { path, additions: file?.additions ?? 0, deletions: file?.deletions ?? 0 };
  });
}

const REVIEW_FINDINGS: ReviewFinding[] = [
  {
    id: 'f2',
    severity: 'high',
    category: 'Bug risk',
    title: 'Cache write races the gateway rotation',
    rationale:
      'Two concurrent refreshes for the same token both reach the gateway. The second rotation invalidates the first, but the first write can land in the cache last, so the cached session is already revoked.',
    filePath: 'src/auth/refresh.ts',
    lineStart: 12,
    lineEnd: 13,
    suggestion: 'Serialise refreshes per token, or compare-and-set the cache entry on rotatedAt.',
    status: 'open',
    chapterId: 'ch-gateway',
  },
  {
    id: 'f1',
    severity: 'critical',
    category: 'Security',
    title: 'Refresh token is written to the application log',
    rationale:
      'The info log includes session.refreshToken. Anyone with log access can mint sessions until the token expires, and logs are shipped to a third-party aggregator.',
    filePath: 'src/gateway/token-gateway.ts',
    lineStart: 12,
    lineEnd: 12,
    suggestion: 'Log the session id only.',
    suggestedPatch: [
      '--- a/src/gateway/token-gateway.ts',
      '+++ b/src/gateway/token-gateway.ts',
      '@@ -12,1 +12,1 @@',
      "-    logger.info('rotating session', { refreshToken: session.refreshToken });",
      "+    logger.info('rotating session', { sessionId: session.id });",
      '',
    ].join('\n'),
    status: 'open',
    chapterId: 'ch-gateway',
  },
  {
    id: 'f3',
    severity: 'high',
    category: 'Performance',
    title: 'Rate-limit buckets are never evicted',
    rationale:
      'Every user id gets a bucket that is filtered but never deleted. Long-running gateways grow without bound; at the current login rate that is roughly 40 MB a day.',
    filePath: 'src/gateway/rate-limit.ts',
    lineStart: 3,
    lineEnd: 3,
    suggestion: 'Delete empty buckets after filtering, or use an LRU with a size cap.',
    status: 'open',
    chapterId: 'ch-limits',
  },
  {
    id: 'f4',
    severity: 'medium',
    category: 'Correctness',
    title: 'Session TTL is now seconds passed as milliseconds',
    rationale:
      'session.ttl is in seconds. Dropping the * 1000 makes sessions expire after a few seconds in the store, which forces a refresh on almost every request.',
    filePath: 'src/auth/session-store.ts',
    lineStart: 21,
    lineEnd: 21,
    status: 'open',
    chapterId: 'ch-sessions',
  },
  {
    id: 'f5',
    severity: 'medium',
    category: 'Tests',
    title: 'vi.mock inside a test body does not mock the import under test',
    rationale:
      'vi.mock is hoisted only at module scope. Inside the test it runs after refresh has imported the real gateway, so the test calls the network.',
    filePath: 'test/auth/refresh.test.ts',
    lineStart: 6,
    lineEnd: 6,
    suggestion: 'Move vi.mock to the top of the file.',
    status: 'open',
    chapterId: 'ch-sessions',
  },
  {
    id: 'f6',
    severity: 'low',
    category: 'Tests',
    title: 'No test covers a failed gateway rotation',
    rationale: 'The throw on a non-OK response is the new failure mode and has no coverage.',
    filePath: 'test/auth/refresh.test.ts',
    lineStart: 5,
    lineEnd: 9,
    status: 'open',
    chapterId: 'ch-sessions',
  },
  {
    id: 'f7',
    severity: 'low',
    category: 'Maintainability',
    title: 'Limit raised from 30 to 120 without a note',
    rationale: 'A fourfold change to an abuse control deserves a comment or a config entry.',
    filePath: 'src/gateway/rate-limit.ts',
    lineStart: 2,
    lineEnd: 2,
    status: 'open',
    chapterId: 'ch-limits',
  },
  {
    id: 'f8',
    severity: 'info',
    category: 'Cleanup',
    title: 'Confirm nothing still imports legacyRefresh',
    rationale: 'The file is deleted; a stale import would only fail at build time.',
    filePath: 'src/old/legacy-refresh.ts',
    lineStart: 1,
    lineEnd: 3,
    status: 'open',
    chapterId: 'ch-gateway',
  },
];

function buildReviewData(findingIds: readonly string[], final: boolean): ReviewSurfaceData {
  const findings = REVIEW_FINDINGS.filter((finding) => findingIds.includes(finding.id));
  const hunks = Object.fromEntries(REPLAY_REVIEW_DIFF_FILES.map((file) => [file.path, file.hunks]));
  return {
    scope: { type: 'working-tree', repoId: REPLAY_SURFACE_REPO_ID, title: 'Uncommitted changes' },
    verdict: final
      ? {
          decision: 'blocked',
          summary:
            'Blocked on the logged refresh token; the rotation race and unbounded limiter need fixes before this ships.',
          source: 'agent',
        }
      : reconcileVerdict(undefined, findings),
    stats: {
      files: REPLAY_REVIEW_DIFF_FILES.length,
      additions: REPLAY_REVIEW_DIFF_FILES.reduce((sum, file) => sum + file.additions, 0),
      deletions: REPLAY_REVIEW_DIFF_FILES.reduce((sum, file) => sum + file.deletions, 0),
    },
    risks: final
      ? [
          {
            id: 'r1',
            title: 'Credential exposure in logs',
            chapterId: 'ch-gateway',
            severity: 'critical',
          },
          {
            id: 'r2',
            title: 'Unbounded memory in the gateway',
            chapterId: 'ch-limits',
            severity: 'high',
          },
          {
            id: 'r3',
            title: 'Refresh storm from short TTLs',
            chapterId: 'ch-sessions',
            severity: 'medium',
          },
        ]
      : [
          {
            id: 'r1',
            title: 'Credential exposure in logs',
            chapterId: 'ch-gateway',
            severity: 'critical',
          },
        ],
    chapters: [
      {
        id: 'ch-gateway',
        index: 1,
        title: 'Token refresh moves to the gateway',
        summary:
          'refresh() now rotates through a new gateway client, caches the result and audits it. The old in-process rotation and the legacy endpoint are removed.',
        files: chapterFiles('ch-gateway'),
      },
      {
        id: 'ch-limits',
        index: 2,
        title: 'Rate limiting keys on the user, not the IP',
        summary:
          'The limiter keeps per-key buckets in memory and allows four times as many requests per window.',
        files: chapterFiles('ch-limits'),
      },
      {
        id: 'ch-sessions',
        index: 3,
        title: 'Session storage and tests',
        summary: 'The store TTL changes units and refresh gets its first two tests.',
        files: chapterFiles('ch-sessions'),
      },
    ],
    findings,
    files: REPLAY_REVIEW_DIFF_FILES.map((file) => ({
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
    hunks,
    fullDiff: hunks,
    notes: ['Synthetic working tree. Line numbers refer to the fixture diff only.'],
  };
}

const reviewThread = 'fixture-surface-review';
const reviewSurfaceId = 'fixture-surface-review-working-tree';
const reviewKey = reviewSurfaceKey({ type: 'working-tree', repoId: REPLAY_SURFACE_REPO_ID });

function reviewRevision(revision: number, findingIds: string[], streaming: boolean) {
  return buildReplaySurface(
    reviewSurfaceId,
    reviewThread,
    'review',
    'Review · working tree',
    buildReviewData(findingIds, !streaming),
    { revision, streaming, key: reviewKey, createdAt: at(1), updatedAt: at(1 + revision) },
  );
}

export const REPLAY_REVIEW_REVISIONS = [
  reviewRevision(1, ['f2'], true),
  reviewRevision(2, ['f1', 'f2', 'f3', 'f4'], true),
  reviewRevision(
    3,
    REVIEW_FINDINGS.map((finding) => finding.id),
    false,
  ),
];

const reviewScenario: ChatReplayScenario = {
  id: 'surface-review-working-tree',
  title: 'Surface · Review (working tree)',
  description:
    'A Review surface streams in: verdict, chapters and risks first, then findings, then the complete review with eight findings across every severity.',
  initialThreadId: reviewThread,
  threads: [{ id: reviewThread, title: 'Review my changes' }],
  steps: [
    {
      kind: 'message',
      threadId: reviewThread,
      message: userMessage('review-user', reviewThread, 'Review my uncommitted changes.'),
    },
    {
      kind: 'message',
      threadId: reviewThread,
      message: toolCall(
        'review-context',
        reviewThread,
        'review_context',
        { repoId: REPLAY_SURFACE_REPO_ID, scope: 'working-tree' },
        'Synthetic diff: 6 files, chapters seed and rubric returned.',
        1,
      ),
    },
    ...REPLAY_REVIEW_REVISIONS.map((intent) => ({
      kind: 'message' as const,
      threadId: reviewThread,
      message: surfaceMessage(`review-surface-r${intent.revision}`, reviewThread, intent),
    })),
    {
      kind: 'message',
      threadId: reviewThread,
      message: answerMessage(
        'review-answer',
        reviewThread,
        'The review is above. Fix the logged refresh token first; the rotation race and limiter eviction can follow in the same change.',
        5,
      ),
    },
  ],
};

// ---------------------------------------------------------------------------
// Findings (security audit)
// ---------------------------------------------------------------------------

const SECURITY_FINDINGS: SurfaceFinding[] = [
  {
    id: 'sec-1',
    severity: 'critical',
    title: 'Refresh token logged in plaintext',
    detail: 'token-gateway.ts logs the refresh token on every rotation.',
    category: 'A09 Security Logging and Monitoring Failures',
    filePath: 'src/gateway/token-gateway.ts',
    lineStart: 12,
    lineEnd: 12,
    recommendation: 'Log the session id instead and rotate any tokens already in the log store.',
    status: 'open',
    refs: ['CWE-532'],
  },
  {
    id: 'sec-2',
    severity: 'high',
    title: 'Gateway URL read from the environment without validation',
    detail: 'A misconfigured GATEWAY_URL sends session ids to an arbitrary host.',
    category: 'A05 Security Misconfiguration',
    filePath: 'src/gateway/token-gateway.ts',
    lineStart: 13,
    lineEnd: 13,
    recommendation: 'Validate the URL against an allowlist at start-up.',
    status: 'open',
    refs: ['CWE-918'],
  },
  {
    id: 'sec-3',
    severity: 'medium',
    title: 'Session cookie lacks SameSite',
    detail: 'The session cookie is set without SameSite, so cross-site POSTs carry it.',
    category: 'A01 Broken Access Control',
    filePath: 'src/http/cookies.ts',
    lineStart: 27,
    lineEnd: 31,
    recommendation: 'Set SameSite=Lax (or Strict for the admin app).',
    status: 'open',
  },
  {
    id: 'sec-4',
    severity: 'medium',
    title: 'Password reset tokens never expire',
    detail: 'Reset tokens are stored without an expiry and stay valid after use.',
    category: 'A07 Identification and Authentication Failures',
    filePath: 'src/auth/reset.ts',
    lineStart: 44,
    status: 'fix-requested',
  },
  {
    id: 'sec-5',
    severity: 'low',
    title: 'Verbose stack traces in API errors',
    detail: 'Unhandled errors return stack traces in production responses.',
    category: 'A05 Security Misconfiguration',
    filePath: 'src/http/errors.ts',
    lineStart: 9,
    status: 'open',
  },
  {
    id: 'sec-6',
    severity: 'info',
    title: 'Content Security Policy is report-only',
    detail: 'The CSP header is in report-only mode; violations are logged but not blocked.',
    category: 'A05 Security Misconfiguration',
    status: 'dismissed',
  },
];

function buildFindingsData(complete: boolean): FindingsSurfaceData {
  return {
    source: 'security-audit',
    repoId: REPLAY_SURFACE_REPO_ID,
    title: 'Security audit',
    summary: complete
      ? 'One critical credential leak and one high-risk SSRF path. The rest are hardening items.'
      : undefined,
    auditId: 'fixture-audit-1',
    auditStatus: complete ? 'completed' : 'running',
    ...(complete ? {} : { progress: { message: 'Checking authentication flows', percent: 45 } }),
    scope: ['OWASP Top 10 (2021)'],
    findings: complete ? SECURITY_FINDINGS : SECURITY_FINDINGS.slice(0, 2),
  };
}

const findingsThread = 'fixture-surface-findings';
const findingsSurfaceId = 'fixture-surface-findings-security';
export const REPLAY_FINDINGS_REVISIONS = [
  buildReplaySurface(
    findingsSurfaceId,
    findingsThread,
    'findings',
    'Security audit',
    buildFindingsData(false),
    { revision: 1, streaming: true, createdAt: at(1) },
  ),
  buildReplaySurface(
    findingsSurfaceId,
    findingsThread,
    'findings',
    'Security audit',
    buildFindingsData(true),
    { revision: 2, streaming: false, createdAt: at(1), updatedAt: at(3) },
  ),
];

const findingsScenario: ChatReplayScenario = {
  id: 'surface-findings',
  title: 'Surface · Findings (security audit)',
  description:
    'A security audit publishes while running, then completes with six findings, one fix requested and one dismissed.',
  initialThreadId: findingsThread,
  threads: [{ id: findingsThread, title: 'Security audit' }],
  steps: [
    {
      kind: 'message',
      threadId: findingsThread,
      message: userMessage('findings-user', findingsThread, 'Run a security audit of this repo.'),
    },
    ...REPLAY_FINDINGS_REVISIONS.map((intent) => ({
      kind: 'message' as const,
      threadId: findingsThread,
      message: surfaceMessage(`findings-surface-r${intent.revision}`, findingsThread, intent),
    })),
    {
      kind: 'message',
      threadId: findingsThread,
      message: answerMessage(
        'findings-answer',
        findingsThread,
        'Start with sec-1: it leaks a credential today. sec-2 needs a config change before the gateway goes live.',
        4,
      ),
    },
  ],
};

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

function pkg(
  name: string,
  version: string,
  direct: boolean,
  license: string,
  extra: Partial<DependencyPackage> = {},
): DependencyPackage {
  return {
    name,
    version,
    manager: 'pnpm',
    direct,
    license,
    licenseStatus: classifyLicense(license),
    ...extra,
  };
}

const DEPENDENCY_PACKAGES: DependencyPackage[] = [
  pkg('jsonwebtoken', '8.5.1', true, 'MIT', {
    vulnerabilities: [
      {
        id: 'GHSA-8cf7-32gw-wr33',
        severity: 'high',
        title: 'Signature validation bypass with insecure key types',
        fixedIn: '9.0.0',
      },
    ],
  }),
  pkg('axios', '0.21.1', true, 'MIT', {
    vulnerabilities: [
      {
        id: 'GHSA-wf5p-g6vw-rhxx',
        severity: 'medium',
        title: 'Cross-site request forgery via XSRF-TOKEN leakage',
        fixedIn: '1.6.0',
      },
      {
        id: 'GHSA-cph5-m8f7-6c5x',
        severity: 'high',
        title: 'Server-side request forgery with absolute URLs',
        fixedIn: '0.21.2',
      },
    ],
  }),
  pkg('request', '2.88.2', true, 'Apache-2.0', { deprecated: true, alternative: 'undici' }),
  pkg('react', '19.1.0', true, 'MIT'),
  pkg('zod', '3.23.8', true, 'MIT'),
  pkg('ghostscript-wrapper', '1.4.0', true, 'AGPL-3.0'),
  pkg('minimist', '1.2.5', false, 'MIT', {
    vulnerabilities: [
      {
        id: 'GHSA-xvch-5gv4-984h',
        severity: 'critical',
        title: 'Prototype pollution',
        fixedIn: '1.2.6',
      },
    ],
  }),
  pkg('left-pad', '1.3.0', false, 'WTFPL', { deprecated: true }),
  pkg('mystery-lib', '0.0.3', false, 'UNKNOWN'),
];

export const REPLAY_DEPENDENCIES_DATA: DependenciesSurfaceData = {
  repoId: REPLAY_SURFACE_REPO_ID,
  repoName: REPLAY_SURFACE_REPO_NAME,
  managers: ['pnpm'],
  packages: DEPENDENCY_PACKAGES,
  summary: summarizeDependencies(
    DEPENDENCY_PACKAGES,
    {
      audits: [
        {
          manager: 'pnpm',
          ranAt: at(1),
          ok: true,
          vulnerabilityCount: 4,
          note: 'pnpm audit reports advisories for the lockfile only.',
        },
      ],
      licensesCheckedAt: at(1),
    },
    at(1),
  ),
};

const dependenciesThread = 'fixture-surface-dependencies';
const dependenciesScenario: ChatReplayScenario = {
  id: 'surface-dependencies',
  title: 'Surface · Dependencies',
  description:
    'A dependency table with audit and licence overlays: vulnerable, deprecated, restricted and unknown-licence packages.',
  initialThreadId: dependenciesThread,
  threads: [{ id: dependenciesThread, title: 'Dependency check' }],
  steps: [
    {
      kind: 'message',
      threadId: dependenciesThread,
      message: userMessage('deps-user', dependenciesThread, 'Are our dependencies OK?'),
    },
    {
      kind: 'message',
      threadId: dependenciesThread,
      message: surfaceMessage(
        'deps-surface',
        dependenciesThread,
        buildReplaySurface(
          'fixture-surface-dependencies',
          dependenciesThread,
          'dependencies',
          'Dependencies · mezair-demo',
          REPLAY_DEPENDENCIES_DATA,
          { createdAt: at(2) },
        ),
      ),
    },
    {
      kind: 'message',
      threadId: dependenciesThread,
      message: answerMessage(
        'deps-answer',
        dependenciesThread,
        'Upgrade minimist and jsonwebtoken first. ghostscript-wrapper is AGPL and needs a licence decision.',
        3,
      ),
    },
  ],
};

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

const CI_FILE = '.github/workflows/ci.yml';
const DEPLOY_FILE = '.github/workflows/deploy.yml';

export const REPLAY_PIPELINE_DATA: PipelineSurfaceData = {
  repoId: REPLAY_SURFACE_REPO_ID,
  repoName: REPLAY_SURFACE_REPO_NAME,
  generatedAt: at(1),
  providers: ['github-actions'],
  files: [
    { path: CI_FILE, provider: 'github-actions', role: 'entrypoint', name: 'CI', valid: true },
    {
      path: DEPLOY_FILE,
      provider: 'github-actions',
      role: 'entrypoint',
      name: 'Deploy',
      valid: true,
    },
  ],
  nodes: [
    {
      id: 'wf-ci',
      type: 'workflow',
      label: 'CI',
      subtitle: 'push, pull_request',
      status: 'configured',
      filePath: CI_FILE,
      provider: 'github-actions',
    },
    {
      id: 'job-install',
      type: 'job',
      label: 'install',
      subtitle: 'ubuntu-latest · 3m 40s p50',
      status: 'warning',
      filePath: CI_FILE,
      excerpt:
        'install:\n  runs-on: ubuntu-latest\n  steps:\n    - uses: actions/checkout@v4\n    - run: pnpm install',
      excerptStartLine: 9,
    },
    {
      id: 'job-lint',
      type: 'job',
      label: 'lint',
      subtitle: '1m 05s p50',
      status: 'configured',
      filePath: CI_FILE,
    },
    {
      id: 'job-test',
      type: 'job',
      label: 'test',
      subtitle: 'matrix: node 20, 22 · 9m 12s p50',
      status: 'error',
      filePath: CI_FILE,
      excerpt:
        'test:\n  needs: install\n  strategy:\n    matrix:\n      node: [20, 22]\n  steps:\n    - run: pnpm test',
      excerptStartLine: 24,
    },
    {
      id: 'job-build',
      type: 'job',
      label: 'build',
      subtitle: '2m 30s p50',
      status: 'configured',
      filePath: CI_FILE,
    },
    {
      id: 'wf-deploy',
      type: 'workflow',
      label: 'Deploy',
      subtitle: 'workflow_run: CI',
      status: 'configured',
      filePath: DEPLOY_FILE,
      provider: 'github-actions',
    },
    {
      id: 'gate-prod',
      type: 'gate',
      label: 'production approval',
      subtitle: 'environment: production',
      status: 'configured',
      filePath: DEPLOY_FILE,
    },
    {
      id: 'job-release',
      type: 'job',
      label: 'release',
      subtitle: '4m 10s p50',
      status: 'warning',
      filePath: DEPLOY_FILE,
    },
  ],
  edges: [
    { from: 'wf-ci', to: 'job-install' },
    { from: 'job-install', to: 'job-lint', label: 'needs' },
    { from: 'job-install', to: 'job-test', label: 'needs' },
    { from: 'job-lint', to: 'job-build', label: 'needs' },
    { from: 'job-test', to: 'job-build', label: 'needs' },
    { from: 'job-build', to: 'wf-deploy', label: 'workflow_run' },
    { from: 'wf-deploy', to: 'gate-prod' },
    { from: 'gate-prod', to: 'job-release' },
  ],
  issues: [
    {
      id: 'issue-cache',
      severity: 'warning',
      filePath: CI_FILE,
      message: 'install does not cache the pnpm store; every job reinstalls from scratch.',
      nodeId: 'job-install',
    },
    {
      id: 'issue-flaky',
      severity: 'error',
      filePath: CI_FILE,
      message: 'test failed 4 of the last 20 runs on node 22 with a timeout in refresh.test.ts.',
      nodeId: 'job-test',
    },
    {
      id: 'issue-pin',
      severity: 'info',
      filePath: DEPLOY_FILE,
      message: 'release uses an unpinned third-party action.',
      nodeId: 'job-release',
    },
  ],
};

const pipelineThread = 'fixture-surface-pipeline';
const pipelineScenario: ChatReplayScenario = {
  id: 'surface-pipeline',
  title: 'Surface · Pipeline',
  description:
    'A CI/CD graph across two workflows with a slow install, a flaky test job and a production gate.',
  initialThreadId: pipelineThread,
  threads: [{ id: pipelineThread, title: 'Why is CI slow?' }],
  steps: [
    {
      kind: 'message',
      threadId: pipelineThread,
      message: userMessage('pipeline-user', pipelineThread, 'Why is CI slow?'),
    },
    {
      kind: 'message',
      threadId: pipelineThread,
      message: surfaceMessage(
        'pipeline-surface',
        pipelineThread,
        buildReplaySurface(
          'fixture-surface-pipeline',
          pipelineThread,
          'pipeline',
          'CI/CD · mezair-demo',
          REPLAY_PIPELINE_DATA,
          { createdAt: at(2) },
        ),
      ),
    },
    {
      kind: 'message',
      threadId: pipelineThread,
      message: answerMessage(
        'pipeline-answer',
        pipelineThread,
        'Most of the time is the uncached install and the node 22 test leg. Caching the pnpm store saves about three minutes per job.',
        3,
      ),
    },
  ],
};

// ---------------------------------------------------------------------------
// Data with a chart
// ---------------------------------------------------------------------------

export const REPLAY_DATA_DATA: DataSurfaceData = {
  columns: [
    { key: 'week', label: 'Week', type: 'date' },
    { key: 'p50', label: 'p50 (min)', type: 'number' },
    { key: 'p95', label: 'p95 (min)', type: 'number' },
    { key: 'runs', label: 'Runs', type: 'number' },
  ],
  rows: Array.from({ length: 12 }, (_, index) => ({
    week: new Date(Date.UTC(2026, 6, 6 + index * 7)).toISOString().slice(0, 10),
    p50: Math.round((11 + index * 0.6 + (index % 3) * 0.4) * 10) / 10,
    p95: Math.round((17 + index * 1.1 + (index % 4) * 0.9) * 10) / 10,
    runs: 140 + ((index * 37) % 60),
  })),
  chart: { type: 'line', x: 'week', y: ['p50', 'p95'], title: 'CI duration by week' },
  note: 'Synthetic CI history. p95 includes queued time.',
};

const dataThread = 'fixture-surface-data';
const dataScenario: ChatReplayScenario = {
  id: 'surface-data-chart',
  title: 'Surface · Data with chart',
  description: 'A twelve-week table with a two-series line chart rendered natively.',
  initialThreadId: dataThread,
  threads: [{ id: dataThread, title: 'CI duration trend' }],
  steps: [
    {
      kind: 'message',
      threadId: dataThread,
      message: userMessage('data-user', dataThread, 'Chart CI duration over the last quarter.'),
    },
    {
      kind: 'message',
      threadId: dataThread,
      message: surfaceMessage(
        'data-surface',
        dataThread,
        buildReplaySurface(
          'fixture-surface-data',
          dataThread,
          'data',
          'CI duration by week',
          REPLAY_DATA_DATA,
          { createdAt: at(2) },
        ),
      ),
    },
    {
      kind: 'message',
      threadId: dataThread,
      message: answerMessage(
        'data-answer',
        dataThread,
        'Both percentiles climb steadily; p95 grows about twice as fast as p50, which points at queueing rather than slower tests.',
        3,
      ),
    },
  ],
};

// ---------------------------------------------------------------------------
// Artifact (created, then updated: the older surface collapses as superseded)
// ---------------------------------------------------------------------------

const artifactThread = 'fixture-surface-artifact';
const RUNBOOK_ID = 'fixture-artifact-runbook';
const RUNBOOK_V1 = [
  '# Session store migration runbook',
  '',
  '1. Announce the maintenance window.',
  '2. Deploy the dual-write release.',
  '3. Backfill sessions from the old store.',
  '4. Switch reads to the new store.',
].join('\n');
const RUNBOOK_V2 = [
  '# Session store migration runbook',
  '',
  '1. Announce the maintenance window.',
  '2. Deploy the dual-write release.',
  '3. Backfill sessions from the old store.',
  '4. **Verify TTLs are in seconds** on a sample of 100 sessions.',
  '5. Switch reads to the new store.',
  '6. Keep the old store read-only for 24 hours, then delete it.',
  '',
  '## Rollback',
  '',
  'Switch reads back to the old store; dual writes keep it current.',
].join('\n');

export const REPLAY_SURFACE_ARTIFACTS: ChatArtifact[] = [
  {
    id: RUNBOOK_ID,
    threadId: artifactThread,
    repoId: REPLAY_SURFACE_REPO_ID,
    sourceMessageId: 'artifact-answer-2',
    title: 'Session store migration runbook',
    kind: 'markdown',
    storage: 'repository',
    relativePath: 'docs/runbooks/session-store-migration.md',
    content: RUNBOOK_V2,
    version: 2,
    status: 'draft',
    visibility: 'local',
    source: 'assistant',
    model: 'synthetic-fixture-model',
    createdAt: at(1),
    updatedAt: at(6),
  },
];

export const REPLAY_SURFACE_ARTIFACT_REVISIONS: ChatArtifactRevision[] = [
  {
    artifactId: RUNBOOK_ID,
    version: 1,
    title: 'Session store migration runbook',
    content: RUNBOOK_V1,
    sourceMessageId: 'artifact-answer-1',
    createdAt: at(1),
  },
  {
    artifactId: RUNBOOK_ID,
    version: 2,
    title: 'Session store migration runbook',
    content: RUNBOOK_V2,
    sourceMessageId: 'artifact-answer-2',
    createdAt: at(6),
  },
];

function artifactPayload(version: number): ArtifactSurfacePayload {
  return {
    artifactId: RUNBOOK_ID,
    version,
    operation: version > 1 ? 'updated' : 'created',
    title: 'Session store migration runbook',
    kind: 'markdown',
    storage: 'repository',
    relativePath: 'docs/runbooks/session-store-migration.md',
  };
}

export const REPLAY_ARTIFACT_SURFACES = [1, 2].map((version) =>
  buildReplaySurface(
    `fixture-surface-artifact-v${version}`,
    artifactThread,
    'artifact',
    'Session store migration runbook',
    artifactPayload(version),
    { key: `artifact:${RUNBOOK_ID}`, createdAt: at(version === 1 ? 1 : 6) },
  ),
);

const artifactScenario: ChatReplayScenario = {
  id: 'surface-artifact-revisions',
  title: 'Surface · Artifact (created, then updated)',
  description:
    'An artifact is created in one turn and updated in the next; the older surface collapses to a superseded line.',
  initialThreadId: artifactThread,
  threads: [{ id: artifactThread, title: 'Migration runbook' }],
  steps: [
    {
      kind: 'message',
      threadId: artifactThread,
      message: userMessage(
        'artifact-user-1',
        artifactThread,
        'Write the session store migration runbook.',
      ),
    },
    {
      kind: 'message',
      threadId: artifactThread,
      message: surfaceMessage('artifact-surface-v1', artifactThread, REPLAY_ARTIFACT_SURFACES[0]),
    },
    {
      kind: 'message',
      threadId: artifactThread,
      message: answerMessage(
        'artifact-answer-1',
        artifactThread,
        'Saved the runbook to docs/runbooks/session-store-migration.md.',
        2,
      ),
    },
    {
      kind: 'message',
      threadId: artifactThread,
      message: userMessage(
        'artifact-user-2',
        artifactThread,
        'Add a TTL check and a rollback section.',
        5,
      ),
    },
    {
      kind: 'message',
      threadId: artifactThread,
      message: surfaceMessage('artifact-surface-v2', artifactThread, REPLAY_ARTIFACT_SURFACES[1]),
    },
    {
      kind: 'message',
      threadId: artifactThread,
      message: answerMessage(
        'artifact-answer-2',
        artifactThread,
        'Revision 2 adds the TTL verification step and a rollback section.',
        7,
      ),
    },
  ],
};

// ---------------------------------------------------------------------------
// Sketch
// ---------------------------------------------------------------------------

const sketchThread = 'fixture-surface-sketch';
const SKETCH_ID = 'fixture-sketch-libraries';
const SKETCH_HTML = `<style>
  body { margin: 0; padding: 16px; font-family: var(--mezair-font-sans); color: var(--mezair-ink); background: var(--mezair-canvas); }
  h2 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
  p { margin: 0 0 14px; font-size: 12px; color: var(--mezair-ink-muted); }
  .row { display: grid; grid-template-columns: 120px 1fr 48px; align-items: center; gap: 10px; margin: 8px 0; font-size: 12px; }
  .label { color: var(--mezair-ink-secondary); }
  .track { height: 10px; border-radius: var(--mezair-radius-sm); background: var(--mezair-surface-raised); border: 1px solid var(--mezair-border); overflow: hidden; }
  .bar { height: 100%; }
  .value { font-family: var(--mezair-font-mono); text-align: right; }
</style>
<h2>Token libraries · weekly downloads (millions)</h2>
<p>Synthetic comparison. Bars use the theme's series tokens.</p>
<div class="row"><span class="label">jose</span><span class="track"><span class="bar" style="display:block;width:82%;background:var(--mezair-series-1)"></span></span><span class="value">41.0</span></div>
<div class="row"><span class="label">jsonwebtoken</span><span class="track"><span class="bar" style="display:block;width:64%;background:var(--mezair-series-2)"></span></span><span class="value">32.1</span></div>
<div class="row"><span class="label">paseto</span><span class="track"><span class="bar" style="display:block;width:6%;background:var(--mezair-series-3)"></span></span><span class="value">0.3</span></div>`;

export const REPLAY_SURFACE_SKETCHES: ChatSketch[] = [
  {
    id: SKETCH_ID,
    threadId: sketchThread,
    sourceMessageId: 'sketch-surface',
    title: 'Token library comparison',
    html: SKETCH_HTML,
    height: 180,
    createdAt: at(2),
    updatedAt: at(2),
  },
];

const sketchPayload: SketchSurfacePayload = {
  sketchId: SKETCH_ID,
  height: 180,
  title: 'Token library comparison',
};

const sketchScenario: ChatReplayScenario = {
  id: 'surface-sketch',
  title: 'Surface · Sketch',
  description:
    'A throwaway, self-contained HTML sketch themed with --mezair-* tokens in a sandboxed frame.',
  initialThreadId: sketchThread,
  threads: [{ id: sketchThread, title: 'Compare token libraries' }],
  steps: [
    {
      kind: 'message',
      threadId: sketchThread,
      message: userMessage('sketch-user', sketchThread, 'Compare the main JWT libraries visually.'),
    },
    {
      kind: 'message',
      threadId: sketchThread,
      message: surfaceMessage(
        'sketch-surface',
        sketchThread,
        buildReplaySurface(
          'fixture-surface-sketch',
          sketchThread,
          'sketch',
          'Token library comparison',
          sketchPayload,
          { createdAt: at(2) },
        ),
      ),
    },
    {
      kind: 'message',
      threadId: sketchThread,
      message: answerMessage(
        'sketch-answer',
        sketchThread,
        'jose has the most momentum and supports every JOSE algorithm; keep jsonwebtoken only where it is already pinned.',
        3,
      ),
    },
  ],
};

// ---------------------------------------------------------------------------
// Heavy thread: 30 surfaces for the performance budget (§13.8)
// ---------------------------------------------------------------------------

export const HEAVY_SURFACE_COUNT = 30;
const HEAVY_KINDS = [
  'review',
  'findings',
  'data',
  'pipeline',
  'dependencies',
  'artifact',
  'sketch',
] as const;

function heavySurfaceData(kind: (typeof HEAVY_KINDS)[number]): { title: string; data: unknown } {
  switch (kind) {
    case 'review':
      return {
        title: 'Review · working tree',
        data: buildReviewData(
          REVIEW_FINDINGS.map((f) => f.id),
          true,
        ),
      };
    case 'findings':
      return { title: 'Security audit', data: buildFindingsData(true) };
    case 'data':
      return { title: 'CI duration by week', data: REPLAY_DATA_DATA };
    case 'pipeline':
      return { title: 'CI/CD · mezair-demo', data: REPLAY_PIPELINE_DATA };
    case 'dependencies':
      return { title: 'Dependencies · mezair-demo', data: REPLAY_DEPENDENCIES_DATA };
    case 'artifact':
      return { title: 'Session store migration runbook', data: artifactPayload(2) };
    case 'sketch':
      return { title: 'Token library comparison', data: sketchPayload };
  }
}

function makeHeavyThread(): ChatReplayScenario {
  const threadId = 'fixture-surface-heavy';
  const messages: ChatMessage[] = [];
  const turns = HEAVY_SURFACE_COUNT / 2;
  for (let turn = 1; turn <= turns; turn += 1) {
    const minutes = turn * 10;
    messages.push(
      userMessage(
        `heavy-user-${turn}`,
        threadId,
        `Turn ${turn}: show the next two views.`,
        minutes,
      ),
    );
    for (let slot = 0; slot < 2; slot += 1) {
      const index = (turn - 1) * 2 + slot;
      const kind = HEAVY_KINDS[index % HEAVY_KINDS.length];
      const { title, data } = heavySurfaceData(kind);
      // No key: every surface stays live, so all 30 render (nothing supersedes).
      const intent = buildReplaySurface(
        `fixture-heavy-surface-${index + 1}`,
        threadId,
        kind,
        `${title} · #${index + 1}`,
        data,
        { createdAt: at(minutes + slot + 1) },
      );
      messages.push(surfaceMessage(`heavy-surface-${index + 1}`, threadId, intent));
    }
    messages.push(
      answerMessage(
        `heavy-answer-${turn}`,
        threadId,
        `Turn ${turn} published two surfaces.`,
        minutes + 3,
      ),
    );
  }
  return {
    id: 'surface-heavy-thread',
    title: 'Surface · Heavy thread (30 surfaces)',
    description:
      'Fifteen turns with two surfaces each across every kind, for the 30-surface performance budget.',
    initialThreadId: threadId,
    threads: [{ id: threadId, title: 'Heavy surface thread' }],
    steps: [{ kind: 'history', threadId, messages }],
  };
}

export const SURFACE_REPLAY_SCENARIOS: ChatReplayScenario[] = [
  reviewScenario,
  findingsScenario,
  dependenciesScenario,
  pipelineScenario,
  dataScenario,
  artifactScenario,
  sketchScenario,
  makeHeavyThread(),
];
