const ENABLED_ENVIRONMENT_VALUE = 'true';

/** Anvil-operated agent execution is an explicit opt-in and stays off by default. */
export function isAnvilCloudAgentsEnabled(): boolean {
  return process.env.ANVIL_CLOUD_AGENTS_ENABLED === ENABLED_ENVIRONMENT_VALUE;
}

export function assertAnvilCloudAgentsEnabled(): void {
  if (!isAnvilCloudAgentsEnabled()) {
    throw new Error('Anvil Cloud Agents are unavailable.');
  }
}
