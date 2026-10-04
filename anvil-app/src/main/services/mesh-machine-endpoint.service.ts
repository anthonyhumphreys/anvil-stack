/** Operator rollout gate for the host-local encrypted Mesh listener. */
export const MESH_MACHINE_ENDPOINT_FLAG = 'ANVIL_MESH_MACHINE_ENDPOINTS';

export function isMeshMachineEndpointEnabled(
  value: string | undefined = process.env[MESH_MACHINE_ENDPOINT_FLAG],
): boolean {
  return value === 'true';
}
