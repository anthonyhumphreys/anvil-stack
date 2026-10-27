import { isEnvironmentProviderId } from '../../cloud/contract/environment';
import type { AgentProvider, WorkflowTargetPolicy } from './types';

export function supportsRemoteWorkflowProvider(provider: AgentProvider): boolean {
  return ['codex', 'azure', 'openai'].includes(provider);
}

export function validateWorkflowTarget(
  target: WorkflowTargetPolicy | undefined,
  provider: AgentProvider,
  name: string,
): void {
  if (!target) return;
  if (
    !['local', 'device', 'auto', 'existing-environment', 'provisioned-environment'].includes(
      target.kind,
    )
  )
    throw new Error(`${name} has an unknown execution target.`);
  if (target.kind === 'local') return;
  if (!supportsRemoteWorkflowProvider(provider))
    throw new Error(`${name} uses a provider that cannot run remotely in workflows.`);
  if (target.kind === 'device' && !target.enrollmentId?.trim())
    throw new Error(`${name} needs a device enrollment id.`);
  if (target.kind === 'existing-environment' && !target.environmentId?.trim())
    throw new Error(`${name} needs an environment id.`);
  if (
    target.kind === 'auto' &&
    (!Array.isArray(target.requirements?.capabilities) ||
      !target.requirements.capabilities.length ||
      target.requirements.capabilities.some((c) => typeof c !== 'string' || !c.trim()))
  )
    throw new Error(`${name} needs at least one automatic placement capability.`);
  if (target.kind === 'provisioned-environment') {
    if (!isEnvironmentProviderId(target.provider))
      throw new Error(`${name} needs a supported environment provider.`);
    if (
      !Number.isSafeInteger(target.ttlSeconds) ||
      target.ttlSeconds < 60 ||
      target.ttlSeconds > 7 * 24 * 60 * 60
    )
      throw new Error(`${name} needs an environment lifetime between 60 seconds and 7 days.`);
  }
}
