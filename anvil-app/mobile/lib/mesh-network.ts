import * as Network from 'expo-network';
import { AppState, Platform } from 'react-native';
import { MobileMeshNetworkMonitor } from './mesh-network-monitor';
import { mobileMeshSessions } from './mesh-session';

/** The web IP API calls a public service, so native address sampling never runs there. */
export function startMobileMeshNetworkMonitor(): () => void {
  if (Platform.OS === 'web') return () => {};
  const monitor = new MobileMeshNetworkMonitor({
    read: async () => {
      const [state, ip] = await Promise.all([
        Network.getNetworkStateAsync(),
        Network.getIpAddressAsync().catch(() => null),
      ]);
      return { type: state.type, isConnected: state.isConnected, ip };
    },
    listen: (listener) => {
      const subscription = Network.addNetworkStateListener(listener);
      return () => subscription.remove();
    },
    hasDemand: () => mobileMeshSessions.hasDemand(),
    changed: () => mobileMeshSessions.networkChanged(),
    foreground: (active) => mobileMeshSessions.setForeground(active),
  });
  const removeStatus = mobileMeshSessions.onStatus(() => monitor.demandChanged());
  const appState = AppState.addEventListener('change', (state) =>
    monitor.setForeground(state === 'active'),
  );
  monitor.start(AppState.currentState === 'active');
  return () => {
    removeStatus();
    appState.remove();
    monitor.stop();
  };
}
