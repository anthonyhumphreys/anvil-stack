import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  FINDING_STATUS_LABELS,
  countBySeverity,
  findingLocation,
  isActiveFinding,
  type SurfaceFinding,
} from '../../../../../shared/surfaces/kinds/findings';
import { Button } from '../../../ui';
import type { SurfaceViewProps } from '../../types';
import { DataTable, type DataTableColumn } from '../../shared-ui/DataTable';
import { SeverityBadge, SeveritySummaryBar } from '../../shared-ui/SeverityGlyph';
import { orderRows, toggleInSet, type SortState } from '../../shared-ui/table-model';
import {
  ActionStatusLine,
  FilterInput,
  FilterSelect,
  SurfaceSkeleton,
} from '../../shared-ui/useSurfaceActions';
import { AuditProgress, FindingDetail, FindingLocation, FindingStatusLabel } from './FindingParts';
import {
  DEFAULT_FINDINGS_FILTER,
  actionableIds,
  filterFindings,
  findingCategories,
  readFindingsData,
  severitySortValue,
  type FindingsFilter,
  type FindingsStatusFilter,
} from './model';
import { useFindingsActions } from './useFindingsActions';

const STATUS_OPTIONS: Array<{ value: FindingsStatusFilter; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All statuses' },
  { value: 'open', label: FINDING_STATUS_LABELS.open },
  { value: 'fix-requested', label: FINDING_STATUS_LABELS['fix-requested'] },
  { value: 'fixed', label: FINDING_STATUS_LABELS.fixed },
  { value: 'dismissed', label: FINDING_STATUS_LABELS.dismissed },
];

const COLUMNS: DataTableColumn<SurfaceFinding>[] = [
  {
    key: 'severity',
    header: 'Severity',
    render: (finding) => <SeverityBadge severity={finding.severity} />,
    sortValue: severitySortValue,
    className: 'w-24',
  },
  {
    key: 'title',
    header: 'Finding',
    render: (finding) => <span className="text-text-primary">{finding.title}</span>,
    sortValue: (finding) => finding.title,
  },
  {
    key: 'location',
    header: 'Location',
    render: (finding) => <FindingLocation finding={finding} />,
    sortValue: (finding) => findingLocation(finding),
  },
  {
    key: 'category',
    header: 'Category',
    render: (finding) => <span className="text-text-secondary">{finding.category ?? ''}</span>,
    sortValue: (finding) => finding.category,
  },
  {
    key: 'status',
    header: 'Status',
    render: (finding) => <FindingStatusLabel status={finding.status} />,
    sortValue: (finding) => finding.status,
  },
];

