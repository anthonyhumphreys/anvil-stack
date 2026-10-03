import {
  readCloudAgentCredential,
  validateCloudAgentProvider,
  isCloudAgentProviderEnabled,
} from './cloud-agent-settings.service.js';
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

export type { RemoteCredentialChoice } from '../../shared/remote-chat.js';
import type { RemoteCredentialChoice } from '../../shared/remote-chat.js';

export interface RemoteCredentialContext {
  apiUrl: string;
  accessToken: string;
}

export interface EnsureRemoteCredentialGrantInput {
  choice: RemoteCredentialChoice;
  cloudTarget?: boolean;
  provider: AgentProvider;
  targetEnrollmentId: string;
  scope: SyncScope;
  context: RemoteCredentialContext;
  result: JobGetResult;
  /** Persisted by the caller only after a successful delivery. */
  deliveredMarker?: string;
  /** Present only for a hosted worker tied to a source-owned environment. */
  hostedEnvironmentId?: string;
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
    choice !== 'codex-host-auth' &&
    choice !== 'cloud-provider'
  ) {
    throw new Error('Choose how the remote Codex session authenticates.');
  }
  if (choice === 'cloud-provider' ? provider === 'codex' : provider !== 'codex') {
    throw new Error('Choose credentials appropriate for the remote provider.');
  }

  const identity = listDeviceIdentities(sourceScope).find(
    (device) => device.enrollmentId === targetEnrollmentId,
  );
  if (identity === undefined || deviceTrustState(sourceScope, targetEnrollmentId) !== 'trusted') {
    throw new Error('Remote credentials can only be sent to the selected trusted device.');
  }
}

/** Check source-side auth configuration without returning or persisting secret material. */
export function validateRemoteCredentialAvailability(
  choice: RemoteCredentialChoice,
  provider?: AgentProvider,
): void {
  if (choice === 'cloud-provider') {
    if (provider === undefined) throw new Error('Choose a cloud agent provider.');
    validateCloudAgentProvider(provider);
  }
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
  const hostedAuthorized =
    input.hostedEnvironmentId !== undefined && (await isHostedEnvironmentTarget(input));
  if (input.hostedEnvironmentId !== undefined && !hostedAuthorized)
    throw new Error('The hosted environment no longer matches this remote chat.');
  if (!hostedAuthorized) {
    validateRemoteCredentialChoice(
      input.provider,
      input.targetEnrollmentId,
      input.scope,
      input.choice,
    );
  } else if (
    !listDeviceIdentities(input.scope).some(
      (entry) => entry.enrollmentId === input.targetEnrollmentId,
    )
  ) {
    throw new Error('The hosted worker identity is unavailable for credential delivery.');
  }
  if (
    input.choice !== 'openai-api-key' &&
    input.choice !== 'codex-host-auth' &&
    input.choice !== 'cloud-provider'
  ) {
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

  if (input.cloudTarget && !isCloudAgentProviderEnabled(input.provider))
    throw new Error('The selected provider is disabled for cloud agents.');

  const current = inFlightDeliveries.get(marker);
  if (current !== undefined) return current;
  const delivery = deliverGrant(input, attempt, marker, hostedAuthorized);
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
  hostedAuthorized: boolean,
): Promise<EnsureRemoteCredentialGrantResult> {
  const recipient = listDeviceIdentities(input.scope).find(
    (device) => device.enrollmentId === input.targetEnrollmentId,
  );
  if (
    recipient === undefined ||
    (!hostedAuthorized && deviceTrustState(input.scope, input.targetEnrollmentId) !== 'trusted')
  ) {
    throw new Error('The selected remote device is no longer trusted.');
  }

  let kind: string;
  let env: Record<string, string>;
  let codexAuthJson: string | undefined;
  let devinCredentialsToml: string | undefined;
  let provider: Exclude<AgentProvider, 'codex'> | undefined;
  if (input.choice === 'cloud-provider') {
    if (input.provider === 'codex') throw new Error('Choose Codex account authentication.');
    validateCloudAgentProvider(input.provider);
    const credential = readCloudAgentCredential(input.provider);
    kind = 'remote-provider-auth';
    provider = input.provider;
    env = credential.env;
    devinCredentialsToml = credential.devinCredentialsToml;
  } else if (input.choice === 'openai-api-key') {
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
    ...(provider === undefined ? {} : { provider }),
    ...(devinCredentialsToml === undefined ? {} : { devinCredentialsToml }),
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

async function isHostedEnvironmentTarget(
  input: EnsureRemoteCredentialGrantInput,
): Promise<boolean> {
  const listed = await rpc<{
    environments?: Array<{
      environmentId: string;
      provider: string;
      state: string;
      enrollmentId?: string;
    }>;
  }>(
    { apiUrl: input.context.apiUrl },
    'environment.list',
    { includeTerminal: false },
    input.context.accessToken,
  );
  return (
    listed.result.environments?.some(
      (environment) =>
        environment.environmentId === input.hostedEnvironmentId &&
        environment.provider === 'anvil-managed' &&
        ['enrolled', 'running'].includes(environment.state) &&
        environment.enrollmentId === input.targetEnrollmentId,
    ) === true
  );
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
