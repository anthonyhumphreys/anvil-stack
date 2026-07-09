import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import type { MobileOverview } from '../../src/shared/types';

const WORKSPACE_KEY = 'anvil.mobile.workspace.v1';

function workspaceKey(connectionId: string): string {
  return `${WORKSPACE_KEY}.${connectionId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function overviewPath(connectionId: string): string | null {
  if (!FileSystem.cacheDirectory) return null;
  return `${FileSystem.cacheDirectory}anvil-overview-${encodeURIComponent(connectionId)}.json`;
}

export async function loadSelectedWorkspaceId(connectionId: string): Promise<string | null> {
  return SecureStore.getItemAsync(workspaceKey(connectionId));
}

export async function saveSelectedWorkspaceId(
  connectionId: string,
  workspaceId: string,
): Promise<void> {
  await SecureStore.setItemAsync(workspaceKey(connectionId), workspaceId);
}

export async function loadCachedOverview(connectionId: string): Promise<MobileOverview | null> {
  const path = overviewPath(connectionId);
  if (!path) return null;
  try {
    return JSON.parse(await FileSystem.readAsStringAsync(path)) as MobileOverview;
  } catch {
    return null;
  }
}

export async function saveCachedOverview(
  connectionId: string,
  overview: MobileOverview,
): Promise<void> {
  const path = overviewPath(connectionId);
  if (!path) return;
  await FileSystem.writeAsStringAsync(path, JSON.stringify(overview));
}
