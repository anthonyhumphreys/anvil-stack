import { describe, expect, it } from 'vitest';
import { isMeshMachineEndpointEnabled, MESH_MACHINE_ENDPOINT_FLAG } from '../mesh-machine-endpoint.service.js';

describe('Mesh machine endpoint rollout gate', () => {
  it('requires the operator flag to be exactly true', () => {
    expect(isMeshMachineEndpointEnabled('true')).toBe(true);
    expect(isMeshMachineEndpointEnabled('TRUE')).toBe(false);
    expect(isMeshMachineEndpointEnabled('1')).toBe(false);
    const previous = process.env[MESH_MACHINE_ENDPOINT_FLAG];
    try {
      delete process.env[MESH_MACHINE_ENDPOINT_FLAG];
      expect(isMeshMachineEndpointEnabled()).toBe(false);
      process.env[MESH_MACHINE_ENDPOINT_FLAG] = 'true';
      expect(isMeshMachineEndpointEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env[MESH_MACHINE_ENDPOINT_FLAG];
      else process.env[MESH_MACHINE_ENDPOINT_FLAG] = previous;
    }
  });
});
