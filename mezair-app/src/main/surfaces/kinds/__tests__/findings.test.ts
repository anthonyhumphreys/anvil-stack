import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecurityAudit, SecurityFinding } from '../../../../shared/types.js';
import {
  digestFindings,
  findingsSurfaceKind,
  type FindingsSurfaceData,
} from '../../../../shared/surfaces/kinds/findings.js';
import { validateJsonSchema } from '../../validate.js';
import { fakeCoreState, getSurface, resetFakeCore, testContext, textOf } from './data-fake-core.js';

const mocks = vi.hoisted(() => ({
  audits: [] as SecurityAudit[],
  findings: new Map<string, SecurityFinding[]>(),
  running: null as SecurityAudit | null,
  dismissed: [] as string[],
  linked: [] as Array<[string, string]>,
  provider: null as null | { createItem: (input: { title: string }) => Promise<{ id: string }> },
  repoSummary: { overview: 'App', patterns: '[]', frameworks: '[]' } as
    Record<string, string> | undefined,
  runAudit: vi.fn(),
}));

vi.mock('../../core.js', async () => await import('./data-fake-core.js'));
vi.mock('../../../db/database.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (id: string) => {
        if (sql.includes('FROM repos')) {
          return id === 'repo-1' ? { id, name: 'web-app', path: '/work/web-app' } : undefined;
        }
        if (sql.includes('repo_summaries')) return mocks.repoSummary;
        return undefined;
      },
      all: () => [],
    }),
  }),
}));
vi.mock('../../../services/security-persistence.service.js', () => ({
  listAudits: (repoId: string) => mocks.audits.filter((audit) => audit.repoId === repoId),
  getAudit: (id: string) => mocks.audits.find((audit) => audit.id === id) ?? null,
  getFindings: (auditId: string) => mocks.findings.get(auditId) ?? [],
  getRunningAudit: () => mocks.running,
  dismissFinding: (id: string) => mocks.dismissed.push(id),
  linkFindingToWorkItem: (findingId: string, workItemId: string) =>
    mocks.linked.push([findingId, workItemId]),
}));
vi.mock('../../../services/security-audit.service.js', () => ({
  createPendingSecurityAudit: (repoId: string) => {
    const audit: SecurityAudit = {
      id: 'audit-new',
      repoId,
      scope: ['OWASP Top 10 2021'],
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
    };
    mocks.audits.push(audit);
    return audit.id;
  },
  runSecurityAudit: mocks.runAudit,
}));
vi.mock('../../../services/workitem-provider.js', () => ({
  getActiveProvider: () => mocks.provider,
}));

const { findingsSurfaceHandler, normalizeFindingInputs } = await import('../findings.js');
const { findingsSnapshot, redactFindings } = await import('../findings/snapshot.js');
const { mapSecurityFinding, parseFileReference } = await import('../findings/map.js');

const provider = findingsSurfaceHandler.toolProvider!;

function securityFinding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: 'sf-1',
    auditId: 'audit-1',
    severity: 'high',
    category: 'Injection',
    owaspRef: 'A03:2021',
    affectedFiles: ['src/db.ts:12-18', 'src/other.ts'],
    description: 'SQL built from user input\nThe query concatenates request params.',
    remediation: 'Use parameterised queries.',
    dismissed: false,
    ...overrides,
  };
}

beforeEach(() => {
  resetFakeCore();
  mocks.audits = [
    {
      id: 'audit-1',
      repoId: 'repo-1',
      scope: ['OWASP Top 10 2021'],
      status: 'completed',
      summary: 'Found 2 findings.',
      startedAt: '2026-01-01T00:00:00Z',
    },
  ];
  mocks.findings = new Map([
    [
      'audit-1',
      [
        securityFinding(),
        securityFinding({
          id: 'sf-2',
          severity: 'low',
          description: 'Verbose errors',
          affectedFiles: [],
        }),
      ],
    ],
  ]);
  mocks.running = null;
  mocks.dismissed = [];
  mocks.linked = [];
  mocks.provider = null;
  mocks.repoSummary = { overview: 'App', patterns: '[]', frameworks: '[]' };
  mocks.runAudit.mockReset();
});

