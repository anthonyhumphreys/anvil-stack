/** Window event that drafts text into the chat composer. Never sends on its own. */
export const CHAT_PREFILL_EVENT = 'anvil:chat-prefill';

export function requestChatPrefill(text: string) {
  window.dispatchEvent(new CustomEvent(CHAT_PREFILL_EVENT, { detail: { text } }));
}
