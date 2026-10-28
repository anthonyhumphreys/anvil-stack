import type { FactoryDefinition, FactoryRole, FactoryRun } from '../../../shared/factories';

export function effectiveFactoryRole(factory: FactoryDefinition): FactoryRole | undefined {
  return (
    factory.effectiveRole ?? (factory.definition.access.kind === 'private' ? 'owner' : undefined)
  );
}

export function factoryAccessReady(factory: FactoryDefinition): boolean {
  return !factory.accessPending && !factory.commandPending;
}

export function canManageFactory(factory: FactoryDefinition): boolean {
  return factoryAccessReady(factory) && effectiveFactoryRole(factory) === 'owner';
}

export function canOperateFactory(factory: FactoryDefinition): boolean {
  const role = effectiveFactoryRole(factory);
  return factoryAccessReady(factory) && (role === 'owner' || role === 'operator');
}

export function canReadFactorySource(factory: FactoryDefinition): boolean {
  const explicitlyAllowed =
    factory.definition.access.kind === 'organization'
      ? factory.sourceAccess === true
      : factory.sourceAccess !== false;
  return !factory.accessPending && explicitlyAllowed && !factory.redacted;
}

export function canReadRunSource(run: FactoryRun): boolean {
  const explicitlyAllowed =
    run.snapshot.definition.access.kind === 'organization'
      ? run.sourceAccess === true
      : run.sourceAccess !== false;
  return !run.accessPending && explicitlyAllowed && !run.snapshot.redacted;
}
