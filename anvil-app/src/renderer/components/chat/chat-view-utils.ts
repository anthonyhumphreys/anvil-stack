import type { ChatGoalSnapshot } from '../../../shared/types';
import { isEditableShortcutTarget } from '../../utils/keyboard';
import type { TurnActivityState } from './ChatMessage';

/**
 * Pure helpers extracted from ChatView (C4/Phase 5). Kept DOM-free so the
 * existing unit tests keep working; ChatView re-exports them for the
 * original `../ChatView` import path used by tests.
 */

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export const CHAT_BOTTOM_THRESHOLD_PX = 96;
export const NEW_CHAT_THREAD_LABEL = 'New thread';

export function clampCanvasZoom(zoom: number): number {
  return Math.min(200, Math.max(50, Math.round(zoom / 10) * 10));
}

export function isNearChatBottom(
  metrics: ScrollMetrics,
  thresholdPx = CHAT_BOTTOM_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < thresholdPx;
}

export function shouldFocusChatComposerFromKey(event: Pick<KeyboardEvent, 'key' | 'target'>) {
  if (event.key !== '/') return false;
  return !isEditableShortcutTarget(event.target);
}

export function getNewChatThreadActionLabel(): string {
  return NEW_CHAT_THREAD_LABEL;
}

export function buildMessageReusePrefill(content: string): string {
  return content.trimEnd();
}

export function getChatTurnLiveState({
  busy,
  isLatest,
  hasWork,
  hasAnswer,
  hasTrailingWork = false,
}: {
  busy: boolean;
  isLatest: boolean;
  hasWork: boolean;
  hasAnswer: boolean;
  hasTrailingWork?: boolean;
}): TurnActivityState | null {
  if (!busy || !isLatest) return null;
  if (hasTrailingWork) return 'working';
  if (hasAnswer) return 'responding';
  if (hasWork) return 'working';
  return 'thinking';
}

export function shouldShowTurnActivityStatus(state: TurnActivityState | null): boolean {
  return state === 'thinking';
}

export function formatGoalStatus(status: ChatGoalSnapshot['status']): string {
  switch (status) {
    case 'budgetLimited':
      return 'budget limited';
    case 'complete':
      return 'complete';
    default:
      return status;
  }
}
