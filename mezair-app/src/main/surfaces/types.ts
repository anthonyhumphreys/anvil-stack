import type { AgentToolProvider, AgentToolSessionContext } from '../agent-tools/dispatch.js';
import type {
  SurfaceActionRequest,
  SurfaceActionResult,
} from '../../shared/surfaces/types.js';
import type { AgentUISurfaceIntent } from '../../shared/agent-ui-intents.js';

export interface ShareSnapshotOptions {
  includeComments: boolean;
  /** Review: include the full diff instead of hunks around findings. */
  includeFullDiff: boolean;
  /** Diagram: Mermaid pre-rendered to SVG by the renderer (sanitised by the kind). */
  diagramSvg?: string;
}

export interface ShareSnapshot {
  html: string;
  css: string;
  images?: Record<string, string>;
}

export interface SurfaceActionContext {
  intent: AgentUISurfaceIntent;
  /** Session that owns the surface, when still live. */
  sessionId?: string;
}

/** Main-process handler for one surface kind. Registered in ./index.ts. */
export interface MainSurfaceHandler {
  kind: string;
  /** Tools this kind exposes to agents (publish/patch/domain data). */
  toolProvider?: AgentToolProvider;
  executeAction?(ctx: SurfaceActionContext, request: SurfaceActionRequest): Promise<SurfaceActionResult>;
  share?: {
    redact(data: unknown): unknown;
    snapshot(data: unknown, title: string, options: ShareSnapshotOptions): ShareSnapshot;
  };
}

export type { AgentToolSessionContext };
