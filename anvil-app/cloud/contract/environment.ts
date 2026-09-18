// Cloud agent environments (ENV-01): provider-neutral lifecycle for
// ephemeral execution environments that join the account as ordinary mesh
// workers.
//
// An environment is NOT a new execution model: it is a cloud-hosted
// machine (AWS microVM, Cloudflare sandbox, Vercel sandbox, or an
// Anvil-managed Cloudflare environment) that boots the anvil-worker
// image, redeems an ephemeral-class pairing payload, and then claims
// jobs through the exact same worker/claim/fence/artifact path as a
// desktop or daemon worker. The rows these ops manage are descriptive
// lifecycle records — provisioning intent, the provider handle, the
// enrollment link, and reaping receipts — so cleanup intent survives
// the offline death of whichever device created the environment.
//
// Provider credentials never appear here: handles are opaque provider
// references and configs stay on the provisioner's device.

/** Compute provider that hosts an environment. */
export type EnvironmentProviderId =
  /** BYO AWS Lambda MicroVM (anvil-cloud AwsLambdaMicroVmSandboxProvider). */
  | 'aws-lambda-microvm'
  /** BYO Cloudflare Sandbox via the account's provisioner Worker. */
  | 'cloudflare-sandbox'
  /** BYO Vercel Sandbox (@vercel/sandbox SDK). */
  | 'vercel-sandbox'
  /**
   * Anvil-operated Cloudflare environment (hosted tier). Same contract —
   * the provisioner identity is Anvil's infrastructure, and hosted
   * entitlements bound TTL/concurrency at the authoritative handler.
   */
  | 'anvil-managed';

export const ENVIRONMENT_PROVIDER_IDS: readonly EnvironmentProviderId[] = [
  'aws-lambda-microvm',
  'cloudflare-sandbox',
  'vercel-sandbox',
  'anvil-managed',
];

