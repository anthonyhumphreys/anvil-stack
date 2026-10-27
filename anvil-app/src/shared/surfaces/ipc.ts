// window.anvil.surfaces — owned by the surface-contract workstream.
import type {
  ChatSketch,
  SurfaceActionRequest,
  SurfaceActionResult,
  SurfaceComment,
  SurfaceCommentInput,
} from './types.js';
import type { ChatArtifact } from '../types.js';
import type { WorkItemReference } from '../change-review-types.js';

export interface ValidationHistoryEntry {
  surfaceId: string;
  threadId: string;
  repoId: string;
  title: string;
  summary: string;
  updatedAt: string;
}

export interface ChatArtifactRevision {
  artifactId: string;
  version: number;
  title: string;
  content: string;
  sourceMessageId?: string;
  createdAt: string;
}

export interface SurfacesApi {
  listValidations(
    workspaceId: string,
    workItemRef?: WorkItemReference,
  ): Promise<ValidationHistoryEntry[]>;
  runAction(request: SurfaceActionRequest): Promise<SurfaceActionResult>;
  listComments(surfaceId: string): Promise<SurfaceComment[]>;
  addComment(input: SurfaceCommentInput): Promise<SurfaceComment>;
  setCommentStatus(commentId: string, status: SurfaceComment['status']): Promise<SurfaceComment>;
  getSketch(sketchId: string): Promise<ChatSketch | null>;
  keepSketch(sketchId: string, title?: string): Promise<ChatArtifact>;
  getArtifact(artifactId: string): Promise<ChatArtifact | null>;
  listArtifactRevisions(artifactId: string): Promise<ChatArtifactRevision[]>;
  getArtifactRevision(artifactId: string, version: number): Promise<ChatArtifactRevision | null>;
}
