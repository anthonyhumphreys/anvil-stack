import type { ChatFollowUpResult } from '../../../shared/types';

export interface ComposerDraftVersion {
  draftKey?: string;
  revision: number;
}

export function isCurrentComposerDraft(
  submitted: ComposerDraftVersion,
  current: ComposerDraftVersion,
): boolean {
  return submitted.draftKey === current.draftKey && submitted.revision === current.revision;
}

export function appendComposerPrefill(current: string, incoming: string): string {
  return current.trim() ? `${current}\n\n${incoming}` : incoming;
}

export function getFollowUpFeedback(result: ChatFollowUpResult): {
  kind: 'success' | 'error';
  message: string;
} {
  if (result.status === 'queued') return { kind: 'success', message: 'Queued for the next run.' };
  if (result.status === 'delivered') return { kind: 'success', message: 'Sent to agent.' };
  return {
    kind: 'error',
    message: result.error?.trim() || 'The agent could not accept that message.',
  };
}
