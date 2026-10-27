import type { ChatEntry } from '../contexts/ChatContext';

/** A receipt for an unaccepted send cannot own output from the executing turn. */
export function isPendingChatUserEntry(entry: ChatEntry): boolean {
  return (
    entry.kind === 'user' &&
    (entry.delivery === 'queued' || entry.delivery === 'failed' || entry.delivery === 'uncertain')
  );
}
