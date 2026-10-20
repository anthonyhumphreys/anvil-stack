import { ArrowUpCircle, MessageSquarePlus } from 'lucide-react';
import { topRiskPackages } from '../../../../../shared/surfaces/kinds/dependencies';
import { Button, IconButton } from '../../../ui';
import type { SurfaceViewProps } from '../../types';
import { ActionStatusLine, SurfaceSkeleton } from '../../shared-ui/useSurfaceActions';
import {
  AuditState,
  FactList,
  LicenseLabel,
  ManagerCounts,
  VulnerabilityCell,
  useDependencyActions,
} from './DependencyParts';
import { packageKey, readDependenciesData, riskReasons } from './model';

const INLINE_TOP = 5;

export function DependenciesInline(props: SurfaceViewProps) {
  const { intent, onOpenStage } = props;
  const data = readDependenciesData(intent.payload.data);
  const { handlers, status, confirmDialog } = useDependencyActions(props, data.packages);
  const risks = topRiskPackages(data.packages, INLINE_TOP);
  const vulnerableKeys = data.packages
    .filter((pkg) => (pkg.vulnerabilities?.length ?? 0) > 0)
    .map(packageKey);

  if (intent.payload.streaming && data.packages.length === 0) {
    return <SurfaceSkeleton label="Loading dependencies" />;
  }

  return (
    <section aria-label={intent.payload.title} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <FactList data={data} />
        <ManagerCounts data={data} />
        <AuditState data={data} />
      </div>
      {risks.length > 0 ? (
        <ul aria-label="Top risks" className="flex flex-col">
          {risks.map((pkg) => (
            <li
              key={packageKey(pkg)}
              className="group flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-subtle py-2 last:border-b-0"
            >
              <button
                type="button"
                onClick={() => onOpenStage(packageKey(pkg))}
                className="min-w-0 rounded-sm text-left font-mono text-sm text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                {pkg.name}
                <span className="text-text-tertiary">@{pkg.version}</span>
              </button>
              <span className="text-xs text-text-tertiary">{pkg.manager}</span>
              <VulnerabilityCell pkg={pkg} />
              {pkg.licenseStatus === 'restricted' && <LicenseLabel pkg={pkg} />}
              {pkg.deprecated && <span className="text-xs text-text-tertiary">Deprecated</span>}
              <span className="sr-only">{riskReasons(pkg).join(', ')}</span>
              <div className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none">
                <IconButton
                  icon={ArrowUpCircle}
                  label={`Ask agent to upgrade ${pkg.name}`}
                  disabled={handlers.pending !== null}
                  onClick={() => handlers.askUpgrade([packageKey(pkg)])}
                />
                <IconButton
                  icon={MessageSquarePlus}
                  label={`Comment on ${pkg.name}`}
                  onClick={() => handlers.comment(pkg)}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-text-tertiary">
          {data.packages.length === 0
            ? 'No dependencies found.'
            : data.summary.audits.length === 0
              ? 'No risks known yet. Run an audit to check for advisories.'
              : 'No vulnerable or restricted packages found.'}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {vulnerableKeys.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            disabled={handlers.pending !== null}
            onClick={() => handlers.askUpgrade(vulnerableKeys)}
          >
            Ask agent to upgrade {vulnerableKeys.length} vulnerable
          </Button>
        )}
        {data.packages.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onOpenStage()}>
            Open all {data.packages.length} packages
          </Button>
        )}
      </div>
      <ActionStatusLine status={status} />
      {confirmDialog}
    </section>
  );
}
