// src/shared/design-types.ts

import type { AgentProvider } from './types.js';

export type DesignMode = 'design' | 'implement';

export type FigmaRefKind = 'design' | 'board' | 'make';

export interface FigmaFileRef {
  kind: FigmaRefKind;
  fileKey: string;
  url: string;
  nodeId?: string;
  fileName?: string;
  thumbnailUrl?: string;
  addedAt: string; // ISO timestamp
}

export interface DesignReadiness {
  figmaMcpRegistered: boolean;
  frontendSkillInstalled: boolean;
  allReady: boolean;
}

export interface ChatStartOptions {
  provider?: AgentProvider;
  threadId?: string;
  providerThreadId?: string;
  forkFromProviderThreadId?: string;
  designMode?: DesignMode;
  figmaContext?: string;
  workspace?: {
    workspaceId: string;
    cwd?: string;
  };
  scaffold?: {
    workspaceId: string;
    rootPath: string;
  };
}
