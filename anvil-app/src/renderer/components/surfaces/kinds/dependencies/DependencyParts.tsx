import { useMemo } from 'react';
import { AlertTriangle, CircleHelp } from 'lucide-react';
import {
  DEPENDENCY_MANAGERS,
  type DependenciesSurfaceData,
  type DependencyPackage,
} from '../../../../../shared/surfaces/kinds/dependencies';
import { Button, cx } from '../../../ui';
import type { SurfaceViewProps } from '../../types';
import { SeverityBadge } from '../../shared-ui/SeverityGlyph';
import { useSurfaceActions } from '../../shared-ui/useSurfaceActions';
import { isActionAvailable } from '../../surface-utils';
import { fixVersions, packageAnchor, packageKey, worstSeverity } from './model';

export function LicenseLabel({ pkg }: { pkg: DependencyPackage }) {
  if (pkg.licenseStatus === 'restricted') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-warning">
        <AlertTriangle size={12} aria-hidden="true" />
        {pkg.license}
        <span className="sr-only">(restricted licence)</span>
      </span>
    );
  }
  if (!pkg.license || pkg.licenseStatus === 'unknown') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-text-tertiary">
        <CircleHelp size={12} aria-hidden="true" />
        {pkg.license ?? 'Unknown'}
      </span>
    );
  }
  return <span className="text-xs text-text-secondary">{pkg.license}</span>;
}

export function VulnerabilityCell({ pkg }: { pkg: DependencyPackage }) {
  const worst = worstSeverity(pkg);
  const count = pkg.vulnerabilities?.length ?? 0;
  if (!worst) return <span className="text-xs text-text-muted">—</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <SeverityBadge severity={worst} />
      <span className="text-xs text-text-tertiary">
        {count} advisor{count === 1 ? 'y' : 'ies'}
      </span>
    </span>
  );
}

export function ManagerCounts({ data }: { data: DependenciesSurfaceData }) {
  const entries = DEPENDENCY_MANAGERS.filter((manager) => data.summary.byManager[manager]);
  if (entries.length === 0) return null;
  return (
    <ul
      aria-label="Packages by manager"
      className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary"
    >
      {entries.map((manager) => (
        <li key={manager}>
          <span className="font-mono">{manager}</span>{' '}
          <span className="tabular-nums text-text-primary">{data.summary.byManager[manager]}</span>
        </li>
      ))}
    </ul>
  );
}

export function AuditState({ data }: { data: DependenciesSurfaceData }) {
  const { audits, licensesCheckedAt } = data.summary;
  return (
    <p className="text-xs text-text-tertiary">
      {audits.length === 0
        ? 'Not audited yet.'
        : audits
            .map((audit) =>
              audit.ok
                ? `${audit.manager} audit: ${audit.vulnerabilityCount} advisories${audit.note ? ` (${audit.note})` : ''}`
                : `${audit.manager} audit failed${audit.error ? `: ${audit.error.slice(0, 120)}` : ''}`,
            )
            .join(' · ')}
      {' · '}
      {licensesCheckedAt ? 'Licences checked.' : 'Licences not checked.'}
    </p>
  );
}

export function useDependencyActions(
  props: SurfaceViewProps,
  packages: readonly DependencyPackage[],
) {
  const actions = useSurfaceActions(props.onAction);
  const { run, confirm, pending } = actions;
  const { onComment, readOnly } = props;
  const canCreateWorkItems = isActionAvailable('dependencies', 'create_work_items', readOnly);
  const handlers = useMemo(
    () => ({
      pending,
      askUpgrade: (keys: string[]) => void run('ask_upgrade', keys),
      createWorkItems: (keys: string[]) => {
        const eligible = packages.filter(
          (pkg) => keys.includes(packageKey(pkg)) && !pkg.workItemId,
        );
        if (!canCreateWorkItems || eligible.length === 0) return;
        confirm({
          action: 'create_work_items',
          targetIds: eligible.map(packageKey),
          title: `Create ${eligible.length} work item${eligible.length === 1 ? '' : 's'}?`,
          description: 'Anvil will create upgrade items in your connected work item tracker.',
          confirmLabel: 'Create work items',
        });
      },
      /** False in read-only threads: work item creation is a mutation. */
      canCreateWorkItems,
      comment: (pkg: DependencyPackage) => onComment(packageAnchor(pkg)),
    }),
    [pending, run, confirm, packages, onComment, canCreateWorkItems],
  );
  return { ...actions, handlers };
}

export type DependencyHandlers = ReturnType<typeof useDependencyActions>['handlers'];

export function PackageDetail({
  pkg,
  handlers,
}: {
  pkg: DependencyPackage;
  handlers: DependencyHandlers;
}) {
  const fixes = fixVersions(pkg);
  return (
    <article aria-label={`Package ${pkg.name}`} className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h3 className="break-all font-mono text-sm font-semibold text-text-primary">
          {pkg.name}
          <span className="font-normal text-text-secondary">@{pkg.version}</span>
        </h3>
        <p className="text-xs text-text-tertiary">
          {pkg.manager} · {pkg.direct ? 'Direct' : 'Transitive'}
          {pkg.workItemId ? ` · Work item ${pkg.workItemId}` : ''}
        </p>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-text-tertiary">Licence</dt>
        <dd>
          <LicenseLabel pkg={pkg} />
        </dd>
        {fixes && (
          <>
            <dt className="text-text-tertiary">Fixed in</dt>
            <dd className="font-mono text-text-secondary">{fixes}</dd>
          </>
        )}
        {pkg.deprecated && (
          <>
            <dt className="text-text-tertiary">Deprecated</dt>
            <dd className="text-text-secondary">
              {pkg.alternative ? `Consider ${pkg.alternative}` : 'Yes'}
            </dd>
          </>
        )}
      </dl>
      {(pkg.vulnerabilities?.length ?? 0) > 0 && (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-text-tertiary">Advisories</h4>
          <ul className="flex flex-col">
            {pkg.vulnerabilities!.map((vulnerability) => (
              <li
                key={vulnerability.id}
                className="flex flex-col gap-0.5 border-b border-border-subtle py-1.5 last:border-b-0"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={vulnerability.severity} />
                  <code className="break-all font-mono text-xs text-text-secondary">
                    {vulnerability.id}
                  </code>
                </span>
                <span className="text-sm text-text-primary">{vulnerability.title}</span>
                {vulnerability.url && (
                  <span className="break-all font-mono text-xs text-text-tertiary">
                    {vulnerability.url}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={handlers.pending !== null}
          onClick={() => handlers.askUpgrade([packageKey(pkg)])}
        >
          Ask agent to upgrade
        </Button>
        {handlers.canCreateWorkItems && (
          <Button
            size="sm"
            variant="secondary"
            disabled={Boolean(pkg.workItemId) || handlers.pending !== null}
            onClick={() => handlers.createWorkItems([packageKey(pkg)])}
          >
            Create work item
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => handlers.comment(pkg)}>
          Comment
        </Button>
      </div>
    </article>
  );
}

export function FactList({
  data,
  className,
}: {
  data: DependenciesSurfaceData;
  className?: string;
}) {
  const { summary } = data;
  const facts = [
    `${summary.total} packages`,
    `${summary.direct} direct`,
    `${summary.vulnerablePackages} vulnerable`,
    summary.licensesCheckedAt
      ? `${summary.restrictedLicenses ?? 0} restricted licences`
      : undefined,
    summary.deprecated ? `${summary.deprecated} deprecated` : undefined,
  ].filter(Boolean);
  return <p className={cx('text-sm text-text-secondary', className)}>{facts.join(' · ')}</p>;
}
