import { ipcMain } from 'electron';
import {
  createRaycastCompanionToken,
  createMobilePairingTicket,
  getMobileCompanionStatus,
  listMobileCompanionDevices,
  revokeMobileCompanionDevice,
  setMobileCompanionEnabled,
} from '../services/mobile-companion.service.js';

export function registerMobileCompanionHandlers(): void {
  ipcMain.handle('mobile-companion:get-status', () => getMobileCompanionStatus());
  ipcMain.handle('mobile-companion:set-enabled', (_event, enabled: boolean) =>
    setMobileCompanionEnabled(enabled),
  );
  ipcMain.handle('mobile-companion:create-pairing-ticket', () => createMobilePairingTicket());
  ipcMain.handle('mobile-companion:create-raycast-token', () => createRaycastCompanionToken());
  ipcMain.handle('mobile-companion:list-devices', () => listMobileCompanionDevices());
  ipcMain.handle('mobile-companion:revoke-device', (_event, deviceId: string) => {
    revokeMobileCompanionDevice(deviceId);
  });
}
