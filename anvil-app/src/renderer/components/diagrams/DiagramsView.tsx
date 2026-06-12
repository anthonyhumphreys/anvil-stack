import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Trash2, GitFork } from 'lucide-react';
import type { DiagramFile } from '../../../shared/types';
import { DiagramGallery } from './DiagramGallery';
import { DiagramViewer } from './DiagramViewer';
import { DiagramChat } from './DiagramChat';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { RepoSelector } from '../shared/RepoSelector';

type ViewMode = 'gallery' | 'viewer';

export function DiagramsView() {
  const { repoId: routeRepoId } = useParams<{ repoId?: string }>();
  const { repos } = useWorkspace();
  const [selectedRepoId, setSelectedRepoId] = useState<string>(routeRepoId ?? '');
  const [diagrams, setDiagrams] = useState<DiagramFile[]>([]);
  const [dirExists, setDirExists] = useState(false);
  const [selectedDiagram, setSelectedDiagram] = useState<DiagramFile | null>(null);
  const [mode, setMode] = useState<ViewMode>('gallery');
  const [initializing, setInitializing] = useState(false);

  // Set from route param
  useEffect(() => {
    if (routeRepoId) setSelectedRepoId(routeRepoId);
  }, [routeRepoId]);

  // Load diagrams when repo changes
  const loadDiagrams = useCallback(async () => {
    if (!selectedRepoId) return;
    try {
      const [list, exists] = await Promise.all([
        window.anvil.diagrams.list(selectedRepoId),
        window.anvil.diagrams.dirExists(selectedRepoId),
      ]);
      setDiagrams(list);
      setDirExists(exists);
    } catch (err) {
      console.error('Failed to load diagrams:', err);
    }
  }, [selectedRepoId]);

  useEffect(() => {
    loadDiagrams();
  }, [loadDiagrams]);

  // Re-scan on tab focus (detect external changes)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') loadDiagrams();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [loadDiagrams]);

  const handleSelectDiagram = (diagram: DiagramFile) => {
    setSelectedDiagram(diagram);
    setMode('viewer');
  };

  const handleBackToGallery = () => {
    setSelectedDiagram(null);
    setMode('gallery');
    loadDiagrams(); // re-scan on return
  };

  const handleInitialize = async () => {
    if (!selectedRepoId) return;
    setInitializing(true);
    try {
      await window.anvil.diagrams.initialize(selectedRepoId);
      await loadDiagrams();
    } catch (err) {
      console.error('Failed to initialize diagrams:', err);
    } finally {
      setInitializing(false);
    }
  };

  const handleDiagramGenerated = async (title: string, xml: string) => {
    if (!selectedRepoId) return;
    // Sanitize filename client-side
    const baseFilename = `${
      title
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'untitled'
    }.drawio`;
    // Check conflicts against current diagrams list
    let filename = baseFilename;
    let counter = 1;
    while (diagrams.some((d) => d.filename === filename)) {
      const base = baseFilename.replace('.drawio', '');
      filename = `${base}-${counter}.drawio`;
      counter++;
    }
    await window.anvil.diagrams.write(selectedRepoId, filename, xml);
    await loadDiagrams();
    // Auto-open in viewer
    const created = await window.anvil.diagrams.read(selectedRepoId, filename);
    if (created) {
      setSelectedDiagram(created);
      setMode('viewer');
    }
  };

  const handleDiagramUpdated = async (xml: string) => {
    if (!selectedRepoId || !selectedDiagram) return;
    await window.anvil.diagrams.write(selectedRepoId, selectedDiagram.filename, xml);
    const updated = await window.anvil.diagrams.read(selectedRepoId, selectedDiagram.filename);
    if (updated) setSelectedDiagram(updated);
  };

  const handleDelete = async () => {
    if (!selectedRepoId || !selectedDiagram) return;
    await window.anvil.diagrams.delete(selectedRepoId, selectedDiagram.filename);
    handleBackToGallery();
  };

  const handleOpenEditor = () => {
    if (!selectedRepoId || !selectedDiagram) return;
    window.anvil.diagrams.openEditor(selectedRepoId, selectedDiagram.filename);
  };

  const handleCreateNew = () => {
    setSelectedDiagram(null);
    setMode('gallery');
  };

  const selectedRepo = repos.find((r) => r.id === selectedRepoId);
  const hasLocalPath = selectedRepo?.path;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <GitFork size={20} className="text-accent" />
          <h1 className="text-lg font-semibold text-text-primary">Diagrams</h1>
        </div>
        {selectedRepoId && selectedRepo && (
          <span className="rounded bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">
            {selectedRepo.name}
          </span>
        )}
      </div>

      {!selectedRepoId ? (
        <div className="flex-1 overflow-auto p-6">
          <p className="mb-4 text-sm text-text-secondary">
            Select a repository to view its diagrams.
          </p>
          <RepoSelector
            selectedRepoId={null}
            onSelect={(repo) => {
              setSelectedRepoId(repo.id);
              setMode('gallery');
              setSelectedDiagram(null);
            }}
            indexedOnly={false}
            emptyMessage="No repositories found. Connect a repository first from the Repositories view."
          />
        </div>
      ) : !hasLocalPath ? (
        <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
          Diagrams require a locally cloned repository.
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Top 2/3 — Gallery or Viewer */}
          <div className="flex-[2] overflow-hidden border-b border-border">
            {mode === 'gallery' ? (
              <DiagramGallery
                diagrams={diagrams}
                dirExists={dirExists}
                onSelect={handleSelectDiagram}
                onInitialize={handleInitialize}
                onCreateNew={handleCreateNew}
                initializing={initializing}
              />
            ) : (
              <div className="flex h-full flex-col">
                {/* Viewer header */}
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleBackToGallery}
                      className="rounded p-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
                      title="Back to gallery"
                    >
                      <ArrowLeft size={16} />
                    </button>
                    <span className="text-sm font-medium text-text-primary">
                      {selectedDiagram?.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={handleOpenEditor}
                      className="rounded p-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
                      title="Open in draw.io"
                    >
                      <ExternalLink size={14} />
                    </button>
                    <button
                      onClick={handleDelete}
                      className="rounded p-1 text-text-secondary hover:bg-error/20 hover:text-error transition-colors"
                      title="Delete diagram"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {/* Viewer content */}
                <div className="flex-1">
                  {selectedDiagram && <DiagramViewer diagram={selectedDiagram} />}
                </div>
              </div>
            )}
          </div>

          {/* Bottom 1/3 — Chat */}
          <div className="flex-[1] overflow-hidden">
            <DiagramChat
              repoId={selectedRepoId}
              selectedDiagram={selectedDiagram}
              onDiagramGenerated={handleDiagramGenerated}
              onDiagramUpdated={handleDiagramUpdated}
            />
          </div>
        </div>
      )}
    </div>
  );
}
