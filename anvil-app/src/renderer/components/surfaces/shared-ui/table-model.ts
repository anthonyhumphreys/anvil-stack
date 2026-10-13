// Pure table helpers shared by the surface tables (sorting, text filtering,
// keyboard row movement, CSV). Kept free of React so they are unit-testable.

export type SortDirection = 'asc' | 'desc';
export interface SortState {
  key: string;
  direction: SortDirection;
}

export type SortValue = string | number | null | undefined;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Nulls sort last in both directions; numbers numerically; strings naturally. */
export function compareSortValues(a: SortValue, b: SortValue): number {
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

export function sortRows<T>(
  rows: readonly T[],
  accessor: ((row: T) => SortValue) | undefined,
  direction: SortDirection,
): T[] {
  if (!accessor) return [...rows];
  const indexed = rows.map((row, index) => ({ row, index, value: accessor(row) }));
  indexed.sort((a, b) => {
    const aEmpty = a.value === null || a.value === undefined || a.value === '';
    const bEmpty = b.value === null || b.value === undefined || b.value === '';
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
    const result = compareSortValues(a.value, b.value);
    return (direction === 'asc' ? result : -result) || a.index - b.index;
  });
  return indexed.map((entry) => entry.row);
}

/** Sorted rows, then (optionally) grouped with groups in alphabetical order. */
export function orderRows<T>(
  rows: readonly T[],
  accessor: ((row: T) => SortValue) | undefined,
  direction: SortDirection,
  groupBy?: (row: T) => string,
): T[] {
  const ordered = sortRows(rows, accessor, direction);
  if (!groupBy) return ordered;
  const groups = new Map<string, T[]>();
  for (const row of ordered) {
    const group = groupBy(row);
    const list = groups.get(group) ?? [];
    list.push(row);
    groups.set(group, list);
  }
  return [...groups.keys()].sort().flatMap((group) => groups.get(group)!);
}

export function nextSort(current: SortState | null, key: string): SortState | null {
  if (!current || current.key !== key) return { key, direction: 'asc' };
  if (current.direction === 'asc') return { key, direction: 'desc' };
  return null;
}

/** Case-insensitive match of every whitespace-separated term somewhere in the fields. */
export function matchesQuery(
  query: string,
  fields: ReadonlyArray<string | number | null | undefined>,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = fields
    .filter((field) => field !== null && field !== undefined)
    .join(' \u0001 ')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** j/k/arrow movement within a list of ids. Returns the next id (or the current one). */
export function moveSelection(
  ids: readonly string[],
  current: string | null | undefined,
  delta: number,
): string | null {
  if (ids.length === 0) return null;
  const index = current ? ids.indexOf(current) : -1;
  if (index < 0) return delta >= 0 ? ids[0] : ids[ids.length - 1];
  return ids[Math.max(0, Math.min(ids.length - 1, index + delta))];
}

export function toggleInSet<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** RFC 4180 CSV; neutralises spreadsheet formula prefixes in text cells. */
export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): string {
  const cell = (value: string | number | null | undefined) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    let text = value;
    if (/^[=+@\t\r]/.test(text) || /^-[^\d.]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.map(cell).join(','), ...rows.map((row) => row.map(cell).join(','))].join('\r\n');
}

export function safeFileName(value: string, extension: string): string {
  const base =
    value
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'export';
  return `${base}.${extension}`;
}
