import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FileText, FileUp, Loader2, Search, X } from 'lucide-react';
import type { GovernanceBoard, GovernanceDocument } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';

export interface GovernanceSelection {
  boards: GovernanceBoard[];
  documents: GovernanceDocument[];
}

interface GovernanceSelectorProps {
  selectedDocIds: string[];
  onSelectionChange: (docs: GovernanceDocument[]) => void;
}

export function GovernanceSelector({ selectedDocIds, onSelectionChange }: GovernanceSelectorProps) {
  const { activeWorkspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState<GovernanceBoard[]>([]);
  const [documents, setDocuments] = useState<GovernanceDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const loadWorkspaceDocs = useCallback(async () => {
    if (!activeWorkspace) {
      setBoards([]);
      setDocuments([]);
      return;
    }

    const wsId = activeWorkspace.id;
    const [loadedBoards, loadedDocuments] = await Promise.all([
      window.anvil.governance.listBoards(wsId),
      window.anvil.governance.listDocuments(wsId),
    ]);
    setBoards(loadedBoards);
    setDocuments(loadedDocuments);
  }, [activeWorkspace]);

  // Load governance data when workspace changes
  useEffect(() => {
    void loadWorkspaceDocs();
  }, [loadWorkspaceDocs]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!activeWorkspace) return null;

  const isSelected = (id: string) => selectedDocIds.includes(id);

  const handleToggleDoc = (doc: GovernanceDocument) => {
    const next = isSelected(doc.id)
      ? documents.filter((d) => selectedDocIds.includes(d.id) && d.id !== doc.id)
      : [...documents.filter((d) => selectedDocIds.includes(d.id)), doc];
    onSelectionChange(next);
  };

  const handleToggleBoard = (boardId: string) => {
    const boardDocs = documents.filter((d) => d.boardId === boardId);
    const allSelected = boardDocs.every((d) => isSelected(d.id));
    if (allSelected) {
      // Deselect all board docs
      onSelectionChange(
        documents.filter((d) => selectedDocIds.includes(d.id) && d.boardId !== boardId),
      );
    } else {
      // Select all board docs (add any not already selected)
      const currentlySelected = documents.filter((d) => selectedDocIds.includes(d.id));
      const toAdd = boardDocs.filter((d) => !isSelected(d.id));
      onSelectionChange([...currentlySelected, ...toAdd]);
    }
  };

  const handleClear = () => {
    onSelectionChange([]);
  };

  const handleUpload = useCallback(async () => {
    if (!activeWorkspace) return;

    setUploading(true);
    try {
      const filePaths = await window.anvil.governance.selectFiles();
      if (filePaths.length === 0) return;

      const addedDocs: GovernanceDocument[] = [];
      for (const filePath of filePaths) {
        const added = await window.anvil.governance.addDocument(activeWorkspace.id, filePath);
        addedDocs.push(added);
      }

      await loadWorkspaceDocs();

      const selectedDocs = documents.filter((doc) => selectedDocIds.includes(doc.id));
      onSelectionChange([...selectedDocs, ...addedDocs]);
      setOpen(true);
    } finally {
      setUploading(false);
    }
  }, [activeWorkspace, documents, loadWorkspaceDocs, onSelectionChange, selectedDocIds]);

  const filtered = search
    ? documents.filter(
        (d) =>
          d.fileName.toLowerCase().includes(search.toLowerCase()) ||
          d.description?.toLowerCase().includes(search.toLowerCase()),
      )
    : documents;

  // Group by board
  const boardMap = new Map<string | undefined, GovernanceDocument[]>();
  for (const doc of filtered) {
    const key = doc.boardId;
    if (!boardMap.has(key)) boardMap.set(key, []);
    boardMap.get(key)!.push(doc);
  }

  const label = (() => {
    if (selectedDocIds.length === 0) return documents.length === 0 ? 'Add docs' : 'Governance';
    if (selectedDocIds.length === 1) {
      const doc = documents.find((d) => d.id === selectedDocIds[0]);
      return doc?.fileName ?? '1 doc';
    }
    return `${selectedDocIds.length} docs`;
  })();

  return (
    <div className="relative z-50" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm transition-colors hover:bg-bg-tertiary ${
          selectedDocIds.length > 0 ? 'border-accent/40 bg-accent/10' : 'border-border'
        }`}
        aria-label="Select governance documents"
        aria-expanded={open}
      >
        <FileText
          size={12}
          className={selectedDocIds.length > 0 ? 'text-accent' : 'text-text-tertiary'}
        />
        <span className="text-text-primary">{label}</span>
        {selectedDocIds.length > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleClear();
            }}
            className="ml-0.5 rounded p-0.5 text-text-tertiary hover:text-text-primary"
            title="Clear governance selection"
          >
            <X size={10} />
          </button>
        )}
        <ChevronDown size={12} className="text-text-tertiary" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-80 overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl ring-1 ring-black/10">
          <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
            <span className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
              Workspace documents
            </span>
            <button
              onClick={() => void handleUpload()}
              disabled={uploading}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
            >
              {uploading ? <Loader2 size={12} className="animate-spin" /> : <FileUp size={12} />}
              Add docs
            </button>
          </div>

          {/* Search */}
          <div className="border-b border-border-subtle px-3 py-2">
            <div className="flex items-center gap-2 rounded-md border border-border bg-bg-primary px-2 py-1">
              <Search size={12} className="shrink-0 text-text-tertiary" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search documents..."
                className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
                autoFocus
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="text-text-tertiary hover:text-text-primary"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          <div className="max-h-64 overflow-auto">
            {documents.length === 0 && (
              <p className="px-3 py-4 text-center text-sm text-text-tertiary">
                Upload documents here to ingest them into Chat context.
              </p>
            )}

            {Array.from(boardMap.entries()).map(([boardId, docs]) => {
              const board = boardId ? boards.find((b) => b.id === boardId) : null;
              const boardDocs = documents.filter((d) => d.boardId === boardId);
              const allBoardSelected = boardDocs.every((d) => isSelected(d.id));

              return (
                <div key={boardId ?? '__unassigned'}>
                  {/* Board header */}
                  <button
                    onClick={() => boardId && handleToggleBoard(boardId)}
                    className="flex w-full items-center gap-2 bg-bg-secondary px-3 py-1.5 text-left text-xs font-medium uppercase tracking-wide text-text-tertiary hover:bg-bg-tertiary"
                  >
                    {boardId && (
                      <input
                        type="checkbox"
                        checked={allBoardSelected}
                        readOnly
                        className="accent-accent"
                      />
                    )}
                    <span>{board?.name ?? 'Unassigned'}</span>
                  </button>

                  {/* Documents */}
                  {docs.map((doc) => (
                    <button
                      key={doc.id}
                      onClick={() => handleToggleDoc(doc)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary"
                    >
                      <input
                        type="checkbox"
                        checked={isSelected(doc.id)}
                        readOnly
                        className="accent-accent"
                      />
                      <FileText size={12} className="shrink-0 text-text-tertiary" />
                      <div className="flex-1 min-w-0">
                        <div className="text-text-primary truncate">{doc.fileName}</div>
                        {doc.description && (
                          <div className="text-xs text-text-tertiary truncate">
                            {doc.description}
                          </div>
                        )}
                      </div>
                      {isSelected(doc.id) && <Check size={12} className="shrink-0 text-accent" />}
                    </button>
                  ))}
                </div>
              );
            })}

            {documents.length > 0 && filtered.length === 0 && (
              <p className="px-3 py-4 text-center text-sm text-text-tertiary">
                No documents match your search.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
