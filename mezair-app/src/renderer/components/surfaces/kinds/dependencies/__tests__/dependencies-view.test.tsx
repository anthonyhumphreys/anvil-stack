import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentUISurfaceIntent } from '../../../../../../shared/agent-ui-intents';
import {
  summarizeDependencies,
  type DependenciesSurfaceData,
  type DependencyPackage,
} from '../../../../../../shared/surfaces/kinds/dependencies';
import type { SurfaceViewProps } from '../../../types';
import { dependenciesSurfaceView } from '..';
import {
  DEFAULT_DEPENDENCIES_FILTER,
  filterPackages,
  fixVersions,
  packageAnchor,
  riskReasons,
  vulnerabilitySortValue,
} from '../model';

const packages: DependencyPackage[] = [
  {
    name: 'react',
    version: '18.2.0',
    manager: 'pnpm',
    direct: true,
    license: 'MIT',
    licenseStatus: 'allowed',
  },
  {
    name: 'lodash',
    version: '4.17.20',
    manager: 'pnpm',
    direct: true,
    license: 'MIT',
    licenseStatus: 'allowed',
    vulnerabilities: [
      { id: 'GHSA-1', severity: 'high', title: 'Prototype pollution', fixedIn: '4.17.21' },
    ],
  },
  {
    name: 'gpl-lib',
    version: '1.0.0',
    manager: 'pnpm',
    direct: false,
    license: 'GPL-3.0',
    licenseStatus: 'restricted',
  },
  {
    name: 'Newtonsoft.Json',
    version: '13.0.1',
    manager: 'nuget',
    direct: true,
    licenseStatus: 'unknown',
  },
];

const data: DependenciesSurfaceData = {
  repoId: 'repo-1',
  repoName: 'web-app',
  managers: ['pnpm', 'nuget'],
  packages,
  summary: summarizeDependencies(
    packages,
    {
      audits: [{ manager: 'pnpm', ranAt: '', ok: true, vulnerabilityCount: 1 }],
      licensesCheckedAt: 'x',
    },
    'now',
  ),
};

function props(payloadData: unknown = data): SurfaceViewProps {
  const intent: AgentUISurfaceIntent = {
    protocolVersion: 1,
    id: 'surface-1',
    kind: 'surface',
    revision: 1,
    scope: { threadId: 't' },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind: 'dependencies',
      title: 'Dependencies · web-app',
      streaming: false,
      digest: '',
      data: payloadData,
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

describe('dependencies model', () => {
  it('filters by risk, manager, scope and text', () => {
    const names = (filter: Partial<typeof DEFAULT_DEPENDENCIES_FILTER>) =>
      filterPackages(packages, { ...DEFAULT_DEPENDENCIES_FILTER, ...filter }).map(
        (pkg) => pkg.name,
      );
    expect(names({ risk: 'vulnerable' })).toEqual(['lodash']);
    expect(names({ risk: 'restricted' })).toEqual(['gpl-lib']);
    expect(names({ risk: 'any-risk' })).toEqual(['lodash', 'gpl-lib']);
    expect(names({ manager: 'nuget' })).toEqual(['Newtonsoft.Json']);
    expect(names({ scope: 'transitive' })).toEqual(['gpl-lib']);
    expect(names({ query: 'GHSA-1' })).toEqual(['lodash']);
  });

  it('derives fix versions, reasons, anchors and vulnerability sort keys', () => {
    expect(fixVersions(packages[1])).toBe('4.17.21');
    expect(riskReasons(packages[2])).toEqual(['Restricted licence GPL-3.0']);
    expect(packageAnchor(packages[1])).toEqual({
      type: 'row',
      targetId: 'pnpm:lodash',
      label: 'lodash@4.17.20 (pnpm)',
    });
    expect(vulnerabilitySortValue(packages[0])).toBeNull();
    expect(vulnerabilitySortValue(packages[1])).toBeLessThan(2000);
  });
});

describe('dependencies views', () => {
  it('inline shows facts, manager counts and top risks', () => {
    const markup = renderToStaticMarkup(<dependenciesSurfaceView.Inline {...props()} />);
    expect(markup).toContain('4 packages');
    expect(markup).toContain('aria-label="Packages by manager"');
    expect(markup).toContain('aria-label="Top risks"');
    expect(markup).toContain('lodash');
    expect(markup).toContain('GPL-3.0');
    expect(markup).not.toContain('>react<');
    expect(markup).toContain('Ask agent to upgrade 1 vulnerable');
  });

  it('stage renders the grouped, sortable table with filters and detail', () => {
    const Stage = dependenciesSurfaceView.Stage!;
    const markup = renderToStaticMarkup(<Stage {...props()} presentation="stage" />);
    expect(markup).toContain('aria-label="Risk"');
    expect(markup).toContain('aria-label="Manager"');
    expect(markup).toContain('Group by manager');
    expect(markup).toContain('scope="rowgroup"');
    expect(markup).toContain('aria-sort="ascending"');
    // Grouped by manager (nuget, then pnpm), riskiest first within each group.
    expect(markup).toContain('aria-label="Package Newtonsoft.Json"');
    expect(markup.indexOf('data-row-id="pnpm:lodash"')).toBeLessThan(
      markup.indexOf('data-row-id="pnpm:react"'),
    );
  });

  it('tolerates malformed data', () => {
    expect(() =>
      renderToStaticMarkup(<dependenciesSurfaceView.Inline {...props(undefined)} />),
    ).not.toThrow();
  });
});