export function FindingsStage(props: SurfaceViewProps & { focusTargetId?: string }) {
  const { intent } = props;
  const data = readFindingsData(intent.payload.data);
  const { handlers, status, confirmDialog } = useFindingsActions(props, data.findings);
  const [filter, setFilter] = useState<FindingsFilter>(DEFAULT_FINDINGS_FILTER);
  const [sort, setSort] = useState<SortState | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(props.focusTargetId ?? null);
  const filterRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => filterFindings(data.findings, filter), [data.findings, filter]);
  const categories = useMemo(() => findingCategories(data.findings), [data.findings]);
  const firstShown = useMemo(() => {
    const column = sort ? COLUMNS.find((candidate) => candidate.key === sort.key) : undefined;
    return orderRows(visible, column?.sortValue, sort?.direction ?? 'asc')[0];
  }, [visible, sort]);
  const activeFinding =
    data.findings.find((finding) => finding.id === activeId) ?? firstShown ?? undefined;
  const selectedActionable = actionableIds(data.findings, selected);

  useEffect(() => {
    if (props.focusTargetId) setActiveId(props.focusTargetId);
  }, [props.focusTargetId]);

  const onContainerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) {
      event.preventDefault();
      filterRef.current?.focus();
    }
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, finding: SurfaceFinding) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'd') {
      event.preventDefault();
      handlers.onDismiss([finding.id]);
    } else if (event.key === 'f') {
      event.preventDefault();
      handlers.onAskFix([finding.id]);
    } else if (event.key === 'c') {
      event.preventDefault();
      handlers.onComment(finding);
    }
  };

  if (intent.payload.streaming && data.findings.length === 0 && data.auditStatus !== 'running') {
    return <SurfaceSkeleton rows={6} label="Loading findings" />;
  }

  return (
    <section
      aria-label={intent.payload.title}
      onKeyDown={onContainerKeyDown}
      className="flex h-full min-h-0 flex-col gap-3"
    >
      <AuditProgress data={data} />
      <SeveritySummaryBar
        counts={countBySeverity(data.findings.filter(isActiveFinding))}
        label="Filter by severity"
        selected={filter.severities}
        onSelect={(severity) =>
          setFilter((current) => ({
            ...current,
            severities: toggleInSet(current.severities, severity),
          }))
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <FilterInput
          inputRef={filterRef}
          value={filter.query}
          onChange={(query) => setFilter((current) => ({ ...current, query }))}
          placeholder="Filter findings (press /)"
          label="Filter findings"
        />
        <FilterSelect
          label="Status"
          value={filter.status}
          options={STATUS_OPTIONS}
          onChange={(value) =>
            setFilter((current) => ({ ...current, status: value as FindingsStatusFilter }))
          }
        />
        {categories.length > 0 && (
          <FilterSelect
            label="Category"
            value={filter.category}
            options={[
              { value: 'all', label: 'All categories' },
              ...categories.map((category) => ({ value: category, label: category })),
            ]}
            onChange={(value) => setFilter((current) => ({ ...current, category: value }))}
          />
        )}
      </div>
      {selected.size > 0 && (
        <div
          role="toolbar"
          aria-label="Selected findings"
          className="flex flex-wrap items-center gap-2 text-xs"
        >
          <span className="text-text-secondary">{selected.size} selected</span>
          <Button
            size="sm"
            variant="primary"
            disabled={selectedActionable.length === 0 || handlers.pending !== null}
            onClick={() => handlers.onAskFix(selectedActionable)}
          >
            Ask agent to fix
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={selectedActionable.length === 0 || handlers.pending !== null}
            onClick={() => handlers.onDismiss(selectedActionable)}
          >
            Dismiss
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={handlers.pending !== null}
            onClick={() => handlers.onCreateWorkItems([...selected])}
          >
            Create work items
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
        <div className="min-h-0 overflow-auto">
          <DataTable
            caption={`${intent.payload.title}: ${visible.length} findings`}
            columns={COLUMNS}
            rows={visible}
            getRowId={(finding) => finding.id}
            sort={sort}
            onSortChange={setSort}
            activeRowId={activeFinding?.id ?? null}
            onActiveRowChange={setActiveId}
            selectedIds={selected}
            onToggleSelect={(id) => setSelected((current) => toggleInSet(current, id))}
            onToggleAll={(ids) =>
              setSelected((current) =>
                ids.every((id) => current.has(id)) ? new Set() : new Set([...current, ...ids]),
              )
            }
            onRowKeyDown={onRowKeyDown}
            emptyMessage={
              data.findings.length === 0 ? 'No findings.' : 'No findings match the filters.'
            }
            dense
          />
          <p className="px-2 pt-2 text-xs text-text-tertiary">
            Keys: j/k move · space select · f ask fix · d dismiss · c comment · / filter
          </p>
        </div>
        <aside
          aria-label="Finding detail"
          className="min-h-0 overflow-auto border-t border-border pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0"
        >
          {activeFinding ? (
            <FindingDetail finding={activeFinding} handlers={handlers} />
          ) : (
            <p className="text-sm text-text-tertiary">Select a finding to see its detail.</p>
          )}
        </aside>
      </div>
      <ActionStatusLine status={status} />
      {confirmDialog}
    </section>
  );
}
