// Live share links (spec §11.5 "Shared" filter): title, version, expiry and
// interactivity, with Copy link / Update / Revoke. Embeddable by the Library
// and anywhere else that lists an item's links.
import { AlertTriangle, Check, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ShareItemType, ShareRecord } from '../../../shared/shares-ipc';
import { ShareDialog } from './ShareDialog';
import { Button, ConfirmDialog, cx } from '../ui';
import { errorMessage, formatShareDate, isShareBehind, isShareExpired } from './share-format';

export interface SharedLinksListProps {
  /** Restrict to one workspace (Library) … */
  workspaceId?: string;
  /** … or to one item's links. */
  itemType?: ShareItemType;
  itemId?: string;
  /** Changes to this value trigger a reload (e.g. after a share dialog closes). */
  refreshKey?: unknown;
  emptyLabel?: string;
  className?: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; records: ShareRecord[] };

export function SharedLinksList({
  workspaceId,
  itemType,
  itemId,
  refreshKey,
  emptyLabel = 'No live share links.',
  className,
}: SharedLinksListProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ShareRecord | null>(null);
  const [editTarget, setEditTarget] = useState<ShareRecord | null>(null);

  const load = useCallback(async () => {
    try {
      const records = await window.mezair.shares.list({
        ...(workspaceId ? { workspaceId } : {}),
        ...(itemType ? { itemType } : {}),
        ...(itemId ? { itemId } : {}),
      });
      const available = await window.mezair.shares.available().catch(() => false);
      if (!available && records.length === 0) {
        setState({ kind: 'unavailable' });
        return;
      }
      setState({ kind: 'ready', records });
    } catch (error) {
      setState({ kind: 'error', message: errorMessage(error) });
    }
  }, [workspaceId, itemType, itemId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const run = async (record: ShareRecord, action: () => Promise<unknown>, done: string) => {
    setBusyId(record.id);
    setMessage(null);
    try {
      await action();
      setMessage({ tone: 'ok', text: done });
      await load();
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusyId(null);
    }
  };

  if (state.kind === 'loading') {
    return (
      <p className={cx('flex items-center gap-2 text-sm text-text-tertiary', className)}>
        <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" />
        Loading share links…
      </p>
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <p className={cx('text-sm text-text-tertiary', className)}>
        Share links need a Mezair sync session. Sign in to Mezair sync in Settings to share and
        manage links.
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className={cx('flex items-center gap-3 text-sm text-error', className)}>
        <AlertTriangle aria-hidden className="h-4 w-4" />
        {state.message}
        <Button size="sm" variant="secondary" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }
  if (state.records.length === 0) {
    return <p className={cx('text-sm text-text-tertiary', className)}>{emptyLabel}</p>;
  }

  return (
    <div className={className}>
      {message && (
        <p
          role="status"
          aria-live="polite"
          className={cx(
            'mb-2 flex items-center gap-2 text-sm',
            message.tone === 'ok' ? 'text-success' : 'text-error',
          )}
        >
          {message.tone === 'ok' ? (
            <Check aria-hidden className="h-4 w-4" />
          ) : (
            <AlertTriangle aria-hidden className="h-4 w-4" />
          )}
          {message.text}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Live share links</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-text-tertiary">
              <th scope="col" className="py-2 pr-3 font-medium">
                Title
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Version
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Expires
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Interactive
              </th>
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {state.records.map((record) => {
              const expired = isShareExpired(record);
              const behind = isShareBehind(record);
              const busy = busyId === record.id;
              return (
                <tr key={record.id} className="border-b border-border last:border-0">
                  <td className="max-w-[18rem] break-words py-2 pr-3 text-text-primary">
                    {record.title}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-text-secondary">
                    v{record.version}
                    {behind && (
                      <span className="text-text-tertiary">
                        {' '}
                        · you’re on v{record.currentVersion}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-text-secondary">
                    {expired ? (
                      <span className="text-warning">Expired</span>
                    ) : record.expiresAt ? (
                      formatShareDate(record.expiresAt)
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-2 pr-3 text-text-secondary">
                    {record.interactive ? 'Yes' : <span aria-label="No">—</span>}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap justify-end gap-2">
                      {!expired && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busyId !== null}
                          onClick={() =>
                            void run(
                              record,
                              () => window.mezair.shares.copyLink(record.id),
                              'Link copied',
                            )
                          }
                        >
                          Copy link
                        </Button>
                      )}
                      {!expired &&
                        (behind ||
                          record.itemType === 'thread' ||
                          record.itemType === 'remote-thread') && (
                          <Button
                            size="sm"
                            disabled={busyId !== null}
                            aria-label={`Update link for ${record.title} to v${record.currentVersion}`}
                            onClick={() => setEditTarget(record)}
                          >
                            {busy ? (
                              <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />
                            ) : null}
                            Update
                          </Button>
                        )}
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busyId !== null}
                        onClick={() => setRevokeTarget(record)}
                      >
                        Revoke
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke this link?"
        description={
          revokeTarget
            ? `“${revokeTarget.title}” will stop opening for anyone who has the link.`
            : undefined
        }
        confirmLabel="Revoke link"
        tone="danger"
        loading={revokeTarget !== null && busyId === revokeTarget.id}
        onConfirm={() => {
          const record = revokeTarget;
          if (!record) return;
          void run(record, () => window.mezair.shares.revoke(record.id), 'Link revoked').finally(
            () => setRevokeTarget(null),
          );
        }}
        onCancel={() => setRevokeTarget(null)}
      />
      {editTarget && (
        <ShareDialog
          target={{ itemType: editTarget.itemType, itemId: editTarget.itemId }}
          title={editTarget.title}
          initialAudience={editTarget.audience}
          initialRecordId={editTarget.id}
          open
          onClose={() => {
            setEditTarget(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
