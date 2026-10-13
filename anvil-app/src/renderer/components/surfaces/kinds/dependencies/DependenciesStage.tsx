import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  DEPENDENCY_MANAGERS,
  type DependencyManager,
  type DependencyPackage,
} from '../../../../../shared/surfaces/kinds/dependencies';
import { Button } from '../../../ui';
import type { SurfaceViewProps } from '../../types';
import { DataTable, type DataTableColumn } from '../../shared-ui/DataTable';
import { orderRows, toggleInSet, type SortState } from '../../shared-ui/table-model';
import {
  ActionStatusLine,
  FilterInput,
  FilterSelect,
  SurfaceSkeleton,
} from '../../shared-ui/useSurfaceActions';
import {
  AuditState,
  FactList,
  LicenseLabel,
  ManagerCounts,
  PackageDetail,
  VulnerabilityCell,
  useDependencyActions,
} from './DependencyParts';
import {
  DEFAULT_DEPENDENCIES_FILTER,
  filterPackages,
  fixVersions,
  packageKey,
  readDependenciesData,
  vulnerabilitySortValue,
  type DependenciesFilter,
  type DependencyRiskFilter,
  type DependencyScopeFilter,
} from './model';

const COLUMNS: DataTableColumn<DependencyPackage>[] = [
  {
    key: 'name',
    header: 'Package',
    render: (pkg) => <span className="break-all font-mono text-text-primary">{pkg.name}</span>,
    sortValue: (pkg) => pkg.name,
  },
  {
    key: 'version',
    header: 'Version',
    render: (pkg) => <span className="font-mono text-text-secondary">{pkg.version}</span>,
    sortValue: (pkg) => pkg.version,
  },
  {
    key: 'manager',
    header: 'Manager',
    render: (pkg) => <span className="text-text-secondary">{pkg.manager}</span>,
    sortValue: (pkg) => pkg.manager,
  },
  {
    key: 'scope',
    header: 'Scope',
    render: (pkg) => (
      <span className="text-text-tertiary">{pkg.direct ? 'Direct' : 'Transitive'}</span>
    ),
    sortValue: (pkg) => (pkg.direct ? 0 : 1),
  },
  {
    key: 'license',
    header: 'Licence',
    render: (pkg) => <LicenseLabel pkg={pkg} />,
    sortValue: (pkg) => pkg.license,
  },
  {
    key: 'vulnerabilities',
    header: 'Vulnerabilities',
    render: (pkg) => <VulnerabilityCell pkg={pkg} />,
    sortValue: vulnerabilitySortValue,
  },
  {
    key: 'fix',
    header: 'Fixed in',
    render: (pkg) => <span className="font-mono text-text-secondary">{fixVersions(pkg)}</span>,
  },
];

const groupByManager = (pkg: DependencyPackage) => pkg.manager;

const RISK_OPTIONS: Array<{ value: DependencyRiskFilter; label: string }> = [
  { value: 'all', label: 'All packages' },
  { value: 'any-risk', label: 'Any risk' },
  { value: 'vulnerable', label: 'Vulnerable' },
  { value: 'restricted', label: 'Restricted licence' },
  { value: 'unknown-license', label: 'Unknown licence' },
  { value: 'deprecated', label: 'Deprecated' },
];

const SCOPE_OPTIONS: Array<{ value: DependencyScopeFilter; label: string }> = [
  { value: 'all', label: 'Direct and transitive' },
  { value: 'direct', label: 'Direct' },
  { value: 'transitive', label: 'Transitive' },
];

