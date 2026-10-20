import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { AnvilAPI } from '../../../../../shared/ipc-api';
import type {
  ChatArtifactAnnotation,
  ChatArtifactAnnotationInput,
  ChatArtifactAnnotationPatch,
} from '../../../../../shared/types';
import type { SurfacesApi } from '../../../../../shared/surfaces/ipc';
import type { SurfaceComment } from '../../../../../shared/surfaces/types';
import { ChatReplayPreview } from '../ChatReplayPreview';
import { ComposerPreview } from '../ComposerPreview';
import {
  DeliveryReadinessPreview,
  installDeliveryPreviewBridge,
} from '../DeliveryReadinessPreview';
import {
  REPLAY_SURFACE_ARTIFACTS,
  REPLAY_SURFACE_ARTIFACT_REVISIONS,
  REPLAY_SURFACE_SKETCHES,
} from '../chat-replay-surface-fixtures';
import '../../../../styles/global.css';
import './preview.css';

const noopUnsubscribe = () => undefined;
let localAnnotations: ChatArtifactAnnotation[] = [];
let nextAnnotationId = 0;

// In-memory surface store so artifact, sketch, revision and comment views render offline.
const SHARING_DISABLED = 'Sharing is disabled in the synthetic replay.';
let localArtifacts = [...REPLAY_SURFACE_ARTIFACTS];
let localSketches = [...REPLAY_SURFACE_SKETCHES];
let localSurfaceComments: SurfaceComment[] = [];
let nextSurfaceCommentId = 0;

