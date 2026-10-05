export function isManagedEndpointDomain(value) {
  return (
    typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= 220 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)
  );
}

/** Preserve the operator's staging rollout choice across automatic deployments. */
export function stagingVars(configured, { managedEndpointPilot = false } = {}) {
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error('Staging Worker variables must be an object.');
  }
  if (configured.HOSTED_CHECKOUT_ENABLED !== 'false') {
    throw new Error('Staging CI requires explicitly disabled checkout.');
  }
  const savedFlag = configured.ANVIL_MESH_MANAGED_ENDPOINTS ?? 'false';
  if (!['true', 'false'].includes(savedFlag)) {
    throw new Error('Staging managed endpoint flag must be the string true or false.');
  }
  const managed = savedFlag === 'true' || managedEndpointPilot;
  if (managed && !isManagedEndpointDomain(configured.MACHINE_ENDPOINT_DOMAIN)) {
    throw new Error(
      'Managed endpoints require a valid nonsecret MACHINE_ENDPOINT_DOMAIN target var.',
    );
  }
  return {
    ...configured,
    ANVIL_CLOUD_AGENTS_ENABLED: 'false',
    ANVIL_MESH_MANAGED_ENDPOINTS: managed ? 'true' : 'false',
  };
}
