import { sha256Hex } from '../hash';

export interface HostedIdentity {
  workosClientId: string;
  workosUserId: string;
}

export interface HostedIdentityBinding extends HostedIdentity {
  billingAccountId: string;
  syncAccountId: string;
  generation: number;
  lifecycle: 'active' | 'deleting' | 'deleted';
}

export function validateHostedIdentity(value: unknown): value is HostedIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.workosClientId === 'string' &&
    /^client_[A-Za-z0-9_-]{1,240}$/.test(input.workosClientId) &&
    typeof input.workosUserId === 'string' &&
    /^user_[A-Za-z0-9_-]{1,240}$/.test(input.workosUserId)
  );
}

/** Maps a verified OIDC subject to the identity tuple used by the website. */
export function hostedIdentityFromOidcSubject(
  workosClientId: string,
  subject: string,
): HostedIdentity | null {
  const identity = { workosClientId, workosUserId: subject };
  return validateHostedIdentity(identity) ? identity : null;
}

export async function initialHostedSyncAccountId(identity: HostedIdentity): Promise<string> {
  if (!validateHostedIdentity(identity)) throw new Error('Invalid hosted identity');
  return `workos_${await sha256Hex(JSON.stringify([identity.workosClientId, identity.workosUserId]))}`;
}

export function requireHostedIdentityBinding(
  identity: HostedIdentity,
  binding: HostedIdentityBinding,
): HostedIdentityBinding {
  if (
    !validateHostedIdentity(identity) ||
    identity.workosClientId !== binding.workosClientId ||
    identity.workosUserId !== binding.workosUserId
  )
    throw new Error('Hosted identity mismatch');
  if (binding.lifecycle !== 'active') throw new Error('Hosted account is unavailable');
  if (
    !Number.isSafeInteger(binding.generation) ||
    binding.generation < 1 ||
    !binding.syncAccountId ||
    !binding.billingAccountId
  )
    throw new Error('Invalid hosted account binding');
  return binding;
}
