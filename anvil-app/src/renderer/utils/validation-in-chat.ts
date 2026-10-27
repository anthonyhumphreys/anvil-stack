import { chatPromptPath } from './sidebar-navigation';

export function validationInChatPath(repoId: string, reviewId?: string, threadId?: string): string {
  const input = JSON.stringify({ repoId, ...(reviewId ? { reviewId } : {}) });
  const path = chatPromptPath(
    reviewId
      ? `Open my saved validation evidence. Call validation_context with ${input}, then publish its acceptance criteria as an inline validation plan with validation_publish, retaining the historical evidence. Keep new criteria unchecked. Do not run checks or accept the change.`
      : `Validate my changes against my request and any linked work-item acceptance criteria. Call validation_context with ${input}, then publish an inline plan with validation_publish. Clarify material ambiguity in conversation and run within the existing permissions. Attach evidence to each criterion; leave missing proof unchecked or blocked.`,
  );
  if (!threadId) return path;
  const url = new URL(path, 'https://anvil.local');
  url.searchParams.set('thread', threadId);
  return `${url.pathname}${url.search}`;
}
