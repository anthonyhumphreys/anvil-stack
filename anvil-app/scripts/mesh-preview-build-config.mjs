const machineEndpointsFlag = 'ANVIL_MESH_MACHINE_ENDPOINTS';
const managedEndpointsFlag = 'ANVIL_MESH_MANAGED_ENDPOINTS';

/** Enable client Mesh endpoints only in the isolated staging candidate preview build. */
export function meshPreviewBuildDefines({
  deploymentEnv,
  previewBuild,
  machineEndpoints,
  managedEndpoints,
}) {
  const stagingPreview = deploymentEnv === 'staging' && Boolean(previewBuild);

  return {
    [`process.env.${machineEndpointsFlag}`]: JSON.stringify(
      stagingPreview ? 'true' : (machineEndpoints ?? ''),
    ),
    [`process.env.${managedEndpointsFlag}`]: JSON.stringify(
      stagingPreview ? 'true' : (managedEndpoints ?? ''),
    ),
  };
}
