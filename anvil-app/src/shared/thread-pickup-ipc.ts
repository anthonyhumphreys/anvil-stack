import type {
  ThreadPickupPackage,
  ThreadContinuation,
} from '../../cloud/contract/thread-pickup.js';

export interface ThreadPickupPreview {
  preparedId: string;
  title: string;
  sharedAt: string;
  source: ThreadPickupPackage['source'];
  messageCount: number;
  items: Array<Pick<ThreadContinuation['items'][number], 'kind' | 'title'>>;
  repoNames: string[];
  ticket?: ThreadContinuation['context']['ticket'];
  previewDocument: string;
  byteLength: number;
  expiresAt: string;
}

export interface ThreadPickupInput {
  preparedId: string;
  workspaceId: string;
  repoIds: string[];
  personaId: string;
}
