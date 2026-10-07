import { isMeshEndpointFlagEnabled } from './mesh-endpoint-flag.service.js';

/** Optional operator override for the host-local encrypted Mesh listener. */
export const MESH_MACHINE_ENDPOINT_FLAG = 'ANVIL_MESH_MACHINE_ENDPOINTS';

export function isMeshMachineEndpointEnabled(
  value: string | undefined = process.env[MESH_MACHINE_ENDPOINT_FLAG],
): boolean {
  return isMeshEndpointFlagEnabled(value, process.env.ANVIL_MESH_MACHINE_ENDPOINTS);
}
