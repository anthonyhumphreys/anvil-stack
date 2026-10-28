import { useEffect, useMemo, useState } from 'react';
import { GitCompare, MessageSquarePlus } from 'lucide-react';
import type { ChatArtifactRevision } from '../../../../../shared/surfaces/ipc';
import type { ChatArtifact } from '../../../../../shared/types';
import { ArtifactPreview } from '../../../chat/ArtifactPreview';
import { selectedArtifactPassage } from '../../../chat/ArtifactAnnotationsPanel';
import { DiffViewer } from '../../../chat/DiffViewer';
import { Button, SegmentedControl } from '../../../ui';
import { ArtifactIcon } from '../../surface-icons';
import { SurfaceSkeleton } from '../../SurfaceSkeleton';
import { useSurfaces } from '../../surfaces-context';
import { readArtifactSurfaceData } from '../../surface-utils';
import type { SurfaceViewProps } from '../../types';
import { ArtifactActions } from './ArtifactActions';
import { buildUnifiedDiff } from './artifact-diff';
import {
  BINARY_ARTIFACT_KINDS,
  applyRevision,
  artifactLocation,
  artifactShortLocation,
  useArtifactVersion,
} from './useArtifactVersion';

function useArtifactForIntent(intent: SurfaceViewProps['intent']) {
  const data = readArtifactSurfaceData(intent.payload.data);
  const { artifacts } = useSurfaces();
  const initialHead = data ? artifacts.find((item) => item.id === data.artifactId) : undefined;
  const state = useArtifactVersion(
    data?.artifactId ?? '',
    data?.version ?? 1,
    `${intent.revision}:${initialHead?.version ?? 0}`,
    initialHead,
  );
  return { data, ...state };
}

function ArtifactMeta({
  artifact,
  head,
  exact,
  requestedVersion,
}: {
  artifact: ChatArtifact;
  head: ChatArtifact | null;
  exact: boolean;
  requestedVersion: number;
}) {
  return (
    <p className="flex min-w-0 items-center gap-x-1.5 whitespace-nowrap text-xs text-text-tertiary">
      <ArtifactIcon kind={artifact.kind} size={12} />
      <span className="min-w-0 truncate font-mono" title={artifactLocation(artifact)}>
        {artifactShortLocation(artifact)}
      </span>
      <span aria-hidden="true">·</span>
      <span className="shrink-0">v{artifact.version}</span>
      {head && head.version > artifact.version && (
        <span className="text-text-secondary">· latest is v{head.version}</span>
      )}
      {!exact && <span className="text-warning">· v{requestedVersion} isn’t in the history</span>}
    </p>
  );
}

function FileCard({ artifact }: { artifact: ChatArtifact }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border-subtle px-3 py-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-bg-tertiary text-text-secondary">
        <ArtifactIcon kind={artifact.kind} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary">
          {artifact.title}
        </span>
        <span className="block text-xs uppercase text-text-tertiary">{artifact.kind} file</span>
      </span>
    </div>
  );
}

/** Inline artifacts render at their natural height; the host's minimise control folds them. */
export function ArtifactInline({ intent, onAction, onOpenStage, readOnly }: SurfaceViewProps) {
  const { data, artifact, head, exact, loading, error } = useArtifactForIntent(intent);

  if (!data) return <p className="text-sm text-text-secondary">{intent.payload.digest}</p>;
  if (!artifact) {
    return loading ? (
      <SurfaceSkeleton label="Loading artifact" />
    ) : (
      <p className="text-sm text-text-secondary">{error ?? intent.payload.digest}</p>
    );
  }

  const binary = BINARY_ARTIFACT_KINDS.has(artifact.kind);
  return (
    <div className="space-y-2">
      <ArtifactMeta artifact={artifact} head={head} exact={exact} requestedVersion={data.version} />
      {binary ? (
        <FileCard artifact={artifact} />
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <ArtifactPreview artifact={artifact} mode="preview" />
        </div>
      )}
      <ArtifactActions
        intent={intent}
        artifact={artifact}
        onAction={onAction}
        readOnly={readOnly}
        onOpenStage={() => onOpenStage()}
      />
    </div>
  );
}

type StageMode = 'preview' | 'source' | 'diff';