describe('findings kind definition', () => {
  const valid: FindingsSurfaceData = {
    source: 'custom',
    title: 'Review notes',
    findings: [
      {
        id: 'a',
        severity: 'critical',
        title: 'Secret in repo',
        detail: 'x',
        status: 'open',
        filePath: 'a.ts',
        lineStart: 3,
      },
      { id: 'b', severity: 'low', title: 'Typo', detail: '', status: 'dismissed' },
    ],
  };

  it('accepts a valid payload and rejects malformed ones', () => {
    expect(validateJsonSchema(findingsSurfaceKind.schema, valid)).toEqual([]);
    expect(
      validateJsonSchema(findingsSurfaceKind.schema, {
        ...valid,
        findings: [{ id: 'a', severity: 'urgent', title: 't', detail: '', status: 'open' }],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateJsonSchema(findingsSurfaceKind.schema, { ...valid, extra: 1 }).length,
    ).toBeGreaterThan(0);
  });

  it('digests active counts and top findings with anchors', () => {
    const digest = digestFindings(valid);
    expect(digest).toContain('active 1 (1 critical)');
    expect(digest).toContain('1 dismissed');
    expect(digest).toContain('a: Secret in repo @ a.ts:3');
    expect(digest).not.toContain('Typo');
  });
});

describe('security mapping', () => {
  it('parses file references and maps persisted findings', () => {
    expect(parseFileReference('src/a.ts:4-9')).toEqual({
      filePath: 'src/a.ts',
      lineStart: 4,
      lineEnd: 9,
    });
    expect(parseFileReference('src/a.ts')).toEqual({ filePath: 'src/a.ts' });
    const mapped = mapSecurityFinding(securityFinding({ dismissed: true, workItemId: 'WI-1' }));
    expect(mapped).toMatchObject({
      id: 'sf-1',
      title: 'SQL built from user input',
      filePath: 'src/db.ts',
      lineStart: 12,
      lineEnd: 18,
      status: 'dismissed',
      workItemId: 'WI-1',
      refs: ['A03:2021'],
      recommendation: 'Use parameterised queries.',
    });
    expect(mapped.detail).toContain('Also affects: src/other.ts');
  });
});

describe('security_findings', () => {
  it('rejects repos outside the session scope', async () => {
    await expect(
      provider.call(testContext(), 'security_findings', { repoId: 'repo-x' }),
    ).rejects.toThrow(/outside/);
  });

  it('publishes the latest completed audit and returns a digest, not the payload', async () => {
    const result = await provider.call(testContext(), 'security_findings', { repoId: 'repo-1' });
    expect(result?.isError).toBeFalsy();
    const surfaceId = result?.structuredContent?.surfaceId as string;
    const intent = getSurface(surfaceId)!;
    expect(intent.payload.key).toBe('findings:security:repo-1');
    const data = intent.payload.data as FindingsSurfaceData;
    expect(data.source).toBe('security-audit');
    expect(data.findings).toHaveLength(2);
    expect(textOf(result)).toContain('surfaceId');
    expect(textOf(result)).not.toContain('concatenates request params');
  });

  it('reports honestly when no audit exists', async () => {
    mocks.audits = [];
    const result = await provider.call(testContext(), 'security_findings', { repoId: 'repo-1' });
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('security_audit_run');
  });

  it('rejects an audit id from another repo', async () => {
    mocks.audits.push({
      id: 'audit-z',
      repoId: 'repo-2',
      scope: [],
      status: 'completed',
      startedAt: '',
    });
    await expect(
      provider.call(testContext(), 'security_findings', { repoId: 'repo-1', auditId: 'audit-z' }),
    ).rejects.toThrow(/not found/);
  });
});

describe('security_audit_run', () => {
  it('publishes a streaming surface and patches it as the audit progresses and completes', async () => {
    let finish: () => void = () => undefined;
    mocks.runAudit.mockImplementation(
      (
        _auditId: string,
        _repoId: string,
        _summary: unknown,
        _languages: unknown,
        progress: (m: string, p: number) => void,
      ) =>
        new Promise<string>((resolve) => {
          progress('Analyzing module: src...', 40);
          finish = () => {
            mocks.findings.set('audit-new', [
              securityFinding({ id: 'new-1', auditId: 'audit-new' }),
            ]);
            mocks.audits.find((audit) => audit.id === 'audit-new')!.status = 'completed';
            resolve('audit-new');
          };
        }),
    );
    const result = await provider.call(testContext(), 'security_audit_run', { repoId: 'repo-1' });
    const surfaceId = result?.structuredContent?.surfaceId as string;
    let intent = getSurface(surfaceId)!;
    expect(intent.payload.streaming).toBe(true);
    expect((intent.payload.data as FindingsSurfaceData).progress?.percent).toBe(40);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    intent = getSurface(surfaceId)!;
    expect(intent.payload.streaming).toBe(false);
    const data = intent.payload.data as FindingsSurfaceData;
    expect(data.auditStatus).toBe('completed');
    expect(data.findings.map((finding) => finding.id)).toEqual(['new-1']);
  });

  it('marks the surface failed when the audit throws', async () => {
    mocks.runAudit.mockRejectedValue(new Error('LLM unavailable'));
    const result = await provider.call(testContext(), 'security_audit_run', { repoId: 'repo-1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const data = getSurface(result?.structuredContent?.surfaceId as string)!.payload
      .data as FindingsSurfaceData;
    expect(data.auditStatus).toBe('failed');
    expect(data.summary).toContain('LLM unavailable');
  });

  it('returns an honest error when the repo is not indexed or an audit is running', async () => {
    mocks.repoSummary = undefined;
    let result = await provider.call(testContext(), 'security_audit_run', { repoId: 'repo-1' });
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain('indexed');
    mocks.running = mocks.audits[0];
    result = await provider.call(testContext(), 'security_audit_run', { repoId: 'repo-1' });
    expect(textOf(result)).toContain('already running');
  });
});

describe('findings_publish / findings_patch', () => {
  it('assigns ids and default status, validates, and patches with revision checks', async () => {
    const result = await provider.call(testContext(), 'findings_publish', {
      title: 'Agent findings',
      findings: [
        {
          severity: 'medium',
          title: 'Missing timeout',
          detail: 'fetch has no timeout',
          filePath: 'a.ts',
          lineStart: 2,
        },
      ],
      streaming: true,
    });
    const surfaceId = result?.structuredContent?.surfaceId as string;
    expect((getSurface(surfaceId)!.payload.data as FindingsSurfaceData).findings[0]).toMatchObject({
      id: 'f1',
      status: 'open',
    });
    await expect(
      provider.call(testContext(), 'findings_patch', { surfaceId, baseRevision: 5, add: [] }),
    ).rejects.toThrow(/Stale/);
    await provider.call(testContext(), 'findings_patch', {
      surfaceId,
      baseRevision: 1,
      add: [{ severity: 'high', title: 'Second', detail: '' }],
      statuses: [{ id: 'f1', status: 'fixed' }],
      complete: true,
    });
    const intent = getSurface(surfaceId)!;
    const data = intent.payload.data as FindingsSurfaceData;
    expect(intent.payload.streaming).toBe(false);
    expect(data.findings.map((finding) => [finding.id, finding.status])).toEqual([
      ['f1', 'fixed'],
      ['f2', 'open'],
    ]);
  });

  it('rejects invalid severities and out-of-scope repos', async () => {
    await expect(
      provider.call(testContext(), 'findings_publish', {
        title: 'x',
        findings: [{ severity: 'urgent', title: 't', detail: '' }],
      }),
    ).rejects.toThrow(/Invalid arguments/);
    await expect(
      provider.call(testContext(), 'findings_publish', {
        title: 'x',
        repoId: 'nope',
        findings: [],
      }),
    ).rejects.toThrow(/outside/);
  });

  it('dedupes clashing ids', () => {
    const normalized = normalizeFindingInputs(
      [
        { id: 'a', severity: 'low', title: 't', detail: '' },
        { id: 'a', severity: 'low', title: 't2', detail: '' },
      ],
      [],
    );
    expect(new Set(normalized.map((finding) => finding.id)).size).toBe(2);
  });
});

describe('findings actions', () => {
  async function publishSecurity() {
    const result = await provider.call(testContext(), 'security_findings', { repoId: 'repo-1' });
    return getSurface(result?.structuredContent?.surfaceId as string)!;
  }

  it('dismiss persists security dismissals and patches status', async () => {
    const intent = await publishSecurity();
    const result = await findingsSurfaceHandler.executeAction!(
      { intent },
      { surfaceId: intent.id, action: 'dismiss', targetIds: ['sf-1', 'unknown'] },
    );
    expect(result.ok).toBe(true);
    expect(mocks.dismissed).toEqual(['sf-1']);
    const data = getSurface(intent.id)!.payload.data as FindingsSurfaceData;
    expect(data.findings.find((finding) => finding.id === 'sf-1')?.status).toBe('dismissed');
  });

  it('ask_fix delivers structured feedback and marks fix-requested', async () => {
    const intent = await publishSecurity();
    const result = await findingsSurfaceHandler.executeAction!(
      { intent },
      { surfaceId: intent.id, action: 'ask_fix', targetIds: ['sf-1'], note: 'keep the API' },
    );
    expect(result.ok).toBe(true);
    expect(fakeCoreState.delivered[0].message).toContain(
      'sf-1: SQL built from user input @ src/db.ts:12-18',
    );
    expect(fakeCoreState.delivered[0].message).toContain('User note: keep the API');
    const data = getSurface(intent.id)!.payload.data as FindingsSurfaceData;
    expect(data.findings.find((finding) => finding.id === 'sf-1')?.status).toBe('fix-requested');
  });

  it('ask_fix reports when no session is live', async () => {
    const intent = await publishSecurity();
    fakeCoreState.deliverResult = false;
    const result = await findingsSurfaceHandler.executeAction!(
      { intent },
      { surfaceId: intent.id, action: 'ask_fix', targetIds: ['sf-1'] },
    );
    expect(result.ok).toBe(false);
  });

  it('create_work_items needs a provider, then links persisted findings', async () => {
    const intent = await publishSecurity();
    let result = await findingsSurfaceHandler.executeAction!(
      { intent },
      { surfaceId: intent.id, action: 'create_work_items', targetIds: ['sf-1'] },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No work item connection');

    const createItem = vi.fn(async () => ({ id: 'ADO-42' }));
    mocks.provider = { createItem };
    result = await findingsSurfaceHandler.executeAction!(
      { intent: getSurface(intent.id)! },
      { surfaceId: intent.id, action: 'create_work_items', targetIds: ['sf-1'] },
    );
    expect(result.ok).toBe(true);
    expect(createItem).toHaveBeenCalledWith(
      expect.objectContaining({ title: '[HIGH] SQL built from user input' }),
    );
    expect(mocks.linked).toEqual([['sf-1', 'ADO-42']]);
    const data = getSurface(intent.id)!.payload.data as FindingsSurfaceData;
    expect(data.findings.find((finding) => finding.id === 'sf-1')?.workItemId).toBe('ADO-42');
  });

  it('rejects unknown actions and empty selections', async () => {
    const intent = await publishSecurity();
    expect(
      (
        await findingsSurfaceHandler.executeAction!(
          { intent },
          { surfaceId: intent.id, action: 'nuke', targetIds: ['sf-1'] },
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await findingsSurfaceHandler.executeAction!(
          { intent },
          { surfaceId: intent.id, action: 'dismiss' },
        )
      ).ok,
    ).toBe(false);
  });
});

describe('findings share', () => {
  const data: FindingsSurfaceData = {
    source: 'security-audit',
    repoId: 'repo-1',
    title: 'Audit',
    summary: '<script>alert(1)</script>',
    findings: [
      {
        id: 'a',
        severity: 'high',
        title: '<img src=x onerror=alert(1)>',
        detail: 'javascript:alert(1)',
        status: 'open',
        filePath: '/work/web-app/src/a.ts',
        lineStart: 3,
      },
    ],
  };

  it('redacts absolute paths to repo-relative', () => {
    const redacted = findingsSurfaceHandler.share!.redact(data) as FindingsSurfaceData;
    expect(redacted.findings[0].filePath).toBe('src/a.ts');
    expect(redactFindings(data).findings[0].filePath).toBe('a.ts');
  });

  it('produces a script-free snapshot with escaped content and light/dark tokens', () => {
    const snapshot = findingsSnapshot(redactFindings(data, '/work/web-app'), 'Audit');
    expect(snapshot.html).not.toMatch(/<script|<img/i);
    expect(snapshot.html).toContain('&lt;script&gt;');
    expect(snapshot.html).toContain('<details>');
    expect(snapshot.html).toContain('src/a.ts:3');
    expect(snapshot.css).toContain('prefers-color-scheme: dark');
  });
});
