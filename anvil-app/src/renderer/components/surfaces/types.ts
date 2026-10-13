import type { ComponentType } from 'react';
import type { AgentUISurfaceIntent } from '../../../shared/agent-ui-intents';
import type {
  SurfaceActionRequest,
  SurfaceActionResult,
  SurfaceAnchor,
} from '../../../shared/surfaces/types';

export type SurfacePresentation = 'inline' | 'stage' | 'window';

export interface SurfaceViewProps {
  intent: AgentUISurfaceIntent;
  presentation: SurfacePresentation;
  /** Run a declared action (agent-message / anvil-command / mutation). */
  onAction: (request: Omit<SurfaceActionRequest, 'surfaceId'>) => Promise<SurfaceActionResult>;
  /** Open the inline comment composer at an anchor. */
  onComment: (anchor: SurfaceAnchor) => void;
  /** Ask the host to open the stage, optionally focused on a target. */
  onOpenStage: (targetId?: string) => void;
}

export interface SurfaceKindView {
  Inline: ComponentType<SurfaceViewProps>;
  /** Defaults to Inline with presentation 'stage' when omitted. */
  Stage?: ComponentType<SurfaceViewProps>;
}
