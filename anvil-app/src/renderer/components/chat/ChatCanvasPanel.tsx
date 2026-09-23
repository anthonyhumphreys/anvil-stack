import { useCallback, useEffect, useState } from 'react';
import {
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Code,
  Copy,
  Database,
  ExternalLink,
  Eye,
  FileText,
  Link2,
  Link2Off,
  ListChecks,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  PictureInPicture2,
  Plus,
  Target,
  Trash2,
} from 'lucide-react';
import type { AgentUIPlanIntent } from '../../../shared/agent-ui-intents';
import type {
  ChatArtifact,
  ChatGoalSnapshot,
  ChatPlanSnapshot,
  ChatPlanStep,
} from '../../../shared/types';
import { ConfirmDialog } from '../ui';
import { PlanIntentSurface } from './AgentUIIntentSurface';
import { ArtifactAnnotationsPanel } from './ArtifactAnnotationsPanel';
import { ArtifactPreview } from './ArtifactPreview';
import { clampCanvasZoom, formatGoalStatus } from './chat-view-utils';

/**
 * Canvas panel — extracted from ChatView (Phase 5 split). Renders artifacts
 * (preview/source, zoom, share, discard) plus the goal/plan context section.
 * Destructive artifact actions go through ConfirmDialog (CH12 sweep).
 */
