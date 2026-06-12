import { useCallback, useEffect, useState } from 'react';
import {
  Landmark,
  Plus,
  FileUp,
  Trash2,
  Loader2,
  FileText,
  Presentation,
  Sheet,
  File,
  FolderOpen,
  Pencil,
  X,
} from 'lucide-react';
import type {
  GovernanceBoard,
  GovernanceDocument,
  GovernanceFileType,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { LifecycleListPanel } from './lifecycle/LifecycleListPanel';
import { LifecycleDetailView } from './lifecycle/LifecycleDetailView';
import { GateConfigView } from './gate-config/GateConfigView';

const FILE_TYPE_ICONS: Record<GovernanceFileType, typeof FileText> = {
  pdf: FileText,
  docx: FileText,
  pptx: Presentation,
  xlsx: Sheet,
  other: File,
};

const FILE_TYPE_LABELS: Record<GovernanceFileType, string> = {
  pdf: 'PDF',
  docx: 'Word',
  pptx: 'PowerPoint',
  xlsx: 'Excel',
  other: 'File',
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function GovernanceView() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace?.id;

  const [activeTab, setActiveTab] = useState<'boards' | 'lifecycle' | 'config'>('boards');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  const [boards, setBoards] = useState<GovernanceBoard[]>([]);
  const [documents, setDocuments] = useState<GovernanceDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);

  // Create board modal
  const [showCreateBoard, setShowCreateBoard] = useState(false);
  const [newBoardName, setNewBoardName] = useState('');
  const [newBoardDescription, setNewBoardDescription] = useState('');

  // Edit board modal
  const [editingBoard, setEditingBoard] = useState<GovernanceBoard | null>(null);

  const loadData = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const [b, d] = await Promise.all([
        window.anvil.governance.listBoards(workspaceId),
        window.anvil.governance.listDocuments(workspaceId, selectedBoardId ?? undefined),
      ]);
      setBoards(b);
      setDocuments(d);
    } catch (err) {
      console.error('Failed to load governance data:', err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, selectedBoardId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreateBoard = useCallback(async () => {
    if (!workspaceId || !newBoardName.trim()) return;
    await window.anvil.governance.createBoard(
      workspaceId,
      newBoardName.trim(),
      newBoardDescription.trim() || undefined,
    );
    setShowCreateBoard(false);
    setNewBoardName('');
    setNewBoardDescription('');
    loadData();
  }, [workspaceId, newBoardName, newBoardDescription, loadData]);

  const handleUpdateBoard = useCallback(async () => {
    if (!editingBoard) return;
    await window.anvil.governance.updateBoard(editingBoard.id, {
      name: editingBoard.name,
      description: editingBoard.description,
    });
    setEditingBoard(null);
    loadData();
  }, [editingBoard, loadData]);

  const handleDeleteBoard = useCallback(
    async (id: string) => {
      await window.anvil.governance.deleteBoard(id);
      if (selectedBoardId === id) setSelectedBoardId(null);
      loadData();
    },
    [selectedBoardId, loadData],
  );

  const handleAddDocuments = useCallback(async () => {
    if (!workspaceId) return;
    const filePaths = await window.anvil.governance.selectFiles();
    if (filePaths.length === 0) return;

    for (const filePath of filePaths) {
      await window.anvil.governance.addDocument(
        workspaceId,
        filePath,
        selectedBoardId ?? undefined,
      );
    }
    loadData();
  }, [workspaceId, selectedBoardId, loadData]);

  const handleRemoveDocument = useCallback(
    async (id: string) => {
      await window.anvil.governance.removeDocument(id);
      loadData();
    },
    [loadData],
  );

  const handleAssignBoard = useCallback(
    async (docId: string, boardId: string | null) => {
      await window.anvil.governance.updateDocument(docId, { boardId });
      loadData();
    },
    [loadData],
  );

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-secondary">Select a workspace to get started.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="flex border-b border-border bg-bg-secondary">
        {(['boards', 'lifecycle', 'config'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors ${
              activeTab === tab
                ? 'border-b-2 border-accent text-accent'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab === 'boards'
              ? 'Boards & Docs'
              : tab === 'lifecycle'
                ? 'Delivery Lifecycle'
                : 'Gate Config'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'boards' && (
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border bg-bg-secondary px-4 py-2">
            <div className="flex items-center gap-3">
              <Landmark size={20} className="text-accent" />
              <h2 className="text-xl font-semibold">Governance</h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleAddDocuments}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm text-text-secondary hover:text-text-primary"
              >
                <FileUp size={12} />
                Add Documents
              </button>
              <button
                onClick={() => setShowCreateBoard(true)}
                className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-sm font-medium text-white hover:bg-accent/90"
              >
                <Plus size={12} />
                New Board
              </button>
            </div>
          </div>

          <div className="flex flex-1 overflow-hidden">
            {/* Board sidebar */}
            <div className="w-[240px] shrink-0 overflow-auto border-r border-border bg-bg-secondary p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                Boards
              </div>

              <button
                onClick={() => setSelectedBoardId(null)}
                className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                  selectedBoardId === null
                    ? 'bg-accent/15 font-medium text-accent'
                    : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
              >
                <FolderOpen size={14} />
                All Documents
                <span className="ml-auto text-xs text-text-tertiary">{documents.length}</span>
              </button>

              {boards.map((board) => (
                <div
                  key={board.id}
                  className={`group mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                    selectedBoardId === board.id
                      ? 'bg-accent/15 font-medium text-accent'
                      : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                  }`}
                >
                  <button
                    onClick={() => setSelectedBoardId(board.id)}
                    className="flex flex-1 items-center gap-2 truncate"
                  >
                    <Landmark size={14} />
                    <span className="truncate">{board.name}</span>
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                    <button
                      onClick={() => setEditingBoard({ ...board })}
                      className="rounded p-0.5 text-text-tertiary hover:text-text-primary"
                      aria-label={`Edit ${board.name}`}
                    >
                      <Pencil size={10} />
                    </button>
                    <button
                      onClick={() => handleDeleteBoard(board.id)}
                      className="rounded p-0.5 text-text-tertiary hover:text-error"
                      aria-label={`Delete ${board.name}`}
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
              ))}

              {boards.length === 0 && (
                <p className="mt-2 text-xs text-text-tertiary">
                  Create a board to organise documents by governance authority (e.g. Architecture
                  Review Board).
                </p>
              )}
            </div>

            {/* Documents area */}
            <div className="flex-1 overflow-auto p-4">
              {loading ? (
                <div className="flex h-64 items-center justify-center">
                  <Loader2 size={24} className="animate-spin text-accent" />
                </div>
              ) : documents.length === 0 ? (
                <div className="flex h-64 items-center justify-center">
                  <div className="text-center">
                    <FileText size={32} className="mx-auto mb-3 text-text-tertiary" />
                    <p className="text-sm text-text-secondary">
                      {selectedBoardId
                        ? 'No documents in this board yet.'
                        : 'No governance documents added yet.'}
                    </p>
                    <button
                      onClick={handleAddDocuments}
                      className="mt-3 flex items-center gap-1 mx-auto rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
                    >
                      <FileUp size={14} />
                      Add Documents
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {documents.map((doc) => {
                    const Icon = FILE_TYPE_ICONS[doc.fileType];
                    return (
                      <div
                        key={doc.id}
                        className="group flex items-center gap-3 rounded-md border border-border bg-bg-tertiary p-3"
                      >
                        <Icon size={20} className="shrink-0 text-accent" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-text-primary">
                              {doc.fileName}
                            </span>
                            <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-xs text-text-tertiary">
                              {FILE_TYPE_LABELS[doc.fileType]}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-3 text-xs text-text-secondary">
                            <span>{formatFileSize(doc.fileSize)}</span>
                            <span className="truncate text-text-tertiary" title={doc.filePath}>
                              {doc.filePath}
                            </span>
                          </div>
                        </div>

                        {/* Board assignment */}
                        <select
                          value={doc.boardId ?? ''}
                          onChange={(e) => handleAssignBoard(doc.id, e.target.value || null)}
                          className="rounded border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary"
                          title="Assign to board"
                        >
                          <option value="">No board</option>
                          {boards.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>

                        <button
                          onClick={() => handleRemoveDocument(doc.id)}
                          className="rounded p-1 text-text-tertiary opacity-0 hover:text-error group-hover:opacity-100"
                          aria-label={`Remove ${doc.fileName}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Create board modal */}
          {showCreateBoard && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
              <div className="w-96 rounded-lg border border-border bg-bg-elevated p-4 shadow-lg">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-text-primary">
                    New Governance Board
                  </h3>
                  <button
                    onClick={() => setShowCreateBoard(false)}
                    className="rounded p-0.5 text-text-tertiary hover:text-text-primary"
                    aria-label="Close"
                  >
                    <X size={16} />
                  </button>
                </div>

                <div className="mt-3 space-y-3">
                  <div>
                    <label className="mb-1 block text-sm text-text-secondary">Name</label>
                    <input
                      type="text"
                      value={newBoardName}
                      onChange={(e) => setNewBoardName(e.target.value)}
                      placeholder="e.g. Architecture Review Board"
                      className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm text-text-secondary">Description</label>
                    <textarea
                      value={newBoardDescription}
                      onChange={(e) => setNewBoardDescription(e.target.value)}
                      placeholder="What does this governance board review?"
                      rows={2}
                      className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                    />
                  </div>
                </div>

                <div className="mt-4 flex justify-end gap-2">
                  <button
                    onClick={() => setShowCreateBoard(false)}
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateBoard}
                    disabled={!newBoardName.trim()}
                    className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-40"
                  >
                    Create
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Edit board modal */}
          {editingBoard && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
              <div className="w-96 rounded-lg border border-border bg-bg-elevated p-4 shadow-lg">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-text-primary">Edit Board</h3>
                  <button
                    onClick={() => setEditingBoard(null)}
                    className="rounded p-0.5 text-text-tertiary hover:text-text-primary"
                    aria-label="Close"
                  >
                    <X size={16} />
                  </button>
                </div>

                <div className="mt-3 space-y-3">
                  <div>
                    <label className="mb-1 block text-sm text-text-secondary">Name</label>
                    <input
                      type="text"
                      value={editingBoard.name}
                      onChange={(e) => setEditingBoard({ ...editingBoard, name: e.target.value })}
                      className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm text-text-secondary">Description</label>
                    <textarea
                      value={editingBoard.description ?? ''}
                      onChange={(e) =>
                        setEditingBoard({ ...editingBoard, description: e.target.value })
                      }
                      rows={2}
                      className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
                    />
                  </div>
                </div>

                <div className="mt-4 flex justify-end gap-2">
                  <button
                    onClick={() => setEditingBoard(null)}
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleUpdateBoard}
                    disabled={!editingBoard.name.trim()}
                    className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'lifecycle' && (
        <div className="flex flex-1 overflow-hidden">
          <div className="w-80 shrink-0 overflow-y-auto border-r border-border">
            <LifecycleListPanel
              workspaceId={workspaceId!}
              selectedItemId={selectedItemId}
              onSelectItem={setSelectedItemId}
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {selectedItemId ? (
              <LifecycleDetailView itemId={selectedItemId} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-text-tertiary">
                Select a lifecycle item to view details
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'config' && (
        <div className="flex flex-1 overflow-hidden">
          <GateConfigView />
        </div>
      )}
    </div>
  );
}