export function DependenciesStage(props: SurfaceViewProps & { focusTargetId?: string }) {
  const { intent } = props;
  const data = readDependenciesData(intent.payload.data);
  const { handlers, status, confirmDialog } = useDependencyActions(props, data.packages);
  const [filter, setFilter] = useState<DependenciesFilter>(DEFAULT_DEPENDENCIES_FILTER);
  const [sort, setSort] = useState<SortState | null>({ key: 'vulnerabilities', direction: 'asc' });
  const [grouped, setGrouped] = useState(data.managers.length > 1);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(props.focusTargetId ?? null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (props.focusTargetId) setActiveKey(props.focusTargetId);
  }, [props.focusTargetId]);

  const visible = useMemo(() => filterPackages(data.packages, filter), [data.packages, filter]);
  const groupBy = grouped ? groupByManager : undefined;
  const firstShown = useMemo(() => {
    const column = sort ? COLUMNS.find((candidate) => candidate.key === sort.key) : undefined;
    return orderRows(visible, column?.sortValue, sort?.direction ?? 'asc', groupBy)[0];
  }, [visible, sort, groupBy]);
  const activePackage =
    data.packages.find((pkg) => packageKey(pkg) === activeKey) ?? firstShown ?? undefined;
  const managerOptions: Array<{ value: DependencyManager | 'all'; label: string }> = [
    { value: 'all', label: 'All managers' },
    ...DEPENDENCY_MANAGERS.filter((manager) => data.managers.includes(manager)).map((manager) => ({
      value: manager,
      label: manager,
    })),
  ];

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, pkg: DependencyPackage) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'u') {
      event.preventDefault();
      handlers.askUpgrade([packageKey(pkg)]);
    } else if (event.key === 'c') {
      event.preventDefault();
      handlers.comment(pkg);
    }
  };

  if (intent.payload.streaming && data.packages.length === 0) {
    return <SurfaceSkeleton rows={6} label="Loading dependencies" />;
  }

  return (
    <section
      aria-label={intent.payload.title}
      className="flex h-full min-h-0 flex-col gap-3"
      onKeyDown={(event) => {
        const tag = (event.target as HTMLElement).tagName;
        if (event.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) {
          event.preventDefault();
          filterRef.current?.focus();
        }
      }}
    >
      <div className="flex flex-col gap-1">
        <FactList data={data} />
        <ManagerCounts data={data} />
        <AuditState data={data} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FilterInput
          inputRef={filterRef}
          value={filter.query}
          onChange={(query) => setFilter((current) => ({ ...current, query }))}
          placeholder="Filter packages or advisories (press /)"
          label="Filter packages"
        />
        <FilterSelect
          label="Risk"
          value={filter.risk}
          options={RISK_OPTIONS}
          onChange={(risk) =>
            setFilter((current) => ({ ...current, risk: risk as DependencyRiskFilter }))
          }
        />
        <FilterSelect
          label="Manager"
          value={filter.manager}
          options={managerOptions}
          onChange={(manager) => setFilter((current) => ({ ...current, manager }))}
        />
        <FilterSelect
          label="Scope"
          value={filter.scope}
          options={SCOPE_OPTIONS}
          onChange={(scope) =>
            setFilter((current) => ({ ...current, scope: scope as DependencyScopeFilter }))
          }
        />
        <label className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={grouped}
            onChange={(event) => setGrouped(event.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          Group by manager
        </label>
      </div>
      {selected.size > 0 && (
        <div
          role="toolbar"
          aria-label="Selected packages"
          className="flex flex-wrap items-center gap-2 text-xs"
        >
          <span className="text-text-secondary">{selected.size} selected</span>
          <Button
            size="sm"
            variant="primary"
            disabled={handlers.pending !== null}
            onClick={() => handlers.askUpgrade([...selected])}
          >
            Ask agent to upgrade
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={handlers.pending !== null}
            onClick={() => handlers.createWorkItems([...selected])}
          >
            Create work items
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]">
        <div className="min-h-0 overflow-auto">
          <DataTable
            caption={`${intent.payload.title}: ${visible.length} packages`}
            columns={COLUMNS}
            rows={visible}
            getRowId={packageKey}
            sort={sort}
            onSortChange={setSort}
            groupBy={groupBy}
            activeRowId={activePackage ? packageKey(activePackage) : null}
            onActiveRowChange={setActiveKey}
            selectedIds={selected}
            onToggleSelect={(id) => setSelected((current) => toggleInSet(current, id))}
            onToggleAll={(ids) =>
              setSelected((current) =>
                ids.every((id) => current.has(id)) ? new Set() : new Set([...current, ...ids]),
              )
            }
            onRowKeyDown={onRowKeyDown}
            emptyMessage={
              data.packages.length === 0
                ? 'No dependencies found.'
                : 'No packages match the filters.'
            }
            dense
          />
          <p className="px-2 pt-2 text-xs text-text-tertiary">
            Keys: j/k move · space select · u ask upgrade · c comment · / filter
          </p>
        </div>
        <aside
          aria-label="Package detail"
          className="min-h-0 overflow-auto border-t border-border pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0"
        >
          {activePackage ? (
            <PackageDetail pkg={activePackage} handlers={handlers} />
          ) : (
            <p className="text-sm text-text-tertiary">Select a package to see its detail.</p>
          )}
        </aside>
      </div>
      <ActionStatusLine status={status} />
      {confirmDialog}
    </section>
  );
}
