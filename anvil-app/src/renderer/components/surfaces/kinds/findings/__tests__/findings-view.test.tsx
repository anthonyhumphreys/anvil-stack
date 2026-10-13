import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentUISurfaceIntent } from '../../../../../../shared/agent-ui-intents';
import type { FindingsSurfaceData } from '../../../../../../shared/surfaces/kinds/findings';
import type { SurfaceViewProps } from '../../../types';
import { findingsSurfaceView } from '..';
import {
  DEFAULT_FINDINGS_FILTER,
  actionableIds,
  filterFindings,
  findingAnchor,
  findingCategories,
  topActiveFindings,
} from '../model';

const data: FindingsSurfaceData = {
  source: 'security-audit',
  repoId: 'repo-1',
  title: 'Security audit',
  summary: 'Two issues need attention.',
  findings: [
    {
      id: 'a',
      severity: 'low',
      title: 'Verbose errors',
      detail: 'Stack traces leak',
      status: 'open',
      category: 'Logging',
    },
    {
      id: 'b',
      severity: 'critical',
      title: 'SQL injection',
      detail: 'Query concatenation',
      status: 'open',
      category: 'Injection',
      filePath: 'src/db.ts',
      lineStart: 12,
      lineEnd: 18,
    },
    {
      id: 'c',
      severity: 'high',
      title: 'Old dismissed',
      detail: '',
      status: 'dismissed',
      category: 'Injection',
    },
    { id: 'd', severity: 'medium', title: 'Being fixed', detail: '', status: 'fix-requested' },
  ],
};

function props(
  overrides: Partial<AgentUISurfaceIntent['payload']> = {},
  payloadData: unknown = data,
): SurfaceViewProps {
  const intent: AgentUISurfaceIntent = {
    protocolVersion: 1,
    id: 'surface-1',
    kind: 'surface',
    revision: 1,
    scope: { threadId: 't' },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind: 'findings',
      title: 'Security audit · web',
      streaming: false,
      digest: '',
      data: payloadData,
      ...overrides,
    },
    createdAt: '',
    updatedAt: '',
  };
  return {
    intent,
    presentation: 'inline',
    onAction: async () => ({ ok: true }),
    onComment: () => undefined,
    onOpenStage: () => undefined,
  };
}

describe('findings model', () => {
  it('filters by status, severity, category and text', () => {
    expect(
      filterFindings(data.findings, DEFAULT_FINDINGS_FILTER).map((finding) => finding.id),
    ).toEqual(['b', 'd', 'a']);
    expect(
      filterFindings(data.findings, { ...DEFAULT_FINDINGS_FILTER, status: 'all' }).map((f) => f.id),
    ).toEqual(['b', 'd', 'a', 'c']);
    expect(
      filterFindings(data.findings, {
        ...DEFAULT_FINDINGS_FILTER,
        severities: new Set(['low']),
      }).map((f) => f.id),
    ).toEqual(['a']);
    expect(
      filterFindings(data.findings, {
        ...DEFAULT_FINDINGS_FILTER,
        status: 'all',
        category: 'Injection',
      }).map((f) => f.id),
    ).toEqual(['b', 'c']);
    expect(
      filterFindings(data.findings, { ...DEFAULT_FINDINGS_FILTER, query: 'db.ts' }).map(
        (f) => f.id,
      ),
    ).toEqual(['b']);
  });

  it('derives categories, top findings, actionable ids and anchors', () => {
    expect(findingCategories(data.findings)).toEqual(['Injection', 'Logging']);
    expect(topActiveFindings(data.findings, 2).map((finding) => finding.id)).toEqual(['b', 'd']);
    expect(actionableIds(data.findings, new Set(['a', 'c']))).toEqual(['a']);
    expect(findingAnchor(data.findings[1])).toEqual({
      type: 'finding',
      targetId: 'b',
      filePath: 'src/db.ts',
      lineStart: 12,
      lineEnd: 18,
      label: 'SQL injection · src/db.ts:12-18',
    });
  });
});

describe('findings views', () => {
  it('inline shows the severity summary and top active findings only', () => {
    const markup = renderToStaticMarkup(<findingsSurfaceView.Inline {...props()} />);
    expect(markup).toContain('Active findings by severity');
    expect(markup).toContain('SQL injection');
    expect(markup).toContain('src/db.ts:12-18');
    expect(markup).not.toContain('Old dismissed');
    expect(markup).toContain('aria-label="Ask agent to fix"');
    expect(markup).toContain('Open all 4 findings');
  });

  it('inline shows audit progress while an audit streams', () => {
    const markup = renderToStaticMarkup(
      <findingsSurfaceView.Inline
        {...props(
          { streaming: true },
          {
            ...data,
            findings: [],
            auditStatus: 'running',
            progress: { message: 'Analyzing module: api', percent: 42 },
          },
        )}
      />,
    );
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toContain('Analyzing module: api');
  });

  it('stage renders the filterable table and the detail pane', () => {
    const Stage = findingsSurfaceView.Stage!;
    const markup = renderToStaticMarkup(<Stage {...props()} presentation="stage" />);
    expect(markup).toContain('aria-label="Filter findings"');
    expect(markup).toContain('aria-label="Status"');
    expect(markup).toContain('aria-label="Category"');
    expect(markup).toContain('<caption class="sr-only">Security audit · web: 3 findings</caption>');
    expect(markup).toContain('aria-label="Finding: SQL injection"');
    expect(markup).toContain('Query concatenation');
  });

  it('tolerates malformed data', () => {
    expect(() =>
      renderToStaticMarkup(<findingsSurfaceView.Inline {...props({}, null)} />),
    ).not.toThrow();
  });
});
