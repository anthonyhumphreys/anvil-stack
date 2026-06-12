import { EventEmitter } from 'node:events';

export type CompanionEvent =
  | { type: 'overview'; generatedAt: string }
  | { type: 'approvals'; generatedAt: string }
  | { type: 'sessions'; generatedAt: string }
  | { type: 'settings'; generatedAt: string }
  | { type: 'notes'; generatedAt: string }
  | { type: 'carplay'; generatedAt: string }
  | { type: 'handover'; generatedAt: string };

const companionEvents = new EventEmitter();
companionEvents.setMaxListeners(100);

export function emitCompanionEvent(type: CompanionEvent['type']): void {
  companionEvents.emit('event', {
    type,
    generatedAt: new Date().toISOString(),
  } satisfies CompanionEvent);
}

export function onCompanionEvent(callback: (event: CompanionEvent) => void): () => void {
  companionEvents.on('event', callback);
  return () => companionEvents.off('event', callback);
}
