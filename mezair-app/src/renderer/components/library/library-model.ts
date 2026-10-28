import type { LibraryItem, LibraryListFilter } from '../../../shared/library-ipc';
import type { Feature } from '../../../shared/types';
import {
  chatItemPath,
  isLibraryFilterKey,
  libraryPath,
  type LibraryFilterKey,
} from '../../utils/sidebar-navigation';

export interface LibraryChip {
  key: LibraryFilterKey;
  label: string;
  /** Role feature required to show the chip (and its items under All). */
  feature?: Feature;
  /** Kinds with a full management tool reachable from the Library. */
  hasTool?: boolean;
}

/** Filter chips, in display order (spec §10, §11.5). */
export const LIBRARY_CHIPS: readonly LibraryChip[] = [
  { key: 'all', label: 'All' },
  { key: 'artifact', label: 'Artifacts' },
  { key: 'surface', label: 'Reviews & reports' },
  { key: 'adr', label: 'ADRs', feature: 'adrs', hasTool: true },
  { key: 'diagram', label: 'Diagrams', feature: 'diagrams', hasTool: true },
  { key: 'compliance', label: 'Compliance', feature: 'compliance', hasTool: true },
  { key: 'doc', label: 'Docs', feature: 'docs', hasTool: true },
  { key: 'shared', label: 'Shared' },
];

/** Feature that gates each repo-knowledge item kind. */
export const LIBRARY_KIND_FEATURES: Partial<Record<LibraryItem['kind'], Feature>> = {
  adr: 'adrs',
  diagram: 'diagrams',
  compliance: 'compliance',
  doc: 'docs',
};

export function availableLibraryChips(isAllowed: (feature?: Feature) => boolean): LibraryChip[] {
  return LIBRARY_CHIPS.filter((chip) => isAllowed(chip.feature));
}

/** Resolve the `kind` URL param against the chips the role can see. */
export function resolveLibraryFilter(
  requested: string | null,
  chips: readonly LibraryChip[],
): LibraryFilterKey {
  if (isLibraryFilterKey(requested) && chips.some((chip) => chip.key === requested)) {
    return requested;
  }
  return 'all';
}

/**
 * What the Library asks main for. `doc` (provider docs) and `shared` (share
 * records) are rendered by embedded views, so they return `null`.
 */
export function libraryListFilter(
  filter: LibraryFilterKey,
  options: { repoId?: string | null; query?: string } = {},
): LibraryListFilter | null {
  if (filter === 'doc' || filter === 'shared') return null;
  const result: LibraryListFilter = {};
  if (filter !== 'all') result.kind = filter;
  if (options.repoId) result.repoId = options.repoId;
  const query = options.query?.trim();
  if (query) result.query = query;
  return result;
}

/** Drop knowledge items the role can't use (e.g. ADRs for a design role under All). */
export function visibleLibraryItems(
  items: LibraryItem[],
  isAllowed: (feature?: Feature) => boolean,
): LibraryItem[] {
  return items.filter((item) => isAllowed(LIBRARY_KIND_FEATURES[item.kind]));
}

export type LibraryOpenAction = { type: 'navigate'; to: string } | { type: 'detail' };

/**
 * Artifacts and surfaces open on their thread's stage (`?artifact=` /
 * `?surface=`); repo knowledge opens in the Library's detail pane.
 */
export function libraryItemOpenAction(item: LibraryItem): LibraryOpenAction {
  if ((item.kind === 'artifact' || item.kind === 'surface') && item.threadId) {
    return {
      type: 'navigate',
      to: chatItemPath(
        item.threadId,
        item.kind === 'surface' ? { surfaceId: item.id } : { artifactId: item.id },
      ),
    };
  }
  if (item.kind === 'doc') return { type: 'navigate', to: libraryPath({ kind: 'doc' }) };
  return { type: 'detail' };
}

const SUBTYPE_LABELS: Record<string, string> = {
  review: 'Review',
  findings: 'Findings',
  pipeline: 'Pipeline',
  dependencies: 'Dependencies',
  data: 'Data',
  artifact: 'Artifact',
  plan: 'Plan',
  diagram: 'Diagram',
  dpia: 'DPIA',
  'privacy-policy': 'Privacy policy',
  'terms-of-service': 'Terms of service',
  drawio: 'draw.io',
  markdown: 'Markdown',
  html: 'HTML',
  csv: 'CSV',
  xlsx: 'Spreadsheet',
  docx: 'Document',
  pptx: 'Presentation',
  pdf: 'PDF',
  code: 'Code',
  mermaid: 'Mermaid',
};

const KIND_LABELS: Record<LibraryItem['kind'], string> = {
  artifact: 'Artifact',
  surface: 'Report',
  adr: 'ADR',
  diagram: 'Diagram',
  compliance: 'Compliance',
  doc: 'Doc',
};

/** Short secondary label for a row: "ADR · Accepted", "Report · Review", "Artifact · Markdown v3". */
export function librarySubtypeLabel(item: LibraryItem): string {
  const kind = KIND_LABELS[item.kind];
  const subtype = item.subtype ? (SUBTYPE_LABELS[item.subtype] ?? item.subtype) : '';
  const parts = [kind];
  if (subtype && subtype !== kind) parts.push(subtype);
  const label = parts.join(' · ');
  return item.kind === 'artifact' && item.version && item.version > 1
    ? `${label} v${item.version}`
    : label;
}

/** Compact relative time for rows; absolute date beyond a week. */
export function formatLibraryUpdatedAt(value: string, now: number = Date.now()): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time <= 0) return '';
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(time).toLocaleDateString();
}

/** Empty-state copy per filter. */
export function libraryEmptyCopy(
  filter: LibraryFilterKey,
  hasQuery: boolean,
): {
  title: string;
  description: string;
} {
  if (hasQuery) {
    return { title: 'Nothing matches', description: 'Try a different search or filter.' };
  }
  switch (filter) {
    case 'artifact':
      return {
        title: 'No artifacts yet',
        description: 'Documents the agent saves in a thread appear here, latest version first.',
      };
    case 'surface':
      return {
        title: 'No reviews or reports yet',
        description: 'Reviews, findings, pipelines and other reports from chat appear here.',
      };
    case 'adr':
      return {
        title: 'No ADRs found',
        description: 'Architecture decision records in workspace repositories appear here.',
      };
    case 'diagram':
      return {
        title: 'No diagrams yet',
        description: 'draw.io diagrams in docs/diagrams of each repository appear here.',
      };
    case 'compliance':
      return {
        title: 'No compliance documents yet',
        description: 'Generate a DPIA, privacy policy or terms of service from the tool.',
      };
    default:
      return {
        title: 'The Library is empty',
        description:
          'Artifacts and reports from chat, ADRs, diagrams and compliance docs collect here.',
      };
  }
}
