import { isPermissionMode, type PermissionMode } from '../../../../cloud/contract/permissions';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Check, Copy, Laptop, Loader2, Pencil } from 'lucide-react';
import type {
  SyncConflictResolutionChoice,
  SyncDataImportFilePreview,
} from '../../../shared/sync-runtime';
import { copyTextToClipboard } from '../../utils/clipboard';
import { useSyncMeshSetup } from '../../hooks/useSyncMeshSetup';
import { SyncConnectionSetup } from '../onboard/SyncConnectionSetup';
import { DashboardAccessPanel } from './DashboardAccessPanel';
import { CloudEnvironmentsPanel } from './CloudEnvironmentsPanel';
import { CloudAgentSettingsPanel } from './CloudAgentSettingsPanel';
import { MeshExecutionsPanel } from './MeshExecutionsPanel';
import { deviceTrustSourceLabel, deviceTrustStateLabel } from './device-security-labels';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Compact one-line summary of a synced entity payload for conflict compare. */
function summarizeConflictPayload(json: string | null): string | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return '(unreadable payload)';
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '(unnamed)';
    if (Array.isArray(record.nodes) || Array.isArray(record.edges)) {
      const nodes = Array.isArray(record.nodes) ? record.nodes.length : 0;
      const edges = Array.isArray(record.edges) ? record.edges.length : 0;
      return `${name} — ${nodes} step${nodes === 1 ? '' : 's'}, ${edges} edge${edges === 1 ? '' : 's'}`;
    }
    if (Array.isArray(record.repos)) {
      return `${name} — ${record.repos.length} repo${record.repos.length === 1 ? '' : 's'}`;
    }
    if (typeof record.promptBody === 'string') {
      return `${name} — custom agent prompt`;
    }
    if (typeof record.fields === 'object' && record.fields !== null) {
      const count = Object.keys(record.fields).length;
      return `App settings — ${count} field${count === 1 ? '' : 's'}`;
    }
    return name;
  } catch {
    return '(unreadable payload)';
  }
}

