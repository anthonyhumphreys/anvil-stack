import { ipcMain } from 'electron';
import { ACTIVATION_EVENTS, trackActivationEvent } from '../services/metrics.service.js';

export function registerMetricsHandlers(): void {
  ipcMain.handle('metrics:track', (_event, name: unknown, payload: unknown) => {
    if (typeof name !== 'string' || !ACTIVATION_EVENTS.has(name)) {
      return { ok: false, error: 'unknown activation event' };
    }
    const safePayload =
      payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : undefined;
    trackActivationEvent(name, safePayload);
    return { ok: true };
  });
}
