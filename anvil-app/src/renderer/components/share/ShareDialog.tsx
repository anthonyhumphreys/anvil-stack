// Share dialog (spec §11.5): preview exactly what the recipient sees, choose
// what's included and for how long, resolve secret-scan hits, then publish.
// Publishing copies the link to the clipboard; the URL is never kept in
// renderer state or shown on screen. For an item that is already shared it
// offers Update link (same URL) alongside Share as new link.
import { AlertTriangle, Check, Link2, LoaderCircle, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  ShareOptionsInput,
  SharePreview,
  ShareRecord,
  ShareTarget,
} from '../../../shared/shares-ipc';
import { SHARE_DEFAULT_EXPIRES_DAYS } from '../../../shared/shares-ipc';
import { renderMermaid } from '../../utils/mermaid';
import { Button, ConfirmDialog, Dialog } from '../ui';
import {
  SHARE_EXPIRY_OPTIONS,
  errorMessage,
  formatShareBytes,
  isShareBehind,
  shareStatusLine,
} from './share-format';

export interface ShareDialogProps {
  target: ShareTarget;
  title: string;
  open: boolean;
  onClose: () => void;
  onShared?: (record: ShareRecord) => void;
}

type Availability = 'checking' | 'available' | 'unavailable';

const DIAGRAM_CONFIG: import('mermaid').MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'neutral',
  fontFamily: 'IBM Plex Sans, system-ui, sans-serif',
};

