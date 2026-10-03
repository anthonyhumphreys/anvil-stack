import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { AnvilAPI } from '../../../../../shared/ipc-api';
import type {
  ChatArtifactAnnotation,
  ChatArtifactAnnotationInput,
  ChatArtifactAnnotationPatch,
} from '../../../../../shared/types';
import { ChatReplayPreview } from '../ChatReplayPreview';
import '../../../../styles/global.css';
import './preview.css';

const noopUnsubscribe = () => undefined;
let localAnnotations: ChatArtifactAnnotation[] = [];
let nextAnnotationId = 0;

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
  },
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
    onResult: noopUnsubscribe,
    onError: noopUnsubscribe,
    onStatus: noopUnsubscribe,
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

createRoot(rootElement).render(
  <StrictMode>
    <MemoryRouter>
      <ChatReplayPreview />
    </MemoryRouter>
  </StrictMode>,
);
