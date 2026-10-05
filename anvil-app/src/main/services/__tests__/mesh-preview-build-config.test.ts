import { describe, expect, it } from 'vitest';

const helper = '../../../../scripts/mesh-preview-build-config.mjs';
const { meshPreviewBuildDefines } = await import(helper);

describe('candidate preview Mesh build flags', () => {
  it('enables host and managed endpoints for the isolated staging preview', () => {
    const defines = meshPreviewBuildDefines({
      deploymentEnv: 'staging',
      previewBuild: '{"buildId":"candidate"}',
      machineEndpoints: undefined,
      managedEndpoints: undefined,
    });

    expect(JSON.parse(defines['process.env.ANVIL_MESH_MACHINE_ENDPOINTS'])).toBe('true');
    expect(JSON.parse(defines['process.env.ANVIL_MESH_MANAGED_ENDPOINTS'])).toBe('true');
  });

  it('keeps both flags off by default in ordinary staging and production builds', () => {
    for (const deploymentEnv of ['staging', 'production']) {
      const defines = meshPreviewBuildDefines({
        deploymentEnv,
        previewBuild: undefined,
        machineEndpoints: undefined,
        managedEndpoints: undefined,
      });

      expect(JSON.parse(defines['process.env.ANVIL_MESH_MACHINE_ENDPOINTS'])).toBe('');
      expect(JSON.parse(defines['process.env.ANVIL_MESH_MANAGED_ENDPOINTS'])).toBe('');
    }

    const productionPreview = meshPreviewBuildDefines({
      deploymentEnv: 'production',
      previewBuild: 'preview-build',
      machineEndpoints: undefined,
      managedEndpoints: undefined,
    });
    expect(JSON.parse(productionPreview['process.env.ANVIL_MESH_MACHINE_ENDPOINTS'])).toBe('');
    expect(JSON.parse(productionPreview['process.env.ANVIL_MESH_MANAGED_ENDPOINTS'])).toBe('');
  });

  it('preserves explicit operator settings outside candidate previews', () => {
    const defines = meshPreviewBuildDefines({
      deploymentEnv: 'production',
      previewBuild: undefined,
      machineEndpoints: 'true',
      managedEndpoints: 'true',
    });

    expect(JSON.parse(defines['process.env.ANVIL_MESH_MACHINE_ENDPOINTS'])).toBe('true');
    expect(JSON.parse(defines['process.env.ANVIL_MESH_MANAGED_ENDPOINTS'])).toBe('true');
  });
});