export function ArtifactStage({ intent, onAction, onComment, readOnly }: SurfaceViewProps) {
  const { data, artifact: turnArtifact, head, loading, error } = useArtifactForIntent(intent);
  const [revisions, setRevisions] = useState<ChatArtifactRevision[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [compareVersion, setCompareVersion] = useState<number | null>(null);
  const [mode, setMode] = useState<StageMode>('preview');
  const artifactId = data?.artifactId;

  useEffect(() => {
    if (!artifactId) return;
    let cancelled = false;
    void window.mezair.surfaces
      .listArtifactRevisions(artifactId)
      .then((list) => {
        if (!cancelled) setRevisions([...list].sort((a, b) => b.version - a.version));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [artifactId, head?.version]);

  const version = selectedVersion ?? turnArtifact?.version ?? data?.version ?? 1;
  const shown = useMemo(() => {
    if (!head) return turnArtifact;
    if (version === turnArtifact?.version) return turnArtifact;
    return applyRevision(head, revisions.find((revision) => revision.version === version) ?? null);
  }, [head, revisions, turnArtifact, version]);

  const previousVersions = revisions.filter((revision) => revision.version < version);
  const compareTo = compareVersion ?? previousVersions[0]?.version ?? null;
  const diff = useMemo(() => {
    if (mode !== 'diff' || !shown || compareTo === null) return '';
    const base = revisions.find((revision) => revision.version === compareTo);
    return base ? buildUnifiedDiff(base.content, shown.content, shown.relativePath) : '';
  }, [compareTo, mode, revisions, shown]);

  if (!data) return <p className="text-sm text-text-secondary">{intent.payload.digest}</p>;
  if (!shown) {
    return loading ? (
      <SurfaceSkeleton label="Loading artifact" />
    ) : (
      <p className="text-sm text-text-secondary">{error ?? intent.payload.digest}</p>
    );
  }

  const binary = BINARY_ARTIFACT_KINDS.has(shown.kind);
  const commentOnSelection = () => {
    const passage = selectedArtifactPassage(shown.content);
    onComment(
      passage?.quote
        ? {
            type: 'text-selection',
            quote: passage.quote,
            lineStart: passage.lineRange?.startLine,
            lineEnd: passage.lineRange?.endLine,
            label: passage.lineRange
              ? `Lines ${passage.lineRange.startLine}–${passage.lineRange.endLine}`
              : undefined,
          }
        : { type: 'surface' },
    );
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<StageMode>
          label="Artifact view"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'preview', label: 'Preview' },
            { value: 'source', label: 'Source', disabled: binary },
            {
              value: 'diff',
              label: 'Changes',
              icon: GitCompare,
              disabled: binary || previousVersions.length === 0,
            },
          ]}
        />
        {revisions.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            Version
            <select
              value={version}
              onChange={(event) => setSelectedVersion(Number(event.target.value))}
              className="rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {revisions.map((revision) => (
                <option key={revision.version} value={revision.version}>
                  v{revision.version}
                  {revision.version === head?.version ? ' (latest)' : ''}
                  {revision.version === data.version ? ' · this turn' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {mode === 'diff' && previousVersions.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            Compared with
            <select
              value={compareTo ?? ''}
              onChange={(event) => setCompareVersion(Number(event.target.value))}
              className="rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {previousVersions.map((revision) => (
                <option key={revision.version} value={revision.version}>
                  v{revision.version}
                </option>
              ))}
            </select>
          </label>
        )}
        {!binary && mode !== 'diff' && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={commentOnSelection}>
            <MessageSquarePlus size={12} aria-hidden="true" />
            Comment on selection
          </Button>
        )}
      </div>
      <ArtifactMeta artifact={shown} head={head} exact requestedVersion={version} />
      {mode === 'diff' ? (
        diff ? (
          <DiffViewer filePath={shown.relativePath} diff={diff} />
        ) : (
          <p className="text-sm text-text-secondary">No text changes between these versions.</p>
        )
      ) : (
        <div
          className="min-h-[320px] overflow-auto rounded-lg border border-border-subtle bg-bg-primary"
          data-artifact-review-source
          data-artifact-exact-lines={mode === 'source' ? 'true' : 'false'}
        >
          <ArtifactPreview key={`${shown.id}:${shown.version}`} artifact={shown} mode={mode} />
        </div>
      )}
      <ArtifactActions intent={intent} artifact={shown} onAction={onAction} readOnly={readOnly} />
    </div>
  );
}
