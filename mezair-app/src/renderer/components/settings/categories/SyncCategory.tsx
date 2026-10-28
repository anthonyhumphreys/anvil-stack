import { SyncMeshSettingsPanel } from '../SyncMeshSettingsPanel';
import { settingsPanelDomId } from '../settings-route';

/**
 * Sync & Mesh is already its own (large) component — integrate it as a
 * lazily-mounted category rather than rewriting it (ST6). The wrapper only
 * supplies the `sync-mesh` deep-link anchor (ST4).
 */
export function SyncCategory() {
  return (
    <section id={settingsPanelDomId('sync-mesh')}>
      <SyncMeshSettingsPanel />
    </section>
  );
}
