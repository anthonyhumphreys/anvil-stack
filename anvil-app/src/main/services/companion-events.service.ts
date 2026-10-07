import { EventEmitter } from 'node:events';
import type { CompanionEvent, CompanionEventType } from '../../shared/types.js';

export type { CompanionEvent, CompanionEventType };

const companionEvents = new EventEmitter();
companionEvents.setMaxListeners(100);

export function emitCompanionEvent(type: CompanionEventType): void {
  companionEvents.emit('event', {
    type,
    generatedAt: new Date().toISOString(),
  } satisfies CompanionEvent);
}

export function onCompanionEvent(callback: (event: CompanionEvent) => void): () => void {
  companionEvents.on('event', callback);
  return () => companionEvents.off('event', callback);
}
