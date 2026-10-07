const machineEndpointsFlag = 'ANVIL_MESH_MACHINE_ENDPOINTS';
const managedEndpointsFlag = 'ANVIL_MESH_MANAGED_ENDPOINTS';

/** Enable client Mesh endpoints in app builds unless an operator explicitly disables them. */
export function meshBuildDefines({ machineEndpoints, managedEndpoints } = {}) {
  return {
    [`process.env.${machineEndpointsFlag}`]: JSON.stringify(machineEndpoints ?? 'true'),
    [`process.env.${managedEndpointsFlag}`]: JSON.stringify(managedEndpoints ?? 'true'),
  };
}