export function isEnvironmentProviderId(value: unknown): value is EnvironmentProviderId {
  return (
    typeof value === 'string' && (ENVIRONMENT_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/**
 * Environment lifecycle. `provisioning` covers provider create + bootstrap
 * (cold start is honest); `enrolled` means the ephemeral enrollment exists
 * and the worker may connect; `running` marks at least one observed claim;
 * `expired` marks TTL elapsed without a verified teardown;
 * `terminating`/`reap-requested`/`expired` are cleanup intents that any
 * provisioner-capable device may complete — the creator may be offline.
 */
export type EnvironmentState =
  | 'provisioning'
  | 'enrolled'
  | 'running'
  | 'suspended'
  | 'terminating'
  | 'terminated'
  | 'reap-requested'
  | 'expired'
  | 'failed';

export const ENVIRONMENT_STATES: readonly EnvironmentState[] = [
  'provisioning',
  'enrolled',
  'running',
  'suspended',
  'terminating',
  'terminated',
  'reap-requested',
  'expired',
  'failed',
];

/**
 * Account-visible environment record. `handle` is an opaque provider-side
 * reference (e.g. microVM identifier, sandbox id) the provisioner uses to
 * act on the environment — it is never a credential.
 */
export interface CloudEnvironment {
  environmentId: string;
  provider: EnvironmentProviderId;
  state: EnvironmentState;
  /** Opaque provider handle (bounded JSON). Absent until create returns. */
  handle?: Record<string, unknown>;
  /** The ephemeral enrollment the environment booted into, once observed. */
  enrollmentId?: string;
  /** The `provision-environment` job that requested it, when created via mesh. */
  jobId?: string;
  /** Enrollment that created the record (the provisioner or the env itself). */
  createdBy: string;
  /** ISO-8601 instant the environment must be reaped by, when bounded. */
  expiresAt?: string;
  reapRequestedAt?: string;
  reapedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Provision inputs -----------------------------------------------------

/**
 * `inputs` of a `provision-environment` job's ExecutionManifest. The
 * provisioner reads these to create the environment; everything else the
 * env needs (pairing payload, backend URL) is minted locally by the
 * provisioner and never journaled.
 */
export interface ProvisionEnvironmentInputs {
  /**
   * Pre-allocated environment record id — the source device mints it so
   * follow-up jobs can target `{kind:'environment', environmentId}` while
   * provisioning is still in flight.
   */
  environmentId: string;
  provider: EnvironmentProviderId;
  /** Hard lifetime cap for the environment; enforced provider-side. */
  ttlSeconds: number;
  /** Provider image/snapshot reference (e.g. Lambda MicroVM image ARN). */
  imageRef?: string;
  /** Egress allowlist the provider should enforce, when supported. */
  networkPolicy?: string[];
  resources?: { vcpus?: number; memoryMb?: number };
  /** Provisioner connection id on the claiming device (never the config). */
  connectionId?: string;
  /** Display label for the environment in device/environment listings. */
  displayName?: string;
}

// ---- Capability vocabulary -------------------------------------------------

/** Worker capability marking an enrollment as an ephemeral environment. */
export const EPHEMERAL_ENV_CAPABILITY = 'ephemeral-env';

/**
 * Capability prefix a worker advertises for each provider it can
 * provision (e.g. `provision:aws-lambda-microvm`). `provision-environment`
 * jobs target `kind:'auto'` with this requirement, so any device holding
 * matching provider credentials claims them.
 */
export const PROVISION_CAPABILITY_PREFIX = 'provision:';

export function provisionCapability(provider: EnvironmentProviderId): string {
  return `${PROVISION_CAPABILITY_PREFIX}${provider}`;
}

export function providerFromProvisionCapability(
  capability: string,
): EnvironmentProviderId | null {
  if (!capability.startsWith(PROVISION_CAPABILITY_PREFIX)) return null;
  const provider = capability.slice(PROVISION_CAPABILITY_PREFIX.length);
  return isEnvironmentProviderId(provider) ? provider : null;
}

/**
 * Capability prefix for credential-grant kinds an environment accepts
 * (e.g. `grant:credential-name`). Aligns with the control-plane
 * `modelAuth` vocabulary; grants are delivered fenced per attempt.
 */
export const GRANT_CAPABILITY_PREFIX = 'grant:';

// ---- RPC wire shapes --------------------------------------------------------
// Identity always comes from the authenticated session, never params.

/**
 * `environment.report` (worker role): upsert the record's lifecycle state.
 * The provisioner reports create/enroll/terminate progress; the
 * environment itself may link its enrollment once bootstrapped.
 */
export interface EnvironmentReportParams {
  environmentId: string;
  provider: EnvironmentProviderId;
  state: EnvironmentState;
  handle?: Record<string, unknown>;
  /** Self-report by the environment after it redeems its pairing payload. */
  enrollmentId?: string;
  jobId?: string;
  expiresAt?: string;
  /** Present only on terminal reports; distinguishes requested vs verified. */
  reaped?: boolean;
  error?: string;
}

export interface EnvironmentReportResult {
  environment: CloudEnvironment;
}

/** `environment.get`/`environment.list`: account-scoped reads. */
export interface EnvironmentGetParams {
  environmentId: string;
}

export interface EnvironmentGetResult {
  environment: CloudEnvironment;
}

export interface EnvironmentListParams {
  /** Include terminal environments (terminated/failed); default false. */
  includeTerminal?: boolean;
}

export interface EnvironmentListResult {
  environments: CloudEnvironment[];
}

/**
 * `environment.reap` (either role): durable cleanup intent. A user marks
 * `reap-requested`; a provisioner-capable worker (or the environment's
 * own terminate path) later reports `terminated` with `reaped: true`.
 * `environmentId` is the idempotency key — repeated calls are no-ops.
 */
export interface EnvironmentReapParams {
  environmentId: string;
}

export interface EnvironmentReapResult {
  environment: CloudEnvironment;
}

// ---- App-side provider contract --------------------------------------------
// Implemented in the device process that holds provider credentials
// (desktop or daemon). The backend never sees these objects.

export interface CloudEnvironmentCreateInput {
  /** The environment record id — the env needs it to self-report. */
  environmentId: string;
  /** The `anvil-pair-…` payload the environment redeems at boot. */
  bootstrapPayload: string;
  /** Sync backend URL the environment connects to. */
  backendUrl: string;
  imageRef?: string;
  ttlSeconds: number;
  networkPolicy?: string[];
  resources?: { vcpus?: number; memoryMb?: number };
}

/** Opaque provider-side handle returned by create/inspect. */
export interface CloudEnvironmentHandle {
  environmentId: string;
  /** Provider-native identifier (microVM id, sandbox id, …). */
  providerRef: string;
  /** Provider-specific metadata for re-attach after restart; never secrets. */
  meta?: Record<string, unknown>;
}

/**
 * The provisioner-side provider interface (ENV-03+). `create` returns once
 * the provider accepted the environment — enrollment happens
 * asynchronously inside it and is reported via `environment.report`.
 */
export interface CloudEnvironmentProvider {
  readonly id: EnvironmentProviderId;
  create(input: CloudEnvironmentCreateInput): Promise<CloudEnvironmentHandle>;
  inspect(
    handle: CloudEnvironmentHandle,
  ): Promise<'pending' | 'running' | 'suspended' | 'terminated' | 'unknown'>;
  suspend?(handle: CloudEnvironmentHandle): Promise<void>;
  resume?(handle: CloudEnvironmentHandle): Promise<void>;
  /** `requested` = terminate call accepted; `verified` = provider confirms gone. */
  terminate(handle: CloudEnvironmentHandle): Promise<'requested' | 'verified'>;
}
