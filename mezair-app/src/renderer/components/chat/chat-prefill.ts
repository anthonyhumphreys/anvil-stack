/** Window event that drafts text into the chat composer. Never sends on its own. */
export const CHAT_PREFILL_EVENT = 'mezair:chat-prefill';
export const CHAT_SEND_EVENT = 'mezair:chat-send';

export function requestChatPrefill(text: string) {
  window.dispatchEvent(new CustomEvent(CHAT_PREFILL_EVENT, { detail: { text } }));
}

/** Explicit user actions submit without overwriting an unrelated composer draft. */
export function requestChatSend(text: string) {
  window.dispatchEvent(new CustomEvent(CHAT_SEND_EVENT, { detail: { text } }));
}
