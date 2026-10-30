import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileCode, Maximize2, Trash2 } from 'lucide-react';
import type { AgentUISurfaceIntent } from '../../../../../shared/agent-ui-intents';
import { getSurfaceKind } from '../../../../../shared/surfaces/registry';
import type { ChatArtifact } from '../../../../../shared/types';
import { buildEditorUrl } from '../../../../utils/editor-link';
import { Button, ConfirmDialog } from '../../../ui';
import { useSurfaces } from '../../surfaces-context';
import { isActionAvailable, isSyntheticSurfaceId } from '../../surface-utils';
import type { SurfaceViewProps } from '../../types';

/** Ids handled locally here or by the shared chrome, so declared duplicates are skipped. */
const LOCAL_ACTION_IDS = new Set(['share', 'discard', 'open_editor', 'open']);

export function ArtifactActions({
  intent,
  artifact,
  onAction,
  onOpenStage,
  readOnly,
}: {
  intent: AgentUISurfaceIntent;
  artifact: ChatArtifact;
  onAction: SurfaceViewProps['onAction'];
  readOnly?: boolean;
  onOpenStage?: () => void;
}) {
  const navigate = useNavigate();
  const { discardArtifact } = useSurfaces();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [liveLinks, setLiveLinks] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const declared = isSyntheticSurfaceId(intent.id)
    ? []
    : Object.entries(getSurfaceKind('artifact')?.actions ?? {}).filter(
        ([id, spec]) =>
          !LOCAL_ACTION_IDS.has(id) &&
          (spec.targets ?? 'none') === 'none' &&
          isActionAvailable('artifact', id, readOnly) &&
          (id !== 'save_to_repo' || artifact.storage === 'session'),
      );

  const openInEditor = () =>
    navigate(
      buildEditorUrl({
        workspaceId: intent.scope.workspaceId,
        repoId: artifact.repoId,
        absolutePath: artifact.filePath,
        relativePath: artifact.filePath ? undefined : artifact.relativePath,
        source: 'chat',
        title: artifact.title,
      }),
    );

  const requestDiscard = async () => {
    setError(null);
    const shares = await window.mezair.shares
      .list({ itemType: 'artifact', itemId: artifact.id })
      .catch(() => []);
    setLiveLinks(shares.filter((share) => !share.revokedAt).length);
    setConfirmDiscard(true);
  };

  const discard = async () => {
    setBusy(true);
    try {
      if (discardArtifact) await discardArtifact(artifact.id);
      else await window.mezair.chat.discardArtifact(artifact.id);
      setConfirmDiscard(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The artifact could not be discarded.');
      setConfirmDiscard(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {onOpenStage && (
        <Button variant="secondary" size="sm" onClick={onOpenStage}>
          <Maximize2 size={12} aria-hidden="true" />
          Open
        </Button>
      )}
      {artifact.storage === 'repository' && (
        <Button variant="ghost" size="sm" onClick={openInEditor}>
          <FileCode size={12} aria-hidden="true" />
          Open in editor
        </Button>
      )}
      {declared.map(([id, spec]) => (
        <Button key={id} variant="ghost" size="sm" onClick={() => void onAction({ action: id })}>
          {spec.label}
        </Button>
      ))}
      {artifact.storage === 'session' && !readOnly && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void requestDiscard()}
          className="hover:text-error"
        >
          <Trash2 size={12} aria-hidden="true" />
          Discard
        </Button>
      )}
      {error && (
        <p role="alert" className="w-full text-xs text-error">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirmDiscard}
        title={`Discard “${artifact.title}”?`}
        description={
          liveLinks > 0
            ? `This session-only artifact will be removed and ${liveLinks} shared link${liveLinks === 1 ? '' : 's'} will be revoked.`
            : 'This session-only artifact isn’t saved to the repository and will be removed.'
        }
        confirmLabel="Discard artifact"
        tone="danger"
        loading={busy}
        onConfirm={() => void discard()}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}
