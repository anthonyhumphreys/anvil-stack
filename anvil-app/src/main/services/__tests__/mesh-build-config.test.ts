import { describe, expect, it } from 'vitest';

const helper = '../../../../scripts/mesh-build-config.mjs';
const { meshBuildDefines } = await import(helper);

describe('Mesh client build flags', () => {
  it('enables machine and managed endpoints in ordinary builds by default', () => {
    const defines = meshBuildDefines();

    expect(JSON.parse(defines['process.env.ANVIL_MESH_MACHINE_ENDPOINTS'])).toBe('true');
    expect(JSON.parse(defines['process.env.ANVIL_MESH_MANAGED_ENDPOINTS'])).toBe('true');
  });

  it('preserves explicit operator overrides independently', () => {
    const disabled = meshBuildDefines({
      machineEndpoints: 'false',
      managedEndpoints: 'false',
    });
    expect(JSON.parse(disabled['process.env.ANVIL_MESH_MACHINE_ENDPOINTS'])).toBe('false');
    expect(JSON.parse(disabled['process.env.ANVIL_MESH_MANAGED_ENDPOINTS'])).toBe('false');

    const managedDisabled = meshBuildDefines({ managedEndpoints: 'false' });
    expect(JSON.parse(managedDisabled['process.env.ANVIL_MESH_MACHINE_ENDPOINTS'])).toBe('true');
    expect(JSON.parse(managedDisabled['process.env.ANVIL_MESH_MANAGED_ENDPOINTS'])).toBe('false');

    const machineDisabled = meshBuildDefines({ machineEndpoints: 'false' });
    expect(JSON.parse(machineDisabled['process.env.ANVIL_MESH_MACHINE_ENDPOINTS'])).toBe('false');
    expect(JSON.parse(machineDisabled['process.env.ANVIL_MESH_MANAGED_ENDPOINTS'])).toBe('true');
  });
});
