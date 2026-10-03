import type { AgentProvider } from '../../shared/types.js';
import type { SyncScope } from '../../shared/sync-mesh.js';
import type { CredentialDeliverResult } from '../../../cloud/contract/sealed.js';
import type { JobGetResult } from '../../../cloud/contract/jobs.js';
import { rpc } from './sync-backend-client.service.js';
import { readCodexHostAuthJson, validateCodexHostAuthJson } from './codex-host-auth.js';
import {
  deviceTrustState,
  listDeviceIdentities,
  sealCredentialGrant,
} from './sync-keyring.service.js';
import { getSettings } from './settings.service.js';

export type RemoteCredentialChoice =
  | 'target-local'
  | 'codex-account'
  | 'openai-api-key'
  | 'codex-host-auth';

export interface RemoteCredentialContext {
  apiUrl: string;
  accessToken: string;
}

export interface EnsureRemoteCredentialGrantInput {
  choice: RemoteCredentialChoice;
  provider: AgentProvider;
  targetEnrollmentId: string;
  scope: SyncScope;
  context: RemoteCredentialContext;
  result: JobGetResult;
  /** Persisted by the caller only after a successful delivery. */
  deliveredMarker?: string;
}

export interface EnsureRemoteCredentialGrantResult {
  delivered: boolean;
  marker?: string;
}

const inFlightDeliveries = new Map<string, Promise<EnsureRemoteCredentialGrantResult>>();
const MAX_GRANT_LIFETIME_MS = 5 * 60_000;

/** Validate the explicit remote-credential choice against this account's trusted roster. */
export function validateRemoteCredentialChoice(
  provider: AgentProvider,
  targetEnrollmentId: string,
  sourceScope: SyncScope,
  choice: RemoteCredentialChoice | undefined,
): asserts choice is RemoteCredentialChoice {
  if (
    choice !== 'target-local' &&
    choice !== 'codex-account' &&
    choice !== 'openai-api-key' &&
    choice !== 'codex-host-auth'
  ) {
    throw new Error('Choose how the remote Codex session authenticates.');
  }
  if (provider !== 'codex') {
    throw new Error('Remote credential choices are currently supported for Codex sessions only.');
  }

  const identity = listDeviceIdentities(sourceScope).find(
    (device) => device.enrollmentId === targetEnrollmentId,
  );
  if (identity === undefined || deviceTrustState(sourceScope, targetEnrollmentId) !== 'trusted') {
    throw new Error('Remote credentials can only be sent to the selected trusted device.');
  }
}

/** Check source-side auth configuration without returning or persisting secret material. */
export function validateRemoteCredentialAvailability(choice: RemoteCredentialChoice): void {
  if (choice === 'codex-host-auth') {
    validateCodexHostAuthJson(readCodexHostAuthJson());
  }
}

/**
 * Delivers a selected source credential encrypted to the chosen device and
 * bound to the exact live attempt. Account-login and target-local choices need
 * no source grant. The caller persists only the returned marker.
 */
export async function ensureRemoteCredentialGrant(
  input: EnsureRemoteCredentialGrantInput,
): Promise<EnsureRemoteCredentialGrantResult> {
  validateRemoteCredentialChoice(
    input.provider,
    input.targetEnrollmentId,
    input.scope,
    input.choice,
  );
  if (input.choice !== 'openai-api-key' && input.choice !== 'codex-host-auth') {
    return { delivered: false };
  }

  const { job, attempts } = input.result;
  if (
    job.requestedTarget.kind !== 'device' ||
    job.requestedTarget.enrollmentId !== input.targetEnrollmentId ||
    job.targetEnrollmentId !== input.targetEnrollmentId
  ) {
    throw new Error('Remote credential target does not match the selected device.');
  }
  if (job.state !== 'running') return { delivered: false };

  const attempt = attempts
    .filter(
      (candidate) =>
        candidate.jobId === job.id && ['claimed', 'preparing', 'running'].includes(candidate.state),
    )
    .sort((left, right) => right.fence - left.fence)[0];
  if (attempt === undefined) return { delivered: false };

  const marker = `${attempt.id}:${attempt.fence}:${input.targetEnrollmentId}`;
  if (input.deliveredMarker === marker) return { delivered: false, marker };

  const current = inFlightDeliveries.get(marker);
  if (current !== undefined) return current;
  const delivery = deliverGrant(input, attempt, marker);
  inFlightDeliveries.set(marker, delivery);
  try {
    return await delivery;
  } finally {
    inFlightDeliveries.delete(marker);
  }
}

async function deliverGrant(
  input: EnsureRemoteCredentialGrantInput,
  attempt: JobGetResult['attempts'][number],
  marker: string,
): Promise<EnsureRemoteCredentialGrantResult> {
  const recipient = listDeviceIdentities(input.scope).find(
    (device) => device.enrollmentId === input.targetEnrollmentId,
  );
  if (
    recipient === undefined ||
    deviceTrustState(input.scope, input.targetEnrollmentId) !== 'trusted'
  ) {
    throw new Error('The selected remote device is no longer trusted.');
  }

  let kind: string;
  let env: Record<string, string>;
  let codexAuthJson: string | undefined;
  if (input.choice === 'openai-api-key') {
    const apiKey = getSettings().openaiApiKey?.trim();
    if (apiKey === undefined || apiKey.length === 0 || isPlaceholderApiKey(apiKey)) {
      throw new Error('Save a usable OpenAI API key before granting it to the remote session.');
    }
    kind = 'remote-codex-api-key';
    env = { OPENAI_API_KEY: apiKey };
  } else {
    codexAuthJson = readCodexHostAuthJson();
    validateCodexHostAuthJson(codexAuthJson);
    kind = 'remote-codex-host-auth';
    env = {};
  }

  const leaseExpiry = Date.parse(attempt.leaseExpiresAt);
  const expiresAtMs = Math.min(leaseExpiry, Date.now() + MAX_GRANT_LIFETIME_MS);
  if (!Number.isFinite(leaseExpiry) || expiresAtMs <= Date.now()) {
    throw new Error('The remote attempt lease has expired; credentials were not delivered.');
  }

  const grant = sealCredentialGrant({
    recipientPubB64: recipient.pub,
    jobId: attempt.jobId,
    attemptId: attempt.id,
    fence: attempt.fence,
    targetEnrollmentId: input.targetEnrollmentId,
    expiresAt: new Date(expiresAtMs).toISOString(),
    kind,
    env,
    ...(codexAuthJson === undefined ? {} : { codexAuthJson }),
  });
  const response = await rpc<CredentialDeliverResult>(
    { apiUrl: input.context.apiUrl },
    'credential.deliver',
    { grant },
    input.context.accessToken,
  );
  if (response.result.delivered !== true) {
    throw new Error('The backend did not accept the remote credential grant.');
  }
  return { delivered: true, marker };
}

function isPlaceholderApiKey(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === '••••••••' ||
    /^(your|replace|placeholder|example|changeme|change-me|todo|<|\[)/.test(normalized) ||
    normalized.includes('your_openai_api_key') ||
    normalized.includes('your_api_key') ||
    normalized.includes('example') ||
    /^sk(?:-proj)?[-_](?:your|example|placeholder)|^sk-\.{2,}/.test(normalized) ||
    normalized.includes('placeholder')
  );
}

export function resetRemoteCredentialGrantsForTests(): void {
  inFlightDeliveries.clear();
}
