import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, Wrench, X } from 'lucide-react';
import type { LibraryItem } from '../../../shared/library-ipc';
import type { ComplianceDocType } from '../../../shared/types';
import { Button, IconButton } from '../ui';
import { InlineNotice } from '../layout/ViewScaffold';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import { formatLibraryUpdatedAt, librarySubtypeLabel } from './library-model';

type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; markdown: string | null }
  | { status: 'error'; message: string };

const COMPLIANCE_DOC_TYPES: readonly ComplianceDocType[] = [
  'dpia',
  'privacy-policy',
  'terms-of-service',
];

/**
 * Reader for repo-knowledge items in the Library. ADRs and compliance docs
 * render their markdown; diagrams open in draw.io. Each links to the kind's
 * full tool for editing or generation.
 */
export function LibraryItemDetail({
  item,
  workspaceId,
  onClose,
  onOpenTool,
  toolLabel,
}: {
  item: LibraryItem;
  workspaceId: string | undefined;
  onClose: () => void;
  onOpenTool: () => void;
  toolLabel?: string;
}) {
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<string | null> => {
      if (item.kind === 'adr' && workspaceId) {
        const groups = await window.anvil.adr.listByWorkspace(workspaceId);
        const adr = groups
          .find((group) => group.repoId === item.repoId)
          ?.adrs.find((entry) => entry.relativePath === item.path);
        return adr?.content ?? null;
      }
      if (
        item.kind === 'compliance' &&
        item.repoId &&
        COMPLIANCE_DOC_TYPES.includes(item.subtype as ComplianceDocType)
      ) {
        const doc = await window.anvil.compliance.read(
          item.repoId,
          item.subtype as ComplianceDocType,
        );
        return doc?.content ?? null;
      }
      return null;
    };
    setState({ status: 'loading' });
    load()
      .then((markdown) => {
        if (!cancelled) setState({ status: 'ready', markdown });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to load this item.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [item, workspaceId]);

  const openDiagram = async () => {
    if (!item.repoId || !item.path) return;
    setActionError(null);
    try {
      await window.anvil.diagrams.openEditor(item.repoId, item.path);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not open draw.io.');
    }
  };

  const updated = formatLibraryUpdatedAt(item.updatedAt);

  return (
    <>
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-text-primary" title={item.title}>
            {item.title}
          </h2>
          <p className="mt-0.5 truncate text-xs text-text-tertiary">
            {[librarySubtypeLabel(item), item.repoName, updated].filter(Boolean).join(' · ')}
          </p>
          {item.path && (
            <p className="mt-0.5 break-all font-mono text-xs text-text-tertiary">{item.path}</p>
          )}
        </div>
        <IconButton icon={X} label="Close details" onClick={onClose} />
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 px-4 py-3">
        {item.kind === 'diagram' && (
          <Button variant="primary" size="sm" onClick={() => void openDiagram()}>
            <ExternalLink size={13} aria-hidden="true" />
            Open in draw.io
          </Button>
        )}
        {toolLabel && (
          <Button variant="secondary" size="sm" onClick={onOpenTool}>
            <Wrench size={13} aria-hidden="true" />
            Open {toolLabel}
          </Button>
        )}
      </div>
      {actionError && (
        <InlineNotice tone="error" className="mx-4 mb-3">
          {actionError}
        </InlineNotice>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {state.status === 'loading' ? (
          <div className="flex items-center gap-2 py-4 text-sm text-text-tertiary">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            Loading…
          </div>
        ) : state.status === 'error' ? (
          <InlineNotice tone="error">{state.message}</InlineNotice>
        ) : state.markdown ? (
          <MarkdownRenderer content={state.markdown} />
        ) : item.kind === 'diagram' ? (
          <p className="text-sm text-text-tertiary">
            Diagrams are edited in draw.io. Use the diagram editor to regenerate or delete them.
          </p>
        ) : (
          <p className="text-sm text-text-tertiary">This item has no readable content.</p>
        )}
      </div>
    </>
  );
}
