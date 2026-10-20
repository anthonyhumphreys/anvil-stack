import type { ChatArtifactKind, ChatArtifactStorage } from '../../types.js';
import type { ArtifactSurfaceData, SurfaceKindDefinition } from '../types.js';

export const ARTIFACT_KINDS: readonly ChatArtifactKind[] = [
  'markdown',
  'mermaid',
  'html',
  'docx',
  'pptx',
  'pdf',
  'csv',
  'xlsx',
  'code',
  'diagram',
  'data',
  'text',
];

/** Binary kinds reference a file under `.anvil/artifacts` instead of inline content. */
export const BINARY_ARTIFACT_KINDS: readonly ChatArtifactKind[] = ['docx', 'pptx', 'pdf', 'xlsx'];

/** Artifact surface payload: the shared contract plus display metadata captured at publish time. */
export interface ArtifactSurfacePayload extends ArtifactSurfaceData {
  title?: string;
  kind?: ChatArtifactKind;
  storage?: ChatArtifactStorage;
  relativePath?: string;
}

export function artifactSurfaceDigest(data: ArtifactSurfacePayload): string {
  const title = data.title?.trim() || data.relativePath || data.artifactId;
  const kind = data.kind ? ` (${data.kind})` : '';
  const storage = data.storage === 'session' ? ' · session only' : '';
  return `Artifact "${title}" v${data.version}${kind} · ${data.operation}${storage}`;
}

export const artifactSurfaceKind: SurfaceKindDefinition<ArtifactSurfacePayload> = {
  kind: 'artifact',
  label: 'Artifact',
  schema: {
    type: 'object',
    properties: {
      artifactId: { type: 'string', minLength: 1, maxLength: 200 },
      version: { type: 'integer', minimum: 1 },
      operation: { type: 'string', enum: ['created', 'updated'] },
      title: { type: 'string', maxLength: 300 },
      kind: { type: 'string', enum: ARTIFACT_KINDS },
      storage: { type: 'string', enum: ['repository', 'session'] },
      relativePath: { type: 'string', maxLength: 1000 },
    },
    required: ['artifactId', 'version', 'operation'],
    additionalProperties: false,
  },
  actions: {
    open_editor: {
      label: 'Open in editor',
      semantics: { type: 'anvil-command', command: 'artifact.open-editor' },
      targets: 'none',
    },
    save_to_repo: {
      label: 'Save to repo',
      semantics: { type: 'mutation', command: 'artifact.save-to-repo', approval: true },
      targets: 'none',
    },
    discard: {
      label: 'Discard',
      semantics: { type: 'anvil-command', command: 'artifact.discard' },
      targets: 'none',
    },
  },
  anchors: ['surface', 'text-selection', 'region'],
  digest: artifactSurfaceDigest,
  shareable: true,
};
