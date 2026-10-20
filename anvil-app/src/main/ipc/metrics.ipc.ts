import { ipcMain } from 'electron';
import { isActivationEventName } from '../../shared/activation-measurement.js';
import { trackActivationEvent } from '../services/metrics.service.js';

export function registerMetricsHandlers(): void {
  ipcMain.handle('metrics:track', (_event, name: unknown, payload: unknown) => {
    if (!isActivationEventName(name)) {
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