/** Short localized date for entitlement timestamps; null when unparseable. */
function formatHostedDate(iso: string | null): string | null {
  if (iso === null) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function SyncMeshSettingsPanel(): ReactNode {
  const setup = useSyncMeshSetup();
  const {
    status,
    runtime,
    conflicts,
    devices,
    refresh: refreshStatus,
    refreshHostedEntitlement,
  } = setup;
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const handleMaximumMode = async (mode: PermissionMode): Promise<void> => {
    setPermissionSaving(true);
    setError(null);
    try {
      await window.anvil.syncRuntime.setMeshMaximumPermissionMode(mode);
      await refreshStatus();
    } catch (error) {
      setError(toErrorMessage(error));
    } finally {
      setPermissionSaving(false);
    }
  };
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
  const [verification, setVerification] = useState<{
    enrollmentId: string;
    code: string;
    confirmationCode: string;
  } | null>(null);
  const [deviceBusy, setDeviceBusy] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<Exclude<
    SyncDataImportFilePreview,
    { canceled: true }
  > | null>(null);
  const [committing, setCommitting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  // BILL-05: refocus (e.g. returning from the hosted account page) re-reads
  // hosted access for this view. The authoritative backend check is
  // BrowserWindow 'focus' → onAppFocus in the main process; this keeps the
  // panel's rendered snapshot in step without rerunning the whole status load.
  useEffect(() => {
    const onWindowFocus = (): void => {
      void refreshHostedEntitlement();
    };
    window.addEventListener('focus', onWindowFocus);
    return () => window.removeEventListener('focus', onWindowFocus);
  }, [refreshHostedEntitlement]);

  const handleResolve = async (
    conflictId: string,
    resolution: SyncConflictResolutionChoice,
  ): Promise<void> => {
    setError(null);
    try {
      await window.anvil.syncRuntime.resolveConflict(conflictId, resolution);
      await refreshStatus();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  const handleCopyPrompt = async (): Promise<void> => {
    setPromptLoading(true);
    setError(null);
    try {
      const text = prompt ?? (await window.anvil.syncBackend.integrationPrompt());
      setPrompt(text);
      await copyTextToClipboard(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setPromptLoading(false);
    }
  };

  const handleCopyDiagnostics = async (): Promise<void> => {
    setError(null);
    try {
      const bundle = await window.anvil.syncRuntime.diagnostics();
      await copyTextToClipboard(JSON.stringify(bundle, null, 2));
      setDiagnosticsCopied(true);
      window.setTimeout(() => setDiagnosticsCopied(false), 2000);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  const handleRenameDevice = async (enrollmentId: string): Promise<void> => {
    setDeviceBusy(enrollmentId);
    setError(null);
    try {
      await window.anvil.syncRuntime.renameDevice(enrollmentId, renameDraft.trim());
      setRenamingId(null);
      await refreshStatus();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setDeviceBusy(null);
    }
  };

  const handleRevokeDevice = async (enrollmentId: string): Promise<void> => {
    setDeviceBusy(enrollmentId);
    setError(null);
    try {
      await window.anvil.syncRuntime.revokeDevice(enrollmentId);
      setConfirmingRevokeId(null);
      await refreshStatus();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setDeviceBusy(null);
    }
  };

  const handlePrepareDeviceApproval = async (enrollmentId: string): Promise<void> => {
    if (verification?.enrollmentId === enrollmentId) {
      setVerification(null);
      return;
    }
    setDeviceBusy(enrollmentId);
    setError(null);
    try {
      const result = await window.anvil.syncRuntime.verifyDevice(enrollmentId);
      setVerification({ enrollmentId, code: result.code, confirmationCode: '' });
      setRenamingId(null);
      setConfirmingRevokeId(null);
    } catch (err) {
      setVerification(null);
      setError(toErrorMessage(err));
    } finally {
      setDeviceBusy(null);
    }
  };

  const handleApproveDevice = async (enrollmentId: string): Promise<void> => {
    if (verification?.enrollmentId !== enrollmentId) return;
    const confirmationCode = verification.confirmationCode.trim();
    if (confirmationCode !== verification.code) {
      setError('The verification codes do not match. Compare both devices, then try again.');
      return;
    }
    setDeviceBusy(enrollmentId);
    setError(null);
    try {
      await window.anvil.syncRuntime.approveDeviceTrust(enrollmentId, confirmationCode);
      setVerification(null);
      await refreshStatus();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setDeviceBusy(null);
    }
  };

  const handleExportData = async (): Promise<void> => {
    setExporting(true);
    setError(null);
    setExportResult(null);
    try {
      const result = await window.anvil.syncRuntime.exportDataToFile();
      if (result.saved) {
        setExportResult(
          `Exported ${result.entityCount} ${result.entityCount === 1 ? 'entity' : 'entities'} to ${result.filePath}`,
        );
      }
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const handleImportPreview = async (): Promise<void> => {
    setImporting(true);
    setError(null);
    setImportResult(null);
    try {
      const preview = await window.anvil.syncRuntime.previewDataImportFromFile();
      setImportPreview(preview.canceled ? null : preview);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  const handleCommitImport = async (): Promise<void> => {
    if (importPreview === null) return;
    setCommitting(true);
    setError(null);
    try {
      const result = await window.anvil.syncRuntime.commitDataImport(importPreview.operationId);
      setImportResult(
        `Imported ${result.applied} ${result.applied === 1 ? 'entity' : 'entities'} · ` +
          `${result.conflicts} arrived as conflicts · ${result.skipped} skipped`,
      );
      setImportPreview(null);
      await refreshStatus();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setCommitting(false);
    }
  };

  const hosted = runtime?.hosted ?? null;
  const fairUse = hosted?.fairUse ?? null;
  const activeDeviceCount = devices.filter(
    (device) => !device.revoked && device.enrollmentClass !== 'ephemeral',
  ).length;
  const displayError = error;

  return (
    <div className="space-y-3">
      <SyncConnectionSetup
        setup={setup}
        securityCompact={false}
        advancedContent={
          <Panel
            title="Build a compatible backend"
            description="Give an agent the protocol details for implementing a backend that Anvil can discover and verify."
          >
            <button
              type="button"
              onClick={() => void handleCopyPrompt()}
              disabled={promptLoading}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {promptLoading ? 'Loading…' : copied ? 'Copied' : 'Copy integration prompt'}
            </button>
            <textarea
              readOnly
              value={prompt ?? ''}
              placeholder="The filled prompt appears here so it can be copied manually."
              rows={10}
              spellCheck={false}
              className="w-full rounded-md border border-border bg-bg-primary p-3 font-mono text-xs leading-relaxed text-text-secondary placeholder:text-text-tertiary"
            />
          </Panel>
        }
      />

      {runtime?.auth.state === 'signed-in' && (
        <details className="rounded-lg border border-border bg-bg-secondary">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-text-primary [&::-webkit-details-marker]:hidden">
            <span>Account, devices, and browser access</span>
            <span className="text-xs font-normal text-text-tertiary">
              {devices.length} device{devices.length === 1 ? '' : 's'} · export and Mesh activity
            </span>
          </summary>
          <div className="space-y-3 border-t border-border p-3">
            {hosted !== null &&
              (hosted.restricted ||
                (fairUse !== null &&
                  fairUse.status !== 'clear' &&
                  fairUse.notice !== undefined)) && (
                <Panel
                  title="Sync service status"
                  description="Sync and Mesh are free. Service protections may temporarily pause hosted writes while leaving your local data available."
                >
                  {hosted.restricted && (
                    <div className="rounded-md border border-error/30 bg-error/5 p-2" role="status">
                      <p className="flex items-start gap-2 text-xs text-text-secondary">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-error" />
                        {hosted.reason === 'device-limit-exceeded'
                          ? 'Sync writes are paused because this account is over its configured device allowance. Revoke a device you no longer use or ask your service operator to review the limit, then retry.'
                          : 'Sync writes are paused by account or service policy. Your local changes remain on this device; you can still pull and export data, manage devices, and delete the account.'}
                      </p>
                    </div>
                  )}
                  {fairUse !== null &&
                    fairUse.status !== 'clear' &&
                    fairUse.notice !== undefined && (
                      <div
                        className={`rounded-md border p-2 ${
                          fairUse.status === 'restricted'
                            ? 'border-error/30 bg-error/5'
                            : 'border-warning/30 bg-warning/5'
                        }`}
                        role="status"
                        aria-live="polite"
                      >
                        <p className="text-xs font-medium text-text-primary">
                          {fairUse.status === 'restricted'
                            ? 'Hosted writes are restricted under fair use'
                            : 'Anvil hosted usage notice'}
                        </p>
                        <p className="mt-1 text-xs text-text-secondary">{fairUse.notice.message}</p>
                        <p className="mt-1 text-xs text-text-tertiary">
                          {fairUse.status === 'restricted'
                            ? 'This restriction is active. You can still pull and export account data, manage devices, and delete the account.'
                            : fairUse.notice.emergency
                              ? 'This notice takes effect immediately. You can still pull and export account data, manage devices, and delete the account.'
                              : `Hosted writes pause on ${formatHostedDate(fairUse.notice.restrictAt) ?? fairUse.notice.restrictAt} if this is not resolved. You can still pull and export account data, manage devices, and delete the account.`}
                        </p>
                        <p className="mt-1 text-xs text-text-tertiary">
                          Notice code: <span className="font-mono">{fairUse.notice.code}</span>
                        </p>
                      </div>
                    )}
                </Panel>
              )}

            {runtime?.auth.state === 'signed-in' && (
              <Panel
                title="Enrolled devices"
                description="Review every device on this account. Revoke lost or retired hardware to end its session immediately."
              >
                {hosted !== null && (
                  <div className="mb-3 rounded-md border border-border bg-bg-primary p-2">
                    <p className="text-xs text-text-secondary">
                      {activeDeviceCount} of {hosted.deviceLimit} configured device slots in use.
                    </p>
                    {activeDeviceCount >= hosted.deviceLimit && (
                      <p className="mt-1 text-xs text-warning" role="status">
                        {activeDeviceCount > hosted.deviceLimit
                          ? 'This account is over its configured device allowance.'
                          : 'This account has reached its configured device allowance.'}{' '}
                        Revoke a device you no longer use, or ask your service operator to review
                        the limit.
                      </p>
                    )}
                  </div>
                )}
                {devices.length === 0 ? (
                  <p className="text-sm text-text-tertiary">No devices enrolled yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {devices.map((device) => (
                      <li key={device.enrollmentId} className="rounded-md border border-border p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-2">
                            <Laptop size={15} className="mt-0.5 shrink-0 text-text-tertiary" />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-text-primary">
                                {device.displayName || `Device ${device.enrollmentId.slice(0, 8)}`}
                                {device.self && (
                                  <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-xs font-medium text-accent">
                                    This device
                                  </span>
                                )}
                                {device.revoked && (
                                  <span className="ml-2 rounded bg-error/15 px-1.5 py-0.5 text-xs font-medium text-error">
                                    Revoked
                                  </span>
                                )}
                              </p>
                              <p className="mt-0.5 font-mono text-xs text-text-tertiary">
                                {device.enrollmentId.slice(0, 12)}… · added{' '}
                                {new Date(device.createdAt).toLocaleDateString()}
                              </p>
                              {device.trustState !== undefined && (
                                <p className="mt-1 text-xs text-text-tertiary">
                                  {deviceTrustStateLabel(device.trustState)}
                                  {device.trustSource === undefined
                                    ? ''
                                    : ` · ${deviceTrustSourceLabel(device.trustSource)}`}
                                </p>
                              )}
                            </div>
                          </div>
                          {!device.revoked && (
                            <div className="flex shrink-0 items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  if (renamingId === device.enrollmentId) {
                                    setRenamingId(null);
                                  } else {
                                    setRenamingId(device.enrollmentId);
                                    setRenameDraft(device.displayName ?? '');
                                    setConfirmingRevokeId(null);
                                  }
                                }}
                                disabled={deviceBusy === device.enrollmentId}
                                aria-expanded={renamingId === device.enrollmentId}
                                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                              >
                                <Pencil size={12} />
                                Rename
                              </button>
                              {!device.self && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handlePrepareDeviceApproval(device.enrollmentId)
                                    }
                                    aria-expanded={
                                      verification?.enrollmentId === device.enrollmentId
                                    }
                                    disabled={deviceBusy === device.enrollmentId}
                                    className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                                  >
                                    {deviceBusy === device.enrollmentId
                                      ? 'Preparing…'
                                      : 'Compare & verify'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setConfirmingRevokeId(
                                        confirmingRevokeId === device.enrollmentId
                                          ? null
                                          : device.enrollmentId,
                                      )
                                    }
                                    aria-expanded={confirmingRevokeId === device.enrollmentId}
                                    disabled={deviceBusy === device.enrollmentId}
                                    className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-error disabled:opacity-50"
                                  >
                                    Revoke
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                        {renamingId === device.enrollmentId && (
                          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                            <input
                              value={renameDraft}
                              onChange={(event) => setRenameDraft(event.target.value)}
                              placeholder="Device name (empty clears it)"
                              aria-label="Device name"
                              spellCheck={false}
                              className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary"
                            />
                            <div className="flex shrink-0 gap-1.5">
                              <button
                                type="button"
                                onClick={() => void handleRenameDevice(device.enrollmentId)}
                                disabled={deviceBusy === device.enrollmentId}
                                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
                              >
                                {deviceBusy === device.enrollmentId ? 'Saving…' : 'Save'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setRenamingId(null)}
                                className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                        {verification?.enrollmentId === device.enrollmentId && (
                          <div className="mt-2 rounded-md border border-border bg-bg-primary p-2">
                            <p className="font-mono text-lg tracking-[0.2em] text-text-primary">
                              {verification.code}
                            </p>
                            <p className="mt-1 text-xs text-text-tertiary">
                              Compare this code on both devices and confirm it matches on each
                              device. You are verifying{' '}
                              <span className="font-medium text-text-secondary">
                                {device.displayName || `device ${device.enrollmentId.slice(0, 8)}`}
                              </span>
                              . Revoked devices cannot be verified here.
                            </p>
                            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                              <input
                                value={verification.confirmationCode}
                                onChange={(event) =>
                                  setVerification((current) =>
                                    current === null
                                      ? current
                                      : { ...current, confirmationCode: event.target.value },
                                  )
                                }
                                inputMode="numeric"
                                placeholder="Code shown on the other device"
                                aria-label="Verification code shown on the other device"
                                spellCheck={false}
                                className="min-w-0 flex-1 rounded-md border border-border bg-bg-secondary px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-tertiary"
                              />
                              <button
                                type="button"
                                onClick={() => void handleApproveDevice(device.enrollmentId)}
                                disabled={
                                  deviceBusy === device.enrollmentId ||
                                  verification.confirmationCode.trim() === ''
                                }
                                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground disabled:opacity-50"
                              >
                                {deviceBusy === device.enrollmentId
                                  ? 'Confirming…'
                                  : 'Confirm matching code'}
                              </button>
                            </div>
                          </div>
                        )}
                        {confirmingRevokeId === device.enrollmentId && (
                          <div className="mt-2 rounded-md border border-error/30 bg-error/5 p-2">
                            <p className="text-xs text-text-secondary">
                              Revoke{' '}
                              <span className="font-medium text-text-primary">
                                {device.displayName || `device ${device.enrollmentId.slice(0, 8)}`}
                              </span>
                              ? Its session stops working immediately and it must re-enroll.
                            </p>
                            <div className="mt-2 flex gap-1.5">
                              <button
                                type="button"
                                onClick={() => void handleRevokeDevice(device.enrollmentId)}
                                disabled={deviceBusy === device.enrollmentId}
                                className="rounded-md border border-error/50 bg-error/10 px-3 py-1 text-xs font-medium text-error transition-colors hover:bg-error/20 disabled:opacity-50"
                              >
                                {deviceBusy === device.enrollmentId ? 'Revoking…' : 'Revoke device'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmingRevokeId(null)}
                                className="rounded-md border border-border px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            )}

            {runtime?.auth.state === 'signed-in' && status?.state === 'active' && (
              <Panel
                title="Browser dashboard access"
                description="Browsers never join the mesh or hold an account key. A web session asks for specific capabilities, you approve a subset here, and it receives only encrypted projections."
              >
                <DashboardAccessPanel />
              </Panel>
            )}

            {runtime?.auth.state === 'signed-in' && (
              <Panel
                title="Export and import"
                description="Move synced entities between accounts. Imports never overwrite silently; differences arrive as conflicts for review."
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleExportData()}
                    disabled={exporting}
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                  >
                    {exporting && (
                      <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
                    )}
                    {exporting ? 'Exporting…' : 'Export account data'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleImportPreview()}
                    disabled={importing}
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                  >
                    {importing && (
                      <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
                    )}
                    {importing ? 'Reading file…' : 'Import from file'}
                  </button>
                </div>
                {exportResult !== null && (
                  <p aria-live="polite" className="text-xs text-text-tertiary">
                    {exportResult}
                  </p>
                )}
                {importResult !== null && (
                  <p aria-live="polite" className="text-xs text-text-tertiary">
                    {importResult}
                  </p>
                )}
                {importPreview !== null && (
                  <div className="space-y-2 rounded-md border border-border bg-bg-primary p-3">
                    <p className="text-sm text-text-secondary">
                      <span className="font-medium text-text-primary">
                        {importPreview.fileName}
                      </span>
                      : {importPreview.summary.creates} new · {importPreview.summary.identical}{' '}
                      unchanged · {importPreview.summary.conflicts} conflict
                      {importPreview.summary.conflicts === 1 ? '' : 's'} ·{' '}
                      {importPreview.summary.invalid} invalid
                      {importPreview.truncated ? ' (details truncated)' : ''}
                    </p>
                    {importPreview.entries.filter((e) => e.outcome === 'conflict').length > 0 && (
                      <ul className="list-inside list-disc text-xs text-text-tertiary">
                        {importPreview.entries
                          .filter((e) => e.outcome === 'conflict')
                          .slice(0, 5)
                          .map((entry) => (
                            <li key={`${entry.entityType}:${entry.entityId}`}>
                              {entry.entityType} {entry.entityId.slice(0, 8)}…
                              {entry.reason ? ` — ${entry.reason}` : ''}
                            </li>
                          ))}
                      </ul>
                    )}
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handleCommitImport()}
                        disabled={committing}
                        className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
                      >
                        {committing ? 'Importing…' : 'Apply import'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setImportPreview(null)}
                        className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </Panel>
            )}

            {runtime?.auth.state === 'signed-in' && status?.state === 'active' && (
              <Panel
                title="Mesh jobs"
                description="Jobs dispatched to enrolled devices. Lost contact means the outcome is unknown, so it is never shown as cancelled."
              >
                <MeshExecutionsPanel
                  localWorkerIncarnation={runtime.meshWorker.workerIncarnation}
                />
              </Panel>
            )}

            {runtime?.auth.state === 'signed-in' && runtime.syncEnabled && (
              <Panel
                title="Mesh execution permissions"
                description="Limit the access jobs can use on this device. This setting does not turn Mesh on."
              >
                <label className="block text-sm text-text-secondary">
                  Maximum permission for this device
                  <select
                    className="mt-1 block w-full rounded-md border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary"
                    value={runtime.meshWorker.maxPermissionMode ?? 'on-request'}
                    disabled={permissionSaving}
                    onChange={(event) => {
                      if (isPermissionMode(event.target.value))
                        void handleMaximumMode(event.target.value);
                    }}
                  >
                    <option value="read-only">Read only</option>
                    <option value="on-request">Ask for extra access</option>
                    <option value="workspace-auto">Auto in workspace</option>
                    <option value="full-access">Full access</option>
                  </select>
                </label>
                <p className="mt-1 text-xs text-text-tertiary">
                  Jobs can use their selected mode only up to this limit. Lowering the limit stops
                  active jobs. Cloud Agents access is controlled separately.
                </p>
              </Panel>
            )}
          </div>
        </details>
      )}

      {runtime?.auth.state === 'signed-in' && (
        <Panel
          title="Sync activity"
          description="Current status for this device's encrypted Sync connection."
        >
          {runtime?.syncEnabled === true ? (
            <div className="space-y-2">
              <p className="text-sm text-text-secondary">
                {runtime.connectionState === 'live'
                  ? 'The live connection is up.'
                  : runtime.connectionState === 'connecting'
                    ? 'Connecting. Local changes will queue safely.'
                    : 'Live updates are unavailable. Anvil will keep retrying.'}
              </p>
              <p className="text-xs text-text-tertiary">
                {runtime.pendingCount} pending · {runtime.conflictCount} conflict
                {runtime.conflictCount === 1 ? '' : 's'} · last pull {runtime.lastPullAt ?? 'never'}
              </p>
              {runtime.rejectedCount > 0 && (
                <p className="text-xs text-warning">
                  {runtime.quotaExceeded
                    ? 'The account history quota is full. Local edits stay queued here until space is available.'
                    : `${runtime.rejectedCount} change${runtime.rejectedCount === 1 ? '' : 's'} need attention.`}
                </p>
              )}
              {runtime.recovering === true && (
                <p className="text-xs text-warning">
                  Anvil is rebuilding this device's view of the account.
                </p>
              )}
              {runtime.sessionExpired === true && (
                <p className="text-xs text-error">
                  This device's session expired. Sign in again to resume Sync.
                </p>
              )}
              {runtime.lastError && <p className="text-xs text-error">{runtime.lastError}</p>}
            </div>
          ) : (
            <p className="text-sm text-text-tertiary">
              Sync is off. Local work stays on this device.
            </p>
          )}
          <button
            type="button"
            onClick={() => void handleCopyDiagnostics()}
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary"
          >
            {diagnosticsCopied ? 'Diagnostics copied' : 'Copy diagnostics'}
          </button>
        </Panel>
      )}

      {runtime?.auth.state === 'signed-in' && conflicts.length > 0 && (
        <Panel
          title="Conflicts"
          description="Both devices touched the same template. Compare the versions, then pick a side — or keep both."
        >
          <ul className="space-y-3">
            {conflicts.map((conflict) => (
              <li key={conflict.id} className="rounded-md border border-border p-3">
                <p className="text-sm text-text-primary">
                  {conflict.localLabel ?? conflict.entityId}
                </p>
                <p className="text-xs text-text-tertiary">
                  {conflict.kind === 'edit-delete'
                    ? 'One side edited while the other deleted it — this needs an explicit choice.'
                    : 'Both sides edited the same entity.'}
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-text-tertiary hover:text-text-secondary">
                    Compare versions
                  </summary>
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-text-tertiary">Local</dt>
                    <dd className="text-text-secondary">
                      {summarizeConflictPayload(conflict.localPayloadJson) ?? 'deleted locally'}
                    </dd>
                    <dt className="text-text-tertiary">Remote</dt>
                    <dd className="text-text-secondary">
                      {summarizeConflictPayload(conflict.remotePayloadJson) ?? 'deleted remotely'}
                    </dd>
                  </dl>
                </details>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleResolve(conflict.id, 'keep-local')}
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                  >
                    Keep local
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleResolve(conflict.id, 'use-remote')}
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                  >
                    Use remote
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleResolve(conflict.id, 'save-copy')}
                    title="Apply the remote version and keep your local version as a new template"
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                  >
                    Save a copy
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {runtime?.auth.state === 'signed-in' && status?.state === 'active' && (
        <CloudEnvironmentsPanel onError={setError} />
      )}

      <Panel
        title="Cloud agents"
        description="Choose providers available to Anvil Cloud Agents and your own cloud machines."
      >
        <CloudAgentSettingsPanel />
      </Panel>

      {displayError && (
        <p className="flex items-start gap-2 rounded-md border border-error/30 bg-error/5 p-3 text-sm text-error">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          {displayError}
        </p>
      )}
    </div>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="space-y-4 rounded-lg border border-border bg-bg-secondary p-5">
      <div>
        <h4 className="text-base font-semibold text-text-primary">{title}</h4>
        {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
      </div>
      {children}
    </section>
  );
}
