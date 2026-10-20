import { useEffect, useState } from 'react';
import type { ChatArtifactRevision } from '../../../../../shared/surfaces/ipc';
import type { ChatArtifact } from '../../../../../shared/types';

export const BINARY_ARTIFACT_KINDS = new Set<ChatArtifact['kind']>(['docx', 'pptx', 'pdf', 'xlsx']);

export interface ArtifactVersionState {
  /** The artifact as it was at `version` (head row with the revision's title and content). */
  artifact: ChatArtifact | null;
  head: ChatArtifact | null;
  /** False when the requested version has no stored revision and the head is shown instead. */
  exact: boolean;
  loading: boolean;
  error: string | null;
}

export function applyRevision(
  head: ChatArtifact,
  revision: Pick<ChatArtifactRevision, 'version' | 'title' | 'content'> | null,
): ChatArtifact {
  if (!revision || revision.version === head.version) return head;
  return { ...head, title: revision.title, content: revision.content, version: revision.version };
}

export function artifactLocation(artifact: ChatArtifact): string {
  return artifact.storage === 'session'
    ? `Session only · ${artifact.relativePath}`
    : (artifact.filePath ?? `.anvil/artifacts/${artifact.relativePath}`);
}

/** The path as the user names it (repo-relative), for one-line metadata; the full path is the tooltip. */
export function artifactShortLocation(artifact: ChatArtifact): string {
  return artifact.storage === 'session' ? 'Session only' : artifact.relativePath;
}

/** Loads the head artifact and the revision a turn produced, so old turns show their own version. */
export function useArtifactVersion(
  artifactId: string,
  version: number,
  refreshKey: unknown,
  initialHead?: ChatArtifact,
): ArtifactVersionState {
  const [state, setState] = useState<ArtifactVersionState>(() => ({
    artifact: initialHead && initialHead.version === version ? initialHead : null,
    head: initialHead ?? null,
    exact: Boolean(initialHead && initialHead.version === version),
    loading: true,
    error: null,
  }));

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void Promise.all([
      window.anvil.surfaces.getArtifact(artifactId),
      window.anvil.surfaces.getArtifactRevision(artifactId, version).catch(() => null),
    ])
      .then(([head, revision]) => {
        if (cancelled) return;
        if (!head) {
          setState({
            artifact: null,
            head: null,
            exact: false,
            loading: false,
            error: 'This artifact was discarded or is no longer available.',
          });
          return;
        }
        const exact = head.version === version || revision !== null;
        setState({
          artifact: applyRevision(head, revision),
          head,
          exact,
          loading: false,
          error: null,
        });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: caught instanceof Error ? caught.message : 'The artifact could not be loaded.',
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, version, refreshKey]);

  return state;
}
