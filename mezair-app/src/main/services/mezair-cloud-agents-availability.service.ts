const ENABLED_ENVIRONMENT_VALUE = 'true';

/** Mezair-operated agent execution is an explicit opt-in and stays off by default. */
export function isMezairCloudAgentsEnabled(): boolean {
  return process.env.MEZAIR_CLOUD_AGENTS_ENABLED === ENABLED_ENVIRONMENT_VALUE;
}

export function assertMezairCloudAgentsEnabled(): void {
  if (!isMezairCloudAgentsEnabled()) {
    throw new Error('Mezair Cloud Agents are unavailable.');
  }
}
