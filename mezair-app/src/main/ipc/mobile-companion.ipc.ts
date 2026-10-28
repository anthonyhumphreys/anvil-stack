import { BrowserWindow, ipcMain } from 'electron';
import type { CompanionPolicyState } from '../../shared/types.js';
import { onCompanionEvent } from '../services/companion-events.service.js';
import {
  createRaycastCompanionToken,
  createMobilePairingTicket,
  getMobileCompanionStatus,
  listCompanionEnrollmentPolicies,
  listMobileCompanionDevices,
  removeCompanionEnrollmentPolicy,
  revokeMobileCompanionDevice,
  setCompanionEnrollmentPolicy,
  setMobileCompanionEnabled,
} from '../services/mobile-companion.service.js';

const POLICY_STATES: readonly CompanionPolicyState[] = [
  'pending',
  'denied',
  'observe',
  'approve',
  'steer',
];

export function registerMobileCompanionHandlers(): void {
  ipcMain.handle('mobile-companion:get-status', () => getMobileCompanionStatus());
  ipcMain.handle('mobile-companion:set-enabled', (_event, enabled: boolean) =>
    setMobileCompanionEnabled(enabled),
  );
  ipcMain.handle('mobile-companion:create-pairing-ticket', () => createMobilePairingTicket());
  ipcMain.handle('mobile-companion:create-raycast-token', () => createRaycastCompanionToken());
  ipcMain.handle('mobile-companion:list-devices', () => listMobileCompanionDevices());
  ipcMain.handle('mobile-companion:revoke-device', (_event, deviceId: string) => {
    if (typeof deviceId !== 'string' || deviceId.length === 0) return;
    revokeMobileCompanionDevice(deviceId);
  });
  ipcMain.handle('mobile-companion:list-enrollment-policies', () =>
    listCompanionEnrollmentPolicies(),
  );
  ipcMain.handle(
    'mobile-companion:set-enrollment-policy',
    (_event, enrollmentId: string, tier: CompanionPolicyState) => {
      if (typeof enrollmentId !== 'string' || enrollmentId.length === 0) return null;
      if (!POLICY_STATES.includes(tier)) return null;
      return setCompanionEnrollmentPolicy(enrollmentId, tier);
    },
  );
  ipcMain.handle('mobile-companion:remove-enrollment-policy', (_event, enrollmentId: string) => {
    if (typeof enrollmentId !== 'string' || enrollmentId.length === 0) return;
    removeCompanionEnrollmentPolicy(enrollmentId);
  });

  // Companion state changes (new pending enrollments, policy decisions,
  // pairing activity) push a lightweight event so settings UIs can refresh.
  onCompanionEvent((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('mobile-companion:event', event);
    }
  });
}
