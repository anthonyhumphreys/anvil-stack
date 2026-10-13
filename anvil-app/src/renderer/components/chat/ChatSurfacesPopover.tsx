import { useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Maximize2, X } from 'lucide-react';
import type { AgentUISurfaceIntent } from '../../../shared/agent-ui-intents';
import { getSurfaceKind } from '../../../shared/surfaces/registry';
import type { ChatArtifact } from '../../../shared/types';
import { ArtifactIcon, SurfaceKindIcon } from '../surfaces/surface-icons';
import { useSurfaces } from '../surfaces/surfaces-context';
import {
  readArtifactSurfaceData,
  resolveSupersedingId,
  syntheticArtifactSurfaceId,
} from '../surfaces/surface-utils';

export interface ThreadSurfaceEntry {
  id: string;
  title: string;
  kind: string;
  detail: string;
  superseded: boolean;
  artifact?: ChatArtifact;
  inTranscript: boolean;
}

/** Surfaces in transcript order, then artifacts that have no surface of their own. */
export function buildThreadSurfaceEntries(
  surfaces: readonly AgentUISurfaceIntent[],
  artifacts: readonly ChatArtifact[],
): ThreadSurfaceEntry[] {
  const coveredArtifacts = new Set<string>();
  const entries: ThreadSurfaceEntry[] = surfaces.map((surface) => {
    const artifactData =
      surface.payload.surfaceKind === 'artifact'
        ? readArtifactSurfaceData(surface.payload.data)
        : null;
    if (artifactData) coveredArtifacts.add(artifactData.artifactId);
    const label = getSurfaceKind(surface.payload.surfaceKind)?.label ?? surface.payload.surfaceKind;
    return {
      id: surface.id,
      title: surface.payload.title,
      kind: surface.payload.surfaceKind,
      detail: [
        label,
        artifactData
          ? `v${artifactData.version}`
          : surface.revision > 1
            ? `v${surface.revision}`
            : '',
      ]
        .filter(Boolean)
        .join(' · '),
      superseded: Boolean(resolveSupersedingId(surface, surfaces)),
      inTranscript: true,
    };
  });
  for (const artifact of artifacts) {
    if (coveredArtifacts.has(artifact.id)) continue;
    entries.push({
      id: syntheticArtifactSurfaceId(artifact.id),
      title: artifact.title,
      kind: 'artifact',
      detail: `Artifact · v${artifact.version}`,
      superseded: false,
      artifact,
      inTranscript: false,
    });
  }
  return entries;
}

/** Header "Surfaces (n)": every surface and artifact in the thread. */
export function ChatSurfacesPopover() {
  const { surfaces, artifacts, openStage, scrollToSurface } = useSurfaces();
  const entries = useMemo(
    () => buildThreadSurfaceEntries(surfaces, artifacts),
    [artifacts, surfaces],
  );
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnKeyDown);
    containerRef.current?.querySelector<HTMLElement>('[data-surface-entry]')?.focus();
    return () => {
      document.removeEventListener('mousedown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnKeyDown);
    };
  }, [open]);

  if (entries.length === 0) return null;

  const activate = (entry: ThreadSurfaceEntry, stage: boolean) => {
    setOpen(false);
    if ((stage || !entry.inTranscript) && openStage) {
      openStage(entry.id, { returnFocus: triggerRef.current });
      return;
    }
    scrollToSurface(entry.id);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        title="Surfaces in this thread"
      >
        <Layers size={13} aria-hidden="true" />
        <span className="hidden min-[900px]:inline">Surfaces</span>
        <span className="tabular-nums text-text-tertiary">{entries.length}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Surfaces in this thread"
          className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-border bg-bg-elevated p-1.5 shadow-2xl ring-1 ring-overlay"
        >
          <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-1">
            <h3 className="text-xs font-semibold text-text-primary">Surfaces</h3>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className="rounded-md p-1 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              aria-label="Close surfaces list"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
          <ul className="max-h-[min(60vh,420px)] overflow-y-auto">
            {entries.map((entry) => (
              <li key={entry.id} className="group flex items-center gap-1 rounded-lg">
                <button
                  type="button"
                  data-surface-entry
                  onClick={(event) => activate(entry, event.altKey)}
                  className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${entry.superseded ? 'opacity-70' : ''}`}
                  title={
                    entry.inTranscript
                      ? 'Click to scroll to it · ⌥-click to open the stage'
                      : 'Open'
                  }
                >
                  {entry.artifact ? (
                    <ArtifactIcon
                      kind={entry.artifact.kind}
                      size={14}
                      className="text-text-tertiary"
                    />
                  ) : (
                    <SurfaceKindIcon kind={entry.kind} className="text-text-tertiary" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text-primary">{entry.title}</span>
                    <span className="block truncate text-xs text-text-tertiary">
                      {entry.detail}
                      {entry.superseded ? ' · superseded' : ''}
                    </span>
                  </span>
                </button>
                {openStage && entry.inTranscript && (
                  <button
                    type="button"
                    onClick={() => activate(entry, true)}
                    className="rounded-md p-1.5 text-text-tertiary opacity-0 hover:bg-bg-tertiary hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 group-hover:opacity-100"
                    aria-label={`Open ${entry.title} on the stage`}
                  >
                    <Maximize2 size={13} aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