/** Pre-renders Mermaid/diagram artifacts so recipients see the diagram, not its source. */
async function renderDiagramSvg(target: ShareTarget): Promise<string | undefined> {
  if (target.itemType !== 'artifact') return undefined;
  try {
    const artifact = await window.anvil.surfaces.getArtifact(target.itemId);
    if (!artifact || (artifact.kind !== 'mermaid' && artifact.kind !== 'diagram')) return undefined;
    const renderId = `anvil-share-mermaid-${crypto.randomUUID()}`;
    try {
      const { svg } = await renderMermaid(renderId, artifact.content, DIAGRAM_CONFIG);
      return svg;
    } finally {
      document.getElementById(renderId)?.remove();
    }
  } catch {
    // Main falls back to showing the diagram source.
    return undefined;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ShareDialog({ target, title, open, onClose, onShared }: ShareDialogProps) {
  const headingId = useId();
  const [availability, setAvailability] = useState<Availability>('checking');
  const [existing, setExisting] = useState<ShareRecord[]>([]);
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [diagramSvg, setDiagramSvg] = useState<string | undefined>(undefined);
  const [diagramReady, setDiagramReady] = useState(false);
  const [includeComments, setIncludeComments] = useState(false);
  const [includeFullDiff, setIncludeFullDiff] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState(SHARE_DEFAULT_EXPIRES_DAYS);
  /** Finding ids the user chose NOT to redact. Everything else is redacted. */
  const [keptFindingIds, setKeptFindingIds] = useState<string[]>([]);
  const [confirmedSafe, setConfirmedSafe] = useState(false);
  const [busy, setBusy] = useState<null | 'publish' | 'update' | 'revoke' | 'copy'>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [published, setPublished] = useState<ShareRecord | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ShareRecord | null>(null);
  const previewRequest = useRef(0);

  const targetKey = `${target.itemType}:${target.itemId}`;

  // Reset per open / target.
  useEffect(() => {
    if (!open) return;
    setAvailability('checking');
    setExisting([]);
    setPreview(null);
    setPreviewError(null);
    setDiagramSvg(undefined);
    setDiagramReady(false);
    setIncludeComments(false);
    setIncludeFullDiff(false);
    setExpiresInDays(SHARE_DEFAULT_EXPIRES_DAYS);
    setKeptFindingIds([]);
    setConfirmedSafe(false);
    setActionError(null);
    setStatus(null);
    setPublished(null);
    let cancelled = false;
    void window.anvil.shares
      .available()
      .then((available) => {
        if (!cancelled) setAvailability(available ? 'available' : 'unavailable');
      })
      .catch(() => {
        if (!cancelled) setAvailability('unavailable');
      });
    void renderDiagramSvg(target).then((svg) => {
      if (cancelled) return;
      setDiagramSvg(svg);
      setDiagramReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open, targetKey]);

  const refreshExisting = useCallback(async () => {
    try {
      setExisting(await window.anvil.shares.list({ ...target }));
    } catch {
      setExisting([]);
    }
  }, [targetKey]);

  useEffect(() => {
    if (open && availability === 'available') void refreshExisting();
  }, [open, availability, refreshExisting]);

  const redactFindingIds = useMemo(
    () =>
      (preview?.secretFindings ?? [])
        .map((finding) => finding.id)
        .filter((id) => !keptFindingIds.includes(id)),
    [preview, keptFindingIds],
  );

  const options = useMemo<ShareOptionsInput>(
    () => ({
      includeComments,
      includeFullDiff,
      expiresInDays,
      ...(diagramSvg ? { diagramSvg } : {}),
    }),
    [includeComments, includeFullDiff, expiresInDays, diagramSvg],
  );

  // Preview (re-run when what's included or redacted changes).
  const keptKey = keptFindingIds.join(',');
  useEffect(() => {
    if (!open || availability !== 'available' || !diagramReady) return;
    const request = ++previewRequest.current;
    setLoadingPreview(true);
    setPreviewError(null);
    const timer = window.setTimeout(() => {
      // The first preview learns the findings; later ones apply redactions.
      const knownIds = preview?.secretFindings.map((finding) => finding.id) ?? [];
      const redact = knownIds.filter((id) => !keptFindingIds.includes(id));
      void window.anvil.shares
        .preview(target, { ...options, redactFindingIds: redact })
        .then(async (next) => {
          if (request !== previewRequest.current) return;
          const newIds = next.secretFindings
            .map((finding) => finding.id)
            .filter((id) => !knownIds.includes(id));
          if (newIds.length > 0) {
            // Default to redacting newly found secrets: re-preview with them redacted.
            const redacted = await window.anvil.shares.preview(target, {
              ...options,
              redactFindingIds: [...redact, ...newIds],
            });
            if (request !== previewRequest.current) return;
            setPreview({ ...redacted, secretFindings: next.secretFindings });
          } else {
            setPreview({ ...next, secretFindings: next.secretFindings });
          }
        })
        .catch((error: unknown) => {
          if (request === previewRequest.current) setPreviewError(errorMessage(error));
        })
        .finally(() => {
          if (request === previewRequest.current) setLoadingPreview(false);
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [open, availability, diagramReady, targetKey, options, keptKey]);

  const findings = preview?.secretFindings ?? [];
  const keptFindings = findings.filter((finding) => keptFindingIds.includes(finding.id));
  const needsConfirmation = keptFindings.length > 0 && !confirmedSafe;
  const latest = existing[0] ?? null;
  const canAct = availability === 'available' && preview !== null && !loadingPreview && !busy;

  const submitOptions = (): ShareOptionsInput => ({
    ...options,
    redactFindingIds,
    acknowledgeFindingIds: confirmedSafe ? keptFindings.map((finding) => finding.id) : [],
  });

  const handlePublish = async () => {
    setBusy('publish');
    setActionError(null);
    try {
      const { record, url } = await window.anvil.shares.publish(target, submitOptions());
      const copied =
        (await copyText(url)) || (await window.anvil.shares.copyLink(record.id).catch(() => false));
      setPublished(record);
      setStatus(copied ? 'Link copied' : 'Published. Use Copy link to copy it.');
      onShared?.(record);
      await refreshExisting();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const handleUpdate = async (record: ShareRecord) => {
    setBusy('update');
    setActionError(null);
    try {
      const updated = await window.anvil.shares.update(record.id, submitOptions());
      setStatus(`Link updated to v${updated.version}. Anyone with it now sees this version.`);
      onShared?.(updated);
      await refreshExisting();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const handleCopy = async (record: ShareRecord) => {
    setBusy('copy');
    setActionError(null);
    try {
      await window.anvil.shares.copyLink(record.id);
      setStatus('Link copied');
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const handleRevoke = async (record: ShareRecord) => {
    setBusy('revoke');
    setActionError(null);
    try {
      await window.anvil.shares.revoke(record.id);
      setStatus('Link revoked. It no longer opens.');
      if (published?.id === record.id) setPublished(null);
      await refreshExisting();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(null);
      setRevokeTarget(null);
    }
  };

  const toggleFinding = (id: string, redact: boolean) => {
    setConfirmedSafe(false);
    setKeptFindingIds((current) =>
      redact ? current.filter((value) => value !== id) : [...current, id],
    );
  };

  const dialogTitle = `Share “${title}”`;

  if (availability === 'unavailable') {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title={dialogTitle}
        size="md"
        footer={
          <Button variant="secondary" onClick={onClose} data-autofocus>
            Close
          </Button>
        }
      >
        <p className="mt-3 text-sm text-text-secondary">
          Sharing needs an Anvil sync session. Links are encrypted on this device and served by
          Anvil sync, so sign in to Anvil sync in Settings, then try again.
        </p>
      </Dialog>
    );
  }

  const primaryLabel = latest ? 'Share as new link' : 'Publish link';

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={dialogTitle}
        description="Nothing is uploaded until you publish. Anyone with the link can view it."
        size="xl"
        footer={
          published ? (
            <>
              <Button
                variant="secondary"
                onClick={() => void handleCopy(published)}
                disabled={busy !== null}
              >
                <Link2 aria-hidden className="h-4 w-4" />
                Copy link
              </Button>
              <Button onClick={onClose} data-autofocus>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={() => void handlePublish()}
                disabled={!canAct || needsConfirmation}
                aria-describedby={needsConfirmation ? `${headingId}-confirm` : undefined}
              >
                {busy === 'publish' ? (
                  <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" />
                ) : null}
                {primaryLabel}
              </Button>
            </>
          )
        }
      >
        <div className="mt-4 space-y-4">
          {latest && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm">
              <span className="text-text-primary">{shareStatusLine(latest)}</span>
              <span className="ml-auto flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void handleCopy(latest)}
                  disabled={busy !== null}
                >
                  Copy link
                </Button>
                {isShareBehind(latest) && (
                  <Button
                    size="sm"
                    onClick={() => void handleUpdate(latest)}
                    disabled={!canAct || needsConfirmation}
                  >
                    {busy === 'update' ? (
                      <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    Update link
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setRevokeTarget(latest)}
                  disabled={busy !== null}
                >
                  Revoke
                </Button>
              </span>
            </div>
          )}

          {(status || actionError) && (
            <p
              role="status"
              aria-live="polite"
              className={
                actionError
                  ? 'flex items-start gap-2 text-sm text-error'
                  : 'flex items-center gap-2 text-sm text-success'
              }
            >
              {actionError ? (
                <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <Check aria-hidden className="h-4 w-4" />
              )}
              {actionError ?? status}
            </p>
          )}

          <section aria-label="Preview">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
              <span className="font-medium text-text-secondary">What recipients see first</span>
              {preview?.interactive && (
                <span className="inline-flex items-center gap-1 rounded-md border border-accent/35 bg-accent/10 px-1.5 py-0.5 text-accent">
                  <Sparkles aria-hidden className="h-3 w-3" />
                  Interactive
                </span>
              )}
              {preview && (
                <span>
                  v{preview.version} · {formatShareBytes(preview.byteLength)}
                </span>
              )}
            </div>
            {previewError ? (
              <p className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
                {previewError}
              </p>
            ) : preview ? (
              <iframe
                // Static snapshot only: no scripts ever run in this preview.
                sandbox=""
                referrerPolicy="no-referrer"
                srcDoc={preview.previewDocument}
                title={`Preview of ${title}`}
                className={`h-72 w-full rounded-lg border border-border bg-white ${loadingPreview ? 'opacity-60' : ''}`}
              />
            ) : (
              <div className="flex h-72 items-center justify-center rounded-lg border border-border bg-bg-tertiary text-sm text-text-tertiary">
                <LoaderCircle aria-hidden className="mr-2 h-4 w-4 animate-spin" />
                Building preview…
              </div>
            )}
            {preview?.interactive && (
              <p className="mt-2 text-xs text-text-tertiary">
                Recipients see this snapshot with a warning first. They can choose to load the
                interactive version, which runs its scripts in a sandbox with no network, cookies or
                access to their account.
              </p>
            )}
          </section>

          {preview?.includes && preview.includes.length > 0 && (
            <section aria-label="What's included">
              <h3 className="text-xs font-medium text-text-secondary">What’s included</h3>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-text-secondary">
                {preview.includes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          )}

          <section aria-label="Options" className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {preview?.availableOptions?.includeComments && (
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={includeComments}
                  onChange={(event) => setIncludeComments(event.target.checked)}
                />
                Include resolved comments
              </label>
            )}
            {preview?.availableOptions?.includeFullDiff && (
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={includeFullDiff}
                  onChange={(event) => setIncludeFullDiff(event.target.checked)}
                />
                Include full diff
              </label>
            )}
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              Expires after
              <select
                value={expiresInDays}
                onChange={(event) => setExpiresInDays(Number(event.target.value))}
                className="rounded-lg border border-border bg-bg-primary px-2 py-1 text-sm text-text-primary"
              >
                {SHARE_EXPIRY_OPTIONS.map((option) => (
                  <option key={option.days} value={option.days}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </section>

          {preview?.unscanned && (
            <p className="text-xs text-text-tertiary">
              This file can’t be scanned for secrets. Check it before you publish.
            </p>
          )}

          {findings.length > 0 && (
            <section
              aria-label="Possible secrets"
              className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-3"
            >
              <h3 className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <AlertTriangle aria-hidden className="h-4 w-4 text-warning" />
                {findings.length} possible secret{findings.length === 1 ? '' : 's'} found
              </h3>
              <p className="mt-1 text-xs text-text-secondary">
                Redacted values are replaced with [redacted] before upload.
              </p>
              <ul className="mt-2 space-y-1.5">
                {findings.map((finding) => {
                  const redacted = !keptFindingIds.includes(finding.id);
                  return (
                    <li key={finding.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <label className="flex items-center gap-2 text-text-secondary">
                        <input
                          type="checkbox"
                          checked={redacted}
                          onChange={(event) => toggleFinding(finding.id, event.target.checked)}
                        />
                        Redact
                      </label>
                      <span className="text-text-primary">{finding.label}</span>
                      <code className="break-all font-mono text-xs text-text-tertiary">
                        {finding.excerpt}
                      </code>
                      {finding.occurrences && finding.occurrences > 1 ? (
                        <span className="text-xs text-text-tertiary">×{finding.occurrences}</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {keptFindings.length > 0 && (
                <label
                  id={`${headingId}-confirm`}
                  className="mt-3 flex items-start gap-2 text-sm text-text-primary"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={confirmedSafe}
                    onChange={(event) => setConfirmedSafe(event.target.checked)}
                  />
                  I’ve checked the {keptFindings.length} unredacted value
                  {keptFindings.length === 1 ? '' : 's'} and they are safe to publish.
                </label>
              )}
            </section>
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke this link?"
        description="Anyone who opens it will get nothing. You can share again later with a new link."
        confirmLabel="Revoke link"
        tone="danger"
        loading={busy === 'revoke'}
        onConfirm={() => {
          if (revokeTarget) void handleRevoke(revokeTarget);
        }}
        onCancel={() => setRevokeTarget(null)}
      />
    </>
  );
}
