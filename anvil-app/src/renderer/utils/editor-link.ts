import type { EmbeddedEditorTarget } from '../../shared/types';
import { parseEditorFileLocation } from '../../shared/editor-file-link';

export function buildEditorUrl(target: EmbeddedEditorTarget): string {
  const params = new URLSearchParams();
  const absoluteLocation = parseEditorFileLocation(target.absolutePath, {
    requireFileSignal: false,
  });
  const relativeLocation = parseEditorFileLocation(target.relativePath, {
    requireFileSignal: false,
  });
  const line = finiteNumber(target.line) ?? absoluteLocation?.line ?? relativeLocation?.line;
  const column =
    finiteNumber(target.column) ?? absoluteLocation?.column ?? relativeLocation?.column;
  const absolutePath = absoluteLocation?.path ?? target.absolutePath;
  const relativePath = relativeLocation?.path ?? target.relativePath;

  if (target.workspaceId) params.set('workspaceId', target.workspaceId);
  if (target.repoId) params.set('repoId', target.repoId);
  if (target.repoName) params.set('repoName', target.repoName);
  if (relativePath) params.set('path', relativePath);
  if (absolutePath) params.set('absolutePath', absolutePath);
  if (typeof line === 'number' && Number.isFinite(line)) {
    params.set('line', String(line));
  }
  if (typeof column === 'number' && Number.isFinite(column)) {
    params.set('column', String(column));
  }
  if (target.source) params.set('source', target.source);
  if (target.title) params.set('title', target.title);

  const query = params.toString();
  return query ? `/editor?${query}` : '/editor';
}

export function parseEditorSearchParams(
  searchParams: URLSearchParams,
): EmbeddedEditorTarget | null {
  const workspaceId = searchParams.get('workspaceId') ?? undefined;
  const repoId = searchParams.get('repoId') ?? undefined;
  const repoName = searchParams.get('repoName') ?? undefined;
  const relativePath = searchParams.get('path') ?? undefined;
  const absolutePath = searchParams.get('absolutePath') ?? undefined;
  const relativeLocation = parseEditorFileLocation(relativePath, {
    requireFileSignal: false,
  });
  const absoluteLocation = parseEditorFileLocation(absolutePath, {
    requireFileSignal: false,
  });
  const lineValue = searchParams.get('line');
  const columnValue = searchParams.get('column');
  const source = searchParams.get('source');
  const title = searchParams.get('title') ?? undefined;

  const line = parseSearchNumber(lineValue);
  const column = parseSearchNumber(columnValue);
  const resolvedLine = line ?? absoluteLocation?.line ?? relativeLocation?.line;
  const resolvedColumn = column ?? absoluteLocation?.column ?? relativeLocation?.column;

  if (!workspaceId && !repoId && !relativePath && !absolutePath && !title) {
    return null;
  }

  return {
    workspaceId,
    repoId,
    repoName,
    relativePath: relativeLocation?.path ?? relativePath,
    absolutePath: absoluteLocation?.path ?? absolutePath,
    line: Number.isFinite(resolvedLine) ? resolvedLine : undefined,
    column: Number.isFinite(resolvedColumn) ? resolvedColumn : undefined,
    source: source ? (source as EmbeddedEditorTarget['source']) : undefined,
    title,
  };
}

function parseSearchNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  return finiteNumber(Number.parseInt(value, 10));
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
