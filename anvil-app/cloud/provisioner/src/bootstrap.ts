export interface MeshEnvironmentBootstrap {
  kind: 'anvil.mesh-environment';
  schemaVersion: '0.2';
  environmentId: string;
  provider?: string;
  backendUrl: string;
  enrollmentCode: string;
  ttlSeconds: number;
  networkPolicy?: string[];
}

export function validBootstrap(bootstrap: unknown): bootstrap is MeshEnvironmentBootstrap {
  if (typeof bootstrap !== 'object' || bootstrap === null) return false;
  const doc = bootstrap as Record<string, unknown>;
  return (
    doc.kind === 'anvil.mesh-environment' && doc.schemaVersion === '0.2' &&
    typeof doc.environmentId === 'string' && doc.environmentId.length > 0 &&
    typeof doc.backendUrl === 'string' && doc.backendUrl.length > 0 &&
    typeof doc.enrollmentCode === 'string' && doc.enrollmentCode.length > 0 &&
    !doc.enrollmentCode.startsWith('anvil-pair-') && !('pairing' in doc) &&
    typeof doc.ttlSeconds === 'number' && Number.isFinite(doc.ttlSeconds) &&
    Number.isInteger(doc.ttlSeconds) && doc.ttlSeconds > 0 &&
    (doc.provider === undefined || typeof doc.provider === 'string') &&
    (doc.networkPolicy === undefined ||
      (Array.isArray(doc.networkPolicy) && doc.networkPolicy.every((item) => typeof item === 'string')))
  );
}

export function validTtlSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}
