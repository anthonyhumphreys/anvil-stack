// Owned by the surface-contract workstream: implements window.anvil.surfaces.
import { ipcMain } from 'electron';
import type { ChatArtifact } from '../../shared/types.js';
import type { ChatArtifactRevision } from '../../shared/surfaces/ipc.js';
import type {
  ChatSketch,
  SurfaceActionRequest,
  SurfaceActionResult,
  SurfaceComment,
  SurfaceCommentInput,
} from '../../shared/surfaces/types.js';
import {
  getChatArtifact,
  getChatArtifactRevision,
  listChatArtifactRevisions,
} from '../services/chat-artifact.service.js';
import { getChatSketch } from '../services/chat-sketch.service.js';
import { runSurfaceAction } from '../surfaces/actions.js';
import {
  addSurfaceComment,
  listSurfaceComments,
  setSurfaceCommentStatus,
} from '../surfaces/comments.js';
import { keepSketchAndNotify } from '../surfaces/kinds/sketch.js';

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('Expected text.');
  return value.trim().slice(0, max) || undefined;
}

export function registerSurfacesHandlers(): void {
  ipcMain.handle(
    'surfaces:run-action',
    (_event, request: SurfaceActionRequest): Promise<SurfaceActionResult> => {
      if (typeof request !== 'object' || request === null) {
        return Promise.resolve({ ok: false, error: 'Invalid surface action request.' });
      }
      return runSurfaceAction(request);
    },
  );

  ipcMain.handle('surfaces:list-comments', (_event, surfaceId: unknown): SurfaceComment[] =>
    listSurfaceComments(requireId(surfaceId, 'Surface id')),
  );

  ipcMain.handle(
    'surfaces:add-comment',
    (_event, input: SurfaceCommentInput): Promise<SurfaceComment> => {
      if (typeof input !== 'object' || input === null) throw new Error('Invalid comment.');
      return addSurfaceComment({
        surfaceId: requireId(input.surfaceId, 'Surface id'),
        anchor: input.anchor,
        body: typeof input.body === 'string' ? input.body : '',
        sendToAgent: input.sendToAgent === true,
      });
    },
  );

  ipcMain.handle(
    'surfaces:set-comment-status',
    (_event, commentId: unknown, status: unknown): SurfaceComment => {
      if (status !== 'open' && status !== 'resolved') throw new Error('Invalid comment status.');
      return setSurfaceCommentStatus(requireId(commentId, 'Comment id'), status);
    },
  );

  ipcMain.handle('surfaces:get-sketch', (_event, sketchId: unknown): ChatSketch | null =>
    getChatSketch(requireId(sketchId, 'Sketch id')),
  );

  ipcMain.handle(
    'surfaces:keep-sketch',
    (_event, sketchId: unknown, title: unknown): ChatArtifact =>
      keepSketchAndNotify(requireId(sketchId, 'Sketch id'), { title: optionalText(title, 200) }),
  );

  ipcMain.handle('surfaces:get-artifact', (_event, artifactId: unknown): ChatArtifact | null =>
    getChatArtifact(requireId(artifactId, 'Artifact id')),
  );

  ipcMain.handle(
    'surfaces:list-artifact-revisions',
    (_event, artifactId: unknown): ChatArtifactRevision[] =>
      listChatArtifactRevisions(requireId(artifactId, 'Artifact id')),
  );

  ipcMain.handle(
    'surfaces:get-artifact-revision',
    (_event, artifactId: unknown, version: unknown): ChatArtifactRevision | null => {
      if (!Number.isInteger(version) || (version as number) < 1) {
        throw new Error('Artifact version must be a positive integer.');
      }
      return getChatArtifactRevision(requireId(artifactId, 'Artifact id'), version as number);
    },
  );
}