const localSurfaces: SurfacesApi = {
  runAction: async (request) => ({
    ok: true,
    message: `Synthetic replay: "${request.action}" was not executed.`,
  }),
  listComments: async (surfaceId) =>
    localSurfaceComments.filter((comment) => comment.surfaceId === surfaceId),
  addComment: async (input) => {
    const now = new Date().toISOString();
    const comment: SurfaceComment = {
      id: `fixture-surface-comment-${++nextSurfaceCommentId}`,
      surfaceId: input.surfaceId,
      anchor: input.anchor,
      body: input.body,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    localSurfaceComments = [...localSurfaceComments, comment];
    return comment;
  },
  setCommentStatus: async (commentId, status) => {
    const existing = localSurfaceComments.find((comment) => comment.id === commentId);
    if (!existing) throw new Error('Synthetic comment was not found.');
    const updated = { ...existing, status, updatedAt: new Date().toISOString() };
    localSurfaceComments = localSurfaceComments.map((comment) =>
      comment.id === commentId ? updated : comment,
    );
    return updated;
  },
  getSketch: async (sketchId) => localSketches.find((sketch) => sketch.id === sketchId) ?? null,
  keepSketch: async (sketchId, title) => {
    const sketch = localSketches.find((candidate) => candidate.id === sketchId);
    if (!sketch) throw new Error('Synthetic sketch was not found.');
    const now = new Date().toISOString();
    const artifact = {
      id: `fixture-kept-${sketch.id}`,
      threadId: sketch.threadId,
      title: title ?? sketch.title,
      kind: 'html' as const,
      storage: 'session' as const,
      relativePath: `${sketch.id}.html`,
      content: sketch.html,
      version: 1,
      status: 'draft' as const,
      visibility: 'local' as const,
      source: 'assistant' as const,
      createdAt: now,
      updatedAt: now,
    };
    localArtifacts = [...localArtifacts.filter((item) => item.id !== artifact.id), artifact];
    localSketches = localSketches.map((candidate) =>
      candidate.id === sketchId ? { ...candidate, keptArtifactId: artifact.id } : candidate,
    );
    return artifact;
  },
  getArtifact: async (artifactId) => localArtifacts.find((item) => item.id === artifactId) ?? null,
  listArtifactRevisions: async (artifactId) =>
    REPLAY_SURFACE_ARTIFACT_REVISIONS.filter((revision) => revision.artifactId === artifactId),
  getArtifactRevision: async (artifactId, version) =>
    REPLAY_SURFACE_ARTIFACT_REVISIONS.find(
      (revision) => revision.artifactId === artifactId && revision.version === version,
    ) ?? null,
};

const localShares = {
  available: async () => false,
  list: async () => [],
  preview: async () => {
    throw new Error(SHARING_DISABLED);
  },
  publish: async () => {
    throw new Error(SHARING_DISABLED);
  },
  update: async () => {
    throw new Error(SHARING_DISABLED);
  },
  revoke: async () => {
    throw new Error(SHARING_DISABLED);
  },
  copyLink: async () => {
    throw new Error(SHARING_DISABLED);
  },
};

const localAnvilBridge = {
  chat: {
    prepareAttachments: async () => [],
    selectAttachments: async () => [],
    searchFileMentions: async () => [],
    listArtifactAnnotations: async (artifactId: string) =>
      localAnnotations.filter((annotation) => annotation.artifactId === artifactId),
    createArtifactAnnotation: async (input: ChatArtifactAnnotationInput) => {
      const now = new Date().toISOString();
      const annotation: ChatArtifactAnnotation = {
        id: `fixture-annotation-${++nextAnnotationId}`,
        artifactId: input.artifactId,
        body: input.body,
        quote: input.quote,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      };
      localAnnotations = [annotation, ...localAnnotations];
      return annotation;
    },
    updateArtifactAnnotation: async (id: string, patch: ChatArtifactAnnotationPatch) => {
      const existing = localAnnotations.find((annotation) => annotation.id === id);
      if (!existing) throw new Error('Synthetic annotation was not found.');
      const { quote, ...fields } = patch;
      const updated: ChatArtifactAnnotation = {
        ...existing,
        ...fields,
        ...(quote === undefined ? {} : { quote: quote ?? undefined }),
        updatedAt: new Date().toISOString(),
      };
      localAnnotations = localAnnotations.map((annotation) =>
        annotation.id === id ? updated : annotation,
      );
      return updated;
    },
    deleteArtifactAnnotation: async (id: string) => {
      localAnnotations = localAnnotations.filter((annotation) => annotation.id !== id);
      return true;
    },
    discardArtifact: async (artifactId: string) => {
      localArtifacts = localArtifacts.filter((item) => item.id !== artifactId);
      return true;
    },
  },
  surfaces: localSurfaces,
  shares: localShares,
  codexRegistry: {
    snapshot: async () => ({ skills: [] }),
  },
  voice: {
    requestPermission: async () => ({
      granted: false,
      status: 'denied' as const,
      error: 'Voice input is disabled in the synthetic replay.',
    }),
    startListening: async () => ({
      success: false,
      fallback: false,
      error: 'Voice input is disabled in the synthetic replay.',
    }),
    stopListening: async () => ({ success: true }),
    getStatus: async () => ({ isListening: false }),
    onResult: () => noopUnsubscribe,
    onError: () => noopUnsubscribe,
    onStatus: () => noopUnsubscribe,
  },
  metrics: {
    track: async () => ({ ok: true }),
  },
  git: {
    generateCommitMessage: async () => 'Synthetic replay commit',
    stage: async () => undefined,
    commit: async () => 'synthetic000000000000000000000000000000000000',
    createPullRequest: async () => ({
      pullRequestUrl: null,
      branch: 'synthetic-replay',
      commitHash: 'synthetic000000000000000000000000000000000000',
      repoName: 'anvil-demo (synthetic)',
    }),
  },
} as unknown as AnvilAPI;

// This bridge exists only in the standalone Vite preview entry. The production
// Electron renderer has a separate HTML entry and never imports this module.
Object.defineProperty(window, 'anvil', {
  configurable: true,
  enumerable: true,
  writable: true,
  value: localAnvilBridge,
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Chat replay root element is missing.');
const deliveryPreview = new URLSearchParams(window.location.search).has('delivery');
const composerPreview = new URLSearchParams(window.location.search).has('composer');
if (deliveryPreview) installDeliveryPreviewBridge();

createRoot(rootElement).render(
  <StrictMode>
    <MemoryRouter>
      {composerPreview ? (
        <ComposerPreview />
      ) : deliveryPreview ? (
        <DeliveryReadinessPreview />
      ) : (
        <ChatReplayPreview />
      )}
    </MemoryRouter>
  </StrictMode>,
);
