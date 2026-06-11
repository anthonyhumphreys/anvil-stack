import { NativeModules, Platform } from 'react-native';
import type { CarPlayDriveSnapshot } from '../../src/shared/types';
import { fetchDriveSnapshot } from './drive-mode-api';
import type { CompanionConnection } from './anvil-api';

interface AnvilDriveModeBridgeModule {
  writeConnection: (payload: { baseUrl: string; token: string }) => Promise<boolean>;
  clearConnection: () => Promise<boolean>;
  writeSnapshot: (payload: CarPlayDriveSnapshot) => Promise<boolean>;
}

export async function publishDriveModeState(connection: CompanionConnection | null): Promise<void> {
  const bridge = getDriveModeBridge();
  if (!bridge) return;

  if (!connection) {
    await bridge.clearConnection();
    return;
  }

  try {
    await bridge.writeConnection({ baseUrl: connection.baseUrl, token: connection.token });
    await bridge.writeSnapshot(await fetchDriveSnapshot(connection));
  } catch (error) {
    void error;
  }
}

function getDriveModeBridge(): AnvilDriveModeBridgeModule | null {
  if (Platform.OS !== 'ios') return null;
  const bridge = NativeModules.AnvilDriveModeBridge as AnvilDriveModeBridgeModule | undefined;
  if (!bridge?.writeConnection || !bridge?.clearConnection || !bridge?.writeSnapshot) return null;
  return bridge;
}
