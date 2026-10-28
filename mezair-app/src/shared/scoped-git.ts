import type { GitPullRequestCreateResult } from './types';

export type TurnDeliveryMode = 'commit' | 'pr';
export const TURN_DELIVERY_MAX_FILES = 200;
export const TURN_DELIVERY_MAX_PATH_LENGTH = 1024;

export type TurnDeliveryFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'type-changed';

export interface TurnDeliveryFile {
  path: string;
  previousPath?: string;
  status: TurnDeliveryFileStatus;
  diff: string;
}

export interface PreparedTurnDelivery {
  reviewId: string;
  mode: TurnDeliveryMode;
  sourceBranch: string;
  sourceHead: string;
  baseBranch?: string;
  baseHead?: string;
  files: TurnDeliveryFile[];
  diff: string;
  suggestedMessage: string;
  expiresAt: string;
}

export interface TurnDeliveryCommitResult {
  commitHash: string;
  branch: string;
  files: string[];
  indexWarning?: string;
}

export type TurnPullRequestResult =
  | (GitPullRequestCreateResult & { status: 'opened'; pullRequestUrl: string })
  | (GitPullRequestCreateResult & { status: 'branch-pushed'; detail: string })
  | (GitPullRequestCreateResult & { status: 'branch-local'; detail: string });

/** Methods added to `window.mezair.git` by the preload bridge. */
export interface ScopedGitBridge {
  prepareTurnDelivery(
    repoId: string,
    paths: string[],
    mode: TurnDeliveryMode,
  ): Promise<PreparedTurnDelivery>;
  commitTurnDelivery(
    repoId: string,
    reviewId: string,
    message: string,
  ): Promise<TurnDeliveryCommitResult>;
  createTurnPullRequest(
    repoId: string,
    reviewId: string,
    message: string,
  ): Promise<TurnPullRequestResult>;
}
