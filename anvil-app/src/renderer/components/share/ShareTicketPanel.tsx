import { AlertTriangle, Check, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { WorkItemReference } from '../../../shared/change-review-types';
import type { ShareTicketPreview, ShareTicketReceipt } from '../../../shared/share-ticket';
import type { ShareRecord } from '../../../shared/shares-ipc';
import type { WorkItemConnection, WorkItemProvider } from '../../../shared/types';
import { normalizeGitHubIssueUrl } from '../../utils/github-workitem-reference';
import { Button } from '../ui';

export interface ShareTicketPanelProps {
  record: ShareRecord;
  suggestedTicket?: { id: string; provider: WorkItemProvider };
}

function safeError(error: unknown): string {
  if (error instanceof Error && /uncertain|pending/i.test(error.message))
    return 'The publication outcome is uncertain. Check the ticket before taking any further action.';
  return 'Could not prepare or attach the share to this ticket. Try previewing again.';
}

export function ShareTicketPanel({ record, suggestedTicket }: ShareTicketPanelProps) {
  const [connections, setConnections] = useState<WorkItemConnection[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [ticketId, setTicketId] = useState(suggestedTicket?.id ?? '');
  const [preview, setPreview] = useState<ShareTicketPreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'attach' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ShareTicketReceipt | null>(null);
  const [uncertain, setUncertain] = useState(false);

  useEffect(() => {
    let current = true;
    setLoadingConnections(true);
    window.anvil.settings
      .get()
      .then((settings) => {
        if (!current) return;
        const configured = settings.workItemConnections ?? [];
        const matchingSuggestion = suggestedTicket
          ? configured.filter((connection) => connection.provider === suggestedTicket.provider)
          : configured;
        setConnections(configured);
        setConnectionId(matchingSuggestion.length === 1 ? matchingSuggestion[0].id : '');
        setConnectionError(null);
      })
      .catch(() => {
        if (current) setConnectionError('Could not load configured Work Item connections.');
      })
      .finally(() => {
        if (current) setLoadingConnections(false);
      });
    return () => {
      current = false;
    };
  }, [record.id, suggestedTicket?.provider]);

  const selectedConnection = useMemo(
    () => connections.find((connection) => connection.id === connectionId),
    [connections, connectionId],
  );
  const referenceId = selectedConnection
    ? selectedConnection.provider === 'github'
      ? normalizeGitHubIssueUrl(ticketId, selectedConnection)
      : ticketId.trim()
    : undefined;
  const reference: WorkItemReference | null =
    selectedConnection && referenceId
      ? {
          connectionId: selectedConnection.id,
          provider: selectedConnection.provider,
          id: referenceId,
        }
      : null;

  const resetReview = (clearUncertain = true) => {
    setPreview(null);
    setReviewed(false);
    setReceipt(null);
    setError(null);
    if (clearUncertain) setUncertain(false);
  };

  const previewTicket = async () => {
    if (!reference) return;
    setBusy('preview');
    setError(null);
    resetReview(false);
    try {
      const result = await window.anvil.shares.previewTicket(record.id, reference);
      setPreview(result);
    } catch (cause) {
      setError(safeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const attachTicket = async () => {
    if (!reference || !preview || !reviewed) return;
    setBusy('attach');
    setError(null);
    try {
      const result = await window.anvil.shares.attachTicket(record.id, reference);
      setReceipt(result);
      if (result.status === 'uncertain') {
        setUncertain(true);
        setError(
          'The publication outcome is uncertain. Check the ticket before taking any further action.',
        );
      }
    } catch (cause) {
      if (cause instanceof Error && /uncertain|pending/i.test(cause.message)) setUncertain(true);
      setError(safeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const disabled = loadingConnections || Boolean(connectionError) || busy !== null;
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-bg-secondary p-4"
      aria-label="Attach share to ticket"
    >
      <div>
        <h3 className="text-sm font-semibold text-text-primary">Attach to ticket</h3>
        <p className="mt-1 text-xs text-text-tertiary">
          Add a comment with the shared thread link to a GitHub issue, Linear, Jira, or Azure DevOps ticket.
        </p>
      </div>

      {connectionError ? <p className="text-sm text-error">{connectionError}</p> : null}
      {!connectionError && !loadingConnections && connections.length === 0 ? (
        <p className="text-sm text-text-tertiary">
          No matching Work Item connections are configured.
        </p>
      ) : null}

      {connections.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium text-text-secondary">
            Work Item connection
            <select
              className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              value={connectionId}
              disabled={disabled}
              onChange={(event) => {
                setConnectionId(event.target.value);
                resetReview();
              }}
            >
              <option value="">Choose a connection</option>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name} ·{' '}
                  {connection.provider === 'ado'
                    ? 'Azure DevOps'
                    : connection.provider === 'github'
                      ? 'GitHub Issues'
                      : connection.provider}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium text-text-secondary">
            {selectedConnection?.provider === 'github' ? 'GitHub issue URL' : 'Ticket ID'}
            <input
              className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
              value={ticketId}
              disabled={disabled}
              placeholder={
                selectedConnection?.provider === 'github'
                  ? 'https://github.com/owner/repo/issues/123'
                  : 'e.g. APP-123'
              }
              onChange={(event) => {
                setTicketId(event.target.value);
                resetReview();
              }}
            />
            {selectedConnection?.provider === 'github' ? (
              <span className="text-xs font-normal text-text-tertiary sm:col-start-2">
                Paste the full issue URL so the connection can identify the repository and issue.
              </span>
            ) : null}
          </label>
        </div>
      ) : null}

      {connections.length > 0 ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || !reference}
          onClick={() => void previewTicket()}
        >
          {busy === 'preview' ? (
            <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
          ) : null}
          Preview comment
        </Button>
      ) : null}

      {preview ? (
        <div className="space-y-3 rounded-md border border-border bg-bg-primary p-3">
          <div>
            <p className="text-xs text-text-tertiary">Comment will be added to</p>
            <p className="text-sm font-medium text-text-primary">
              {preview.ticketTitle}{' '}
              <span className="font-normal text-text-tertiary">({preview.ticketId})</span>
            </p>
          </div>
          <pre className="whitespace-pre-wrap break-words rounded-md bg-bg-secondary p-3 font-sans text-sm text-text-primary">
            {preview.commentPreview}
          </pre>
          <label className="flex items-start gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              className="mt-0.5 accent-accent"
              checked={reviewed}
              disabled={busy !== null}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            I reviewed the ticket and comment preview.
          </label>
          <Button
            size="sm"
            disabled={busy !== null || !reviewed || receipt?.status === 'published' || uncertain}
            onClick={() => void attachTicket()}
          >
            {busy === 'attach' ? (
              <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            Attach to ticket
          </Button>
        </div>
      ) : null}

      {receipt?.status === 'published' ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <Check aria-hidden className="h-4 w-4" /> Share attached to {receipt.ticketId}.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-error">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      ) : null}
    </section>
  );
}