export function ChatCanvasSidebar({
  artifacts,
  selectedArtifact,
  activePlan,
  planIntents,
  activeGoal,
  planSelected,
  onSelectPlan,
  onSelectArtifact,
  onDiscardArtifact,
  onShareArtifact,
  onUnshareArtifact,
  zoom,
  onZoomChange,
  presentation,
  onExpand,
  onDetach,
}: {
  artifacts: ChatArtifact[];
  selectedArtifact: ChatArtifact | null;
  activePlan: ChatPlanSnapshot | null;
  planIntents: AgentUIPlanIntent[];
  activeGoal: ChatGoalSnapshot | null;
  planSelected: boolean;
  onSelectPlan: () => void;
  onSelectArtifact: (artifactId: string) => void;
  onDiscardArtifact: (artifactId: string) => Promise<void>;
  onShareArtifact: (artifactId: string) => Promise<ChatArtifact>;
  onUnshareArtifact: (artifactId: string) => Promise<ChatArtifact>;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  presentation: 'sidebar' | 'expanded' | 'detached';
  onExpand: () => void;
  onDetach: () => void;
}) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [copied, setCopied] = useState(false);
  const [planOpen, setPlanOpen] = useState(!selectedArtifact && Boolean(activePlan));
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmUnshare, setConfirmUnshare] = useState(false);

  useEffect(() => {
    if (!selectedArtifact && activePlan) setPlanOpen(true);
  }, [activePlan, selectedArtifact]);

  useEffect(() => {
    setConfirmDiscard(false);
    setConfirmUnshare(false);
  }, [selectedArtifact?.id]);

  const handleCopy = useCallback(() => {
    if (!selectedArtifact) return;
    void navigator.clipboard.writeText(selectedArtifact.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }, [selectedArtifact]);

  const handleDiscard = useCallback(() => {
    if (!selectedArtifact || selectedArtifact.storage !== 'session') return;
    void onDiscardArtifact(selectedArtifact.id);
  }, [onDiscardArtifact, selectedArtifact]);

  const [sharingAvailable, setSharingAvailable] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.anvil.chat
      .artifactSharingAvailable()
      .then((available) => {
        if (!cancelled) setSharingAvailable(available);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleShare = useCallback(() => {
    if (!selectedArtifact || shareBusy) return;
    setShareBusy(true);
    setShareError(null);
    void onShareArtifact(selectedArtifact.id)
      .then((updated) => {
        if (updated.sharedUrl) {
          void navigator.clipboard.writeText(updated.sharedUrl).then(() => {
            setShareLinkCopied(true);
            window.setTimeout(() => setShareLinkCopied(false), 1400);
          });
        }
      })
      .catch((err: unknown) => {
        setShareError(err instanceof Error ? err.message : 'Share failed');
      })
      .finally(() => setShareBusy(false));
  }, [onShareArtifact, selectedArtifact, shareBusy]);

  const handleUnshare = useCallback(() => {
    if (!selectedArtifact || shareBusy) return;
    setShareBusy(true);
    setShareError(null);
    void onUnshareArtifact(selectedArtifact.id)
      .catch((err: unknown) => {
        setShareError(err instanceof Error ? err.message : 'Unshare failed');
      })
      .finally(() => setShareBusy(false));
  }, [onUnshareArtifact, selectedArtifact, shareBusy]);

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col ${
        presentation === 'expanded' ? 'bg-bg-primary' : ''
      }`}
    >
      <div
        className={`border-b border-border/60 ${
          presentation === 'expanded' ? 'px-5 py-3.5' : 'px-3 py-2.5'
        }`}
      >
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent">
            <Braces size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-text-primary">
              {presentation === 'expanded' ? 'Canvas workspace' : 'Canvas'}
            </h3>
            <p className="truncate text-xs text-text-tertiary">
              {artifacts.length > 0
                ? `${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`
                : planIntents.length > 0
                  ? `${planIntents.length} plan${planIntents.length === 1 ? '' : 's'}`
                  : 'Goal context'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {planIntents.length === 0 && activePlan && (
              <button
                type="button"
                onClick={() => setPlanOpen((open) => !open)}
                className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${
                  planOpen
                    ? 'bg-info/10 text-info'
                    : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
                aria-pressed={planOpen}
                title={planOpen ? 'Hide implementation plan' : 'Show implementation plan'}
              >
                <ListChecks size={13} />
                <span>
                  Plan {activePlan.steps.filter((step) => step.status === 'completed').length}/
                  {activePlan.steps.length}
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={onExpand}
              className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              title={presentation === 'sidebar' ? 'Expand canvas' : 'Reattach canvas'}
              aria-label={presentation === 'sidebar' ? 'Expand canvas' : 'Reattach canvas'}
            >
              {presentation === 'sidebar' ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
            </button>
            {presentation !== 'detached' && (
              <button
                type="button"
                onClick={onDetach}
                className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                title="Detach canvas"
                aria-label="Detach canvas"
              >
                <PictureInPicture2 size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {(artifacts.length > 0 || planIntents.length > 0) && (
        <div className="border-b border-border/60 p-2">
          <div className="flex gap-1 overflow-x-auto pb-1">
            {planIntents.length > 0 && (
              <button
                type="button"
                onClick={onSelectPlan}
                className={`flex max-w-48 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
                  planSelected
                    ? 'border-info/35 bg-info/10 text-info'
                    : 'border-border bg-bg-primary/60 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
              >
                <ListChecks size={13} />
                <span className="truncate">Plans</span>
                <span className="shrink-0 text-eyebrow opacity-70">{planIntents.length}</span>
              </button>
            )}
            {artifacts.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                onClick={() => onSelectArtifact(artifact.id)}
                className={`flex max-w-48 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
                  !planSelected && selectedArtifact?.id === artifact.id
                    ? 'border-accent/35 bg-accent/10 text-accent'
                    : 'border-border bg-bg-primary/60 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
                title={artifact.title}
              >
                <ArtifactIcon kind={artifact.kind} />
                <span className="truncate">{artifact.title}</span>
                <span className="shrink-0 text-eyebrow opacity-70">v{artifact.version}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!planSelected && selectedArtifact ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-border/60 px-3 py-2">
            <div className="flex items-start gap-2">
              <ArtifactIcon kind={selectedArtifact.kind} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-primary">
                  {selectedArtifact.title}
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-text-tertiary">
                  {selectedArtifact.storage === 'session'
                    ? `Session only · ${selectedArtifact.relativePath}`
                    : (selectedArtifact.filePath ??
                      `.anvil/artifacts/${selectedArtifact.relativePath}`)}
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <ArtifactMetaChip
                    label={selectedArtifact.storage === 'session' ? 'throwaway' : 'repository'}
                  />
                  <ArtifactMetaChip label={selectedArtifact.status} />
                  <ArtifactMetaChip label={selectedArtifact.visibility} />
                  <ArtifactMetaChip label={selectedArtifact.source} />
                  {selectedArtifact.model && <ArtifactMetaChip label={selectedArtifact.model} />}
                  {selectedArtifact.reasoningEffort && (
                    <ArtifactMetaChip label={selectedArtifact.reasoningEffort} />
                  )}
                  {selectedArtifact.sharedUrl && <ArtifactMetaChip label="shared" />}
                  {shareError && <span className="text-xs text-error">{shareError}</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onZoomChange(clampCanvasZoom(zoom - 10))}
                  disabled={zoom <= 50}
                  className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-35"
                  title="Zoom out"
                  aria-label="Zoom canvas out"
                >
                  <Minus size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => onZoomChange(100)}
                  className="min-w-11 rounded-md px-1.5 py-1 text-xs font-medium tabular-nums text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                  title="Reset canvas zoom"
                  aria-label={`Reset canvas zoom, currently ${zoom}%`}
                >
                  {zoom}%
                </button>
                <button
                  type="button"
                  onClick={() => onZoomChange(clampCanvasZoom(zoom + 10))}
                  disabled={zoom >= 200}
                  className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-35"
                  title="Zoom in"
                  aria-label="Zoom canvas in"
                >
                  <Plus size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setMode('preview')}
                  className={`rounded-md p-1.5 transition-colors ${
                    mode === 'preview'
                      ? 'bg-accent/10 text-accent'
                      : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
                  }`}
                  title="Preview"
                  aria-label="Preview artifact"
                  aria-pressed={mode === 'preview'}
                >
                  <Eye size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setMode('source')}
                  className={`rounded-md p-1.5 transition-colors ${
                    mode === 'source'
                      ? 'bg-accent/10 text-accent'
                      : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
                  }`}
                  title="Source"
                  aria-label="View artifact source"
                  aria-pressed={mode === 'source'}
                >
                  <Code size={13} />
                </button>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                  title={copied ? 'Copied' : 'Copy artifact'}
                  aria-label={copied ? 'Copied artifact' : 'Copy artifact'}
                >
                  {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                </button>
                {sharingAvailable && !selectedArtifact.sharedUrl && (
                  <button
                    type="button"
                    onClick={handleShare}
                    disabled={shareBusy}
                    className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-35"
                    title="Share artifact — creates a public link and copies it"
                    aria-label="Share artifact"
                  >
                    <Link2 size={13} />
                  </button>
                )}
                {selectedArtifact.sharedUrl && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(selectedArtifact.sharedUrl as string)
                          .then(() => {
                            setShareLinkCopied(true);
                            window.setTimeout(() => setShareLinkCopied(false), 1400);
                          })
                      }
                      className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                      title={
                        shareLinkCopied
                          ? 'Copied'
                          : `Copy share link: ${selectedArtifact.sharedUrl}`
                      }
                      aria-label={shareLinkCopied ? 'Copied share link' : 'Copy share link'}
                    >
                      {shareLinkCopied ? (
                        <Check size={13} className="text-success" />
                      ) : (
                        <Link2 size={13} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmUnshare(true)}
                      disabled={shareBusy}
                      className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-error/10 hover:text-error disabled:opacity-35"
                      title="Stop sharing — revokes the public link"
                      aria-label="Stop sharing artifact"
                    >
                      <Link2Off size={13} />
                    </button>
                  </>
                )}
                {selectedArtifact.filePath && (
                  <button
                    type="button"
                    onClick={() => window.open(`file://${selectedArtifact.filePath}`, '_blank')}
                    className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                    title="Open artifact file"
                    aria-label="Open artifact file"
                  >
                    <ExternalLink size={13} />
                  </button>
                )}
                {selectedArtifact.storage === 'session' && (
                  <button
                    type="button"
                    onClick={() => setConfirmDiscard(true)}
                    className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-error/10 hover:text-error"
                    title="Discard session-only artifact"
                    aria-label="Discard session-only artifact"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          </div>

          <div
            className="min-h-0 flex-1 overflow-auto bg-bg-primary/40"
            onWheel={(event) => {
              if (!event.metaKey && !event.ctrlKey) return;
              event.preventDefault();
              onZoomChange(clampCanvasZoom(zoom + (event.deltaY > 0 ? -10 : 10)));
            }}
          >
            <div
              className="min-h-full origin-top-left"
              style={{ zoom: zoom / 100, width: `${10_000 / zoom}%` }}
            >
              <ArtifactBody artifact={selectedArtifact} mode={mode} />
            </div>
          </div>
          <ArtifactAnnotationsPanel artifact={selectedArtifact} />
        </div>
      ) : (
        <PlanGoalSidebar
          activePlan={activePlan}
          planIntents={planIntents}
          activeGoal={activeGoal}
          planOpen={planOpen}
          onPlanOpenChange={setPlanOpen}
        />
      )}

      {selectedArtifact && (activeGoal || planIntents.length > 0 || (activePlan && planOpen)) && (
        <div className="max-h-60 overflow-auto border-t border-border/60">
          <PlanGoalSidebar
            activePlan={activePlan}
            planIntents={planIntents}
            activeGoal={activeGoal}
            planOpen={planOpen}
            onPlanOpenChange={setPlanOpen}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirmDiscard}
        title={`Discard “${selectedArtifact?.title ?? 'artifact'}”?`}
        description="This session-only artifact is not saved to the repository and will be removed."
        confirmLabel="Discard artifact"
        tone="danger"
        onConfirm={() => {
          setConfirmDiscard(false);
          handleDiscard();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
      <ConfirmDialog
        open={confirmUnshare}
        title={`Stop sharing “${selectedArtifact?.title ?? 'artifact'}”?`}
        description="The public link will stop working for anyone who has it."
        confirmLabel="Stop sharing"
        tone="danger"
        onConfirm={() => {
          setConfirmUnshare(false);
          handleUnshare();
        }}
        onCancel={() => setConfirmUnshare(false)}
      />
    </div>
  );
}

function ArtifactIcon({ kind }: { kind: ChatArtifact['kind'] }) {
  if (kind === 'markdown' || kind === 'text' || kind === 'docx' || kind === 'pdf') {
    return <FileText size={13} className="shrink-0" />;
  }
  if (kind === 'html' || kind === 'pptx') return <Eye size={13} className="shrink-0" />;
  if (kind === 'csv' || kind === 'xlsx') return <Database size={13} className="shrink-0" />;
  return <Braces size={13} className="shrink-0" />;
}

function ArtifactMetaChip({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-border-subtle bg-bg-primary px-1.5 py-0.5 text-eyebrow font-medium text-text-tertiary">
      {label}
    </span>
  );
}

function ArtifactBody({ artifact, mode }: { artifact: ChatArtifact; mode: 'preview' | 'source' }) {
  return <ArtifactPreview artifact={artifact} mode={mode} />;
}

function PlanGoalSidebar({
  activePlan,
  planIntents,
  activeGoal,
  planOpen = true,
  onPlanOpenChange,
}: {
  activePlan: ChatPlanSnapshot | null;
  planIntents: AgentUIPlanIntent[];
  activeGoal: ChatGoalSnapshot | null;
  planOpen?: boolean;
  onPlanOpenChange?: (open: boolean) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      {activeGoal && (
        <section className="mb-3 rounded-xl border border-success/20 bg-success/5 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Target size={14} className="text-success" />
            Goal
            <span className="ml-auto rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
              {formatGoalStatus(activeGoal.status)}
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">{activeGoal.objective}</p>
          <p className="mt-2 text-xs text-text-tertiary">
            {activeGoal.tokensUsed.toLocaleString()} tokens
            {activeGoal.tokenBudget ? ` / ${activeGoal.tokenBudget.toLocaleString()}` : ''} used
          </p>
        </section>
      )}

      {planIntents.map((intent) => (
        <PlanIntentSurface key={intent.id} intent={intent} mode="canvas" />
      ))}

      {planIntents.length === 0 && activePlan && (
        <section className="rounded-xl border border-info/20 bg-info/5">
          <button
            type="button"
            onClick={() => onPlanOpenChange?.(!planOpen)}
            className={`w-full p-3 text-left transition-colors hover:bg-info/5 ${
              planOpen ? 'border-b border-info/15' : ''
            }`}
            aria-expanded={planOpen}
          >
            <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <ListChecks size={14} className="text-info" />
              Implementation Plan
              <span className="ml-auto text-xs text-text-tertiary">
                {activePlan.steps.filter((step) => step.status === 'completed').length}/
                {activePlan.steps.length}
              </span>
              {planOpen ? (
                <ChevronDown size={13} className="text-text-tertiary" />
              ) : (
                <ChevronRight size={13} className="text-text-tertiary" />
              )}
            </span>
          </button>
          {planOpen && activePlan.explanation && (
            <p className="border-b border-info/15 px-3 pb-3 text-xs leading-relaxed text-text-secondary">
              {activePlan.explanation}
            </p>
          )}
          {planOpen && (
            <ol className="space-y-2 p-3">
              {activePlan.steps.map((step, index) => (
                <li key={`${index}-${step.step}`} className="flex items-start gap-2 text-sm">
                  <SidebarPlanStepIcon status={step.status} />
                  <span
                    className={
                      step.status === 'completed'
                        ? 'text-text-tertiary line-through'
                        : 'text-text-secondary'
                    }
                  >
                    {step.step}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}

function SidebarPlanStepIcon({ status }: { status: ChatPlanStep['status'] }) {
  if (status === 'completed') {
    return <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />;
  }
  if (status === 'in_progress') {
    return <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-info" />;
  }
  return <Circle size={14} className="mt-0.5 shrink-0 text-text-tertiary" />;
}
