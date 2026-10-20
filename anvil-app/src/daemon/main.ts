import { isPermissionMode } from '../../cloud/contract/permissions.js';
import {
  setMeshMaximumPermissionMode,
  getMeshWorkerStatus,
} from '../main/services/mesh-worker.service.js';
/**
 * anvil-daemon — headless Anvil host (DAEMON-01).
 *
 * Runs the sync runtime, mesh worker, and companion server as a plain
 * Node process on always-on machines. Hosted accounts use WorkOS sign-in;
 * compatible self-hosted backends can use enrollment codes. State lives
 * under ANVIL_DATA_DIR (default ~/.anvil-daemon). See
 * docs/runbooks/hosted-sync/headless-daemon.md.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDatabase } from '../main/db/database.js';
import { discover } from '../main/services/sync-backend-client.service.js';
import {
  getBackendStatus,
  listBackends,
  pinBackend,
} from '../main/services/sync-backend.service.js';
import {
  activeSyncScope,
  enrollEphemeralEnvironment,
  enrollWithEnrollmentCode,
  enableSync,
  getRuntimeStatus,
  initSyncRuntime,
  listCloudEnvironments,
  reapCloudEnvironment,
  refreshDeviceIdentitiesForOneShot,
  requestCloudEnvironment,
  setMeshWorkerOptIn,
  signOutSync,
  stopSyncRuntimeForOneShot,
} from '../main/services/sync-runtime.service.js';
import {
  addProviderConnection,
  listProviderConnections,
  removeProviderConnection,
} from '../main/services/cloud-environment.service.js';
import { isEnvironmentProviderId } from '../../cloud/contract/environment.js';
import { requiresDeviceProviderSignIn } from '../shared/sync-backend.js';
import {
  listCompanionEnrollmentPolicies,
  removeCompanionEnrollmentPolicy,
  setCompanionDefaultPolicyTier,
  setCompanionEnrollmentPolicy,
  setMobileCompanionEnabled,
  startMobileCompanionServer,
} from '../main/services/mobile-companion.service.js';
import {
  approveDeviceTrust,
  deviceVerificationCode,
  beginDeviceAuthorizationSignIn,
  getDeviceSecurityStatus,
  listDevices,
  replaceDeviceRecovery,
  setNewDeviceTrustPolicy,
  setupDeviceRecovery,
  unlockDeviceRecovery,
} from '../main/services/sync-runtime.service.js';
import {
  formatVerificationInstructions,
  formatDeviceList,
  formatDeviceSecurityStatus,
  formatSignInNextSteps,
  parseSecurityCommand,
  readRecoveryCode,
  resolveSetupPolicy,
  selectDevice,
  type SecurityCommand,
} from './security-cli.js';
import { parseSignInCommand, runSignIn } from './signin-cli.js';
import { parseEphemeralEnvironmentEnrollmentCommand } from './enroll-cli.js';
import { parseVaultCommand, readVaultPassphraseFromStdin } from './vault-cli.js';
import {
  configureSecretVault,
  unlockSecretVault,
  selectSecretStorageProvider,
} from '../main/services/auth.service.js';
import {
  getCredentialStorageStatus,
  migrateSavedCredentials,
} from '../main/services/credential-storage.service.js';

const DATA_DIR = process.env.ANVIL_DATA_DIR ?? join(process.env.HOME ?? '.', '.anvil-daemon');
const CONFIG_PATH = join(DATA_DIR, 'daemon.json');

type PolicyTier = 'observe' | 'approve' | 'steer' | 'denied';
const TIERS: PolicyTier[] = ['observe', 'approve', 'steer', 'denied'];

interface DaemonConfig {
  defaultPolicyTier?: PolicyTier | 'pending';
  worker?: boolean;
  companion?: boolean;
}

function readConfig(): DaemonConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as DaemonConfig;
  } catch {
    return {};
  }
}

function writeConfig(patch: Partial<DaemonConfig>): DaemonConfig {
  const next = { ...readConfig(), ...patch };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function usage(): never {
  console.log(`anvil-daemon — headless Anvil host

  anvil-daemon enroll --api-url <url> (--code <code> | --pair <payload>) [--worker]
  anvil-daemon enroll-environment --api-url <url> --code <ephemeral-code> --worker
  anvil-daemon sign-in --api-url <url> [--worker]
  anvil-daemon run
  anvil-daemon run --vault-passphrase-stdin
  anvil-daemon vault status
  anvil-daemon vault setup --passphrase-stdin
  anvil-daemon vault setup --key-file <absolute-path-outside-data-dir>
  anvil-daemon vault use keychain|vault
  anvil-daemon vault migrate [--vault-passphrase-stdin]
  anvil-daemon status [--json]
  anvil-daemon security status [--json]
  anvil-daemon security devices [--json]
  anvil-daemon security verify <device-number|enrollmentId>
  anvil-daemon security approve <device-number|enrollmentId> --verification-code <NNN-NNN-NNN>
  anvil-daemon security setup [--policy <require-approval|auto-trust-authenticated>]
    WorkOS default: automatic connection. Use --policy require-approval for manual approval.
  anvil-daemon security unlock (--stdin | --file <protected-file>)
  anvil-daemon security policy <require-approval|auto-trust-authenticated>
  anvil-daemon security recovery-replace
  anvil-daemon sign-out
  anvil-daemon worker on|off
  anvil-daemon worker mode [read-only|on-request|workspace-auto|full-access]
  anvil-daemon companion on|off
  anvil-daemon provider list
  anvil-daemon provider add <provider> [--name <name>] [--config <json>] [--secret <json>]
  anvil-daemon provider remove <connectionId>
  anvil-daemon env list [--all]
  anvil-daemon env request <provider> --ttl <seconds> [--image <ref>] [--name <name>] [--connection <id>]
  anvil-daemon env terminate <environmentId>
  anvil-daemon policy list
  anvil-daemon policy set <enrollmentId> <observe|approve|steer|denied>
  anvil-daemon policy forget <enrollmentId>
  anvil-daemon policy default-tier <observe|approve|steer|denied|pending>

Hosted WorkOS backends require sign-in; the CLI enroll --code/--pair
path is for compatible self-hosted backends. Internal ephemeral environment
enrollment uses enroll-environment; the backend verifies that the single-use
code is class-bound to an ephemeral environment.
Provider connections hold cloud environment credentials (AWS region/keys,
imageIdentifier in --config; keys in --secret, encrypted at rest) so this
host can claim provision-environment jobs.

State dir: ANVIL_DATA_DIR (current: ${DATA_DIR})`);
  process.exit(1);
}

function boot(): void {
  initDatabase();
  const config = readConfig();
  if (config.defaultPolicyTier !== undefined && config.defaultPolicyTier !== 'pending') {
    setCompanionDefaultPolicyTier(config.defaultPolicyTier);
  }
  initSyncRuntime(DATA_DIR, {
    openExternal: (url) => console.log(`[anvil-daemon] openExternal: ${url}`),
  });
}

async function cmdEnroll(): Promise<void> {
  const apiUrl = arg('--api-url');
  // Human device enrollment on hosted WorkOS backends goes through `sign-in`.
  // Runtime-only ephemeral environment enrollment stays outside this CLI.
  const code = arg('--pair') ?? arg('--code');
  if (!apiUrl || !code) {
    console.error('enroll requires --api-url <url> and (--code <code> | --pair <payload>)');
    process.exit(1);
  }
  boot();
  const conn = await discover(apiUrl, {
    allowLoopbackHttp: apiUrl.includes('127.0.0.1') || apiUrl.includes('localhost'),
  });
  const matchingBackend = listBackends().find(
    (backend) => backend.deploymentId === conn.descriptor.deploymentId,
  );
  const isHostedBackend = requiresDeviceProviderSignIn({
    connectionMode: matchingBackend?.connectionMode ?? 'compatible',
    authModes: conn.descriptor.authModes,
    baseUrl: conn.baseUrl,
    hostedBackendUrl: getBackendStatus().hostedBackendUrl,
  });
  if (isHostedBackend) {
    throw new Error(
      'This backend uses hosted sign-in. Run `anvil-daemon sign-in --api-url <backend-url>`; enrollment codes and pairing payloads are not accepted here.',
    );
  }
  pinBackend({ baseUrl: conn.baseUrl, descriptor: conn.descriptor });
  await enrollWithEnrollmentCode(code);
  enableSync();
  await setMobileCompanionEnabled(true);
  if (hasFlag('--worker') || readConfig().worker === true) {
    await setMeshWorkerOptIn(true);
  }
  console.log('[anvil-daemon] enrolled and sync enabled.');
  console.log(
    hasFlag('--worker') || readConfig().worker === true
      ? 'Mesh worker: enabled for this host by explicit opt-in.'
      : 'Mesh worker: off. Use `anvil-daemon worker on` only if this host should run jobs.',
  );
  console.log('Run `anvil-daemon run` to keep syncing and serve the companion app.');
}

/** Internal image bootstrap for server-issued ephemeral environment codes. */
async function cmdEnrollEnvironment(args: readonly string[]): Promise<void> {
  const command = parseEphemeralEnvironmentEnrollmentCommand(args);
  boot();
  const apiUrl = new URL(command.apiUrl);
  const conn = await discover(command.apiUrl, {
    allowLoopbackHttp: apiUrl.protocol === 'http:',
  });
  pinBackend({ baseUrl: conn.baseUrl, descriptor: conn.descriptor });
  await enrollEphemeralEnvironment(command.enrollmentCode);
  enableSync();
  writeConfig({ worker: true, companion: false });
  await setMeshWorkerOptIn(true);
  console.log('[anvil-daemon] ephemeral environment enrolled; mesh worker enabled.');
}

/**
 * WorkOS Device Authorization is deliberately a one-shot command. It pins
 * the reviewed backend before starting the flow, persists the session in the
 * runtime's encrypted store, and leaves long-running sync/worker activity to
 * `run`. The worker flag only records an explicit device-local opt-in.
 */
async function cmdSignIn(args: readonly string[]): Promise<void> {
  const command = parseSignInCommand(args);
  boot();
  const existingAuth = getRuntimeStatus().auth;
  if (existingAuth.state !== 'signed-out') {
    throw new Error(
      'this daemon already has a sign-in in progress or an active session; run sign-out first',
    );
  }

  const conn = await discover(command.apiUrl, {
    allowLoopbackHttp: command.apiUrl.includes('127.0.0.1') || command.apiUrl.includes('localhost'),
  });
  pinBackend({ baseUrl: conn.baseUrl, descriptor: conn.descriptor });

  const result = await runSignIn({
    start: (signal) => beginDeviceAuthorizationSignIn(signal, { startRuntime: false }),
    onSuccess: () => {
      if (command.worker) writeConfig({ worker: true });
    },
    nextSteps: async () =>
      formatSignInNextSteps(
        await getDeviceSecurityStatus(),
        command.worker || readConfig().worker === true,
        conn.descriptor.authModes.includes('workos-device'),
      ),
  });
  process.exitCode = result.exitCode;
}

async function cmdRun(): Promise<void> {
  boot();
  let status = getRuntimeStatus();
  if (!status.auth || status.auth.state !== 'signed-in') {
    console.error('[anvil-daemon] not signed in — run `anvil-daemon sign-in` or `enroll` first');
    process.exit(1);
  }
  if (!status.syncEnabled) {
    enableSync();
  }
  const config = readConfig();
  if (config.companion !== false) {
    await setMobileCompanionEnabled(true);
    await startMobileCompanionServer();
  }
  if (config.worker === true) {
    await setMeshWorkerOptIn(true);
  }
  const runningStatus = getRuntimeStatus();
  console.log(
    `[anvil-daemon] running — sync ${runningStatus.connectionState}; mesh worker ${runningStatus.meshWorker.enabled ? 'enabled' : 'off'}.`,
  );

  const shutdown = (signal: string) => {
    console.log(`[anvil-daemon] ${signal} — shutting down`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  setInterval(() => undefined, 60_000); // keepalive — real work rides sockets/timers
}

function formatRuntimeStatus(status: ReturnType<typeof getRuntimeStatus>): string {
  const authLabel =
    status.auth.state === 'signed-in'
      ? 'signed in'
      : status.auth.state === 'enrolling'
        ? 'sign-in in progress'
        : 'signed out';
  const lines = [
    'Anvil daemon status',
    `  Sign-in: ${authLabel}`,
    `  Sync: ${status.syncEnabled ? status.connectionState : 'stopped'}`,
    `  Mesh worker: ${status.meshWorker.enabled ? `enabled (${status.meshWorker.maxPermissionMode})` : 'off'}`,
    `  Pending changes: ${status.pendingCount}`,
    `  Conflicts: ${status.conflictCount}`,
  ];
  if (status.sessionExpired) lines.push('  Session: expired; sign in again.');
  if (status.auth.state === 'signed-out') {
    lines.push('', 'Next: sign in with `anvil-daemon sign-in --api-url <url>`.');
  } else if (!status.syncEnabled) {
    lines.push('', 'Next: run `anvil-daemon run` to start syncing.');
  }
  return lines.join('\n');
}

function cmdStatus(args: readonly string[]): void {
  boot();
  const status = getRuntimeStatus();
  if (args.length === 1 && args[0] === '--json') {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (args.length !== 0) {
    throw new Error('usage: anvil-daemon status [--json]');
  }
  console.log(formatRuntimeStatus(status));
}

/**
 * Headless device security controls. Recovery codes are intentionally read
 * only from stdin or an owner-only file; they are never accepted in argv or
 * environment variables. Setup and replacement print the newly generated
 * code exactly once so a caller can save it before the process exits.
 */
async function cmdSecurity(args: readonly string[]): Promise<void> {
  const command: SecurityCommand = parseSecurityCommand(args);
  boot();
  try {
    if (getRuntimeStatus().auth.state !== 'signed-in') {
      throw new Error('sign in first with `anvil-daemon sign-in --api-url <url>`.');
    }
    if (command.kind === 'devices' || command.kind === 'verify' || command.kind === 'approve') {
      await refreshDeviceIdentitiesForOneShot();
    }
    switch (command.kind) {
      case 'status': {
        const status = await getDeviceSecurityStatus();
        console.log(
          command.json
            ? JSON.stringify(status, null, 2)
            : formatDeviceSecurityStatus(
                status,
                getBackendStatus().authModes.includes('workos-device'),
              ),
        );
        return;
      }
      case 'devices': {
        const result = await listDevices();
        console.log(
          command.json ? JSON.stringify(result, null, 2) : formatDeviceList(result.devices),
        );
        return;
      }
      case 'verify': {
        const devices = await listDevices();
        const selected = selectDevice(command.target, devices.devices);
        const result = deviceVerificationCode(selected.enrollmentId);
        console.log(formatVerificationInstructions(selected, result.code));
        return;
      }
      case 'approve': {
        const devices = await listDevices();
        const selected = selectDevice(command.target, devices.devices);
        await approveDeviceTrust(selected.enrollmentId, command.verificationCode);
        console.log(
          `[anvil-daemon] approved ${selected.name} (#${selected.number}) on this device.`,
        );
        return;
      }
      case 'setup': {
        const securityStatus = await getDeviceSecurityStatus();
        const policy = resolveSetupPolicy(
          command.policy,
          securityStatus,
          getBackendStatus().authModes,
        );
        const result = await setupDeviceRecovery(policy);
        console.log(
          [
            'Recovery code (shown once):',
            result.recoveryCode,
            '',
            'Save this code in a secure place. It unlocks encrypted account data on a new device.',
            `New-device access: ${policy === 'auto-trust-authenticated' ? 'automatic connection for authenticated devices' : 'manual device verification and approval'}.`,
          ].join('\n'),
        );
        return;
      }
      case 'unlock': {
        const code = readRecoveryCode(command.source);
        console.log(
          formatDeviceSecurityStatus(
            await unlockDeviceRecovery(code),
            getBackendStatus().authModes.includes('workos-device'),
          ),
        );
        return;
      }
      case 'policy': {
        const status = await setNewDeviceTrustPolicy(command.policy);
        console.log(
          formatDeviceSecurityStatus(
            status,
            getBackendStatus().authModes.includes('workos-device'),
          ),
        );
        return;
      }
      case 'recovery-replace': {
        const result = await replaceDeviceRecovery();
        console.log(
          [
            'Replacement recovery code (shown once):',
            result.recoveryCode,
            '',
            'Save this code in a secure place. Older recovery codes will no longer unlock newly rotated keys.',
          ].join('\n'),
        );
        return;
      }
    }
  } finally {
    // `boot()` may have restored a signed-in runtime with refresh/poll/live
    // timers. Security commands are one-shot and must leave only the saved
    // session behind for a later explicit `run`.
    stopSyncRuntimeForOneShot();
  }
}

/**
 * ENV-03: provider connections let this host claim `provision-environment`
 * jobs. Secret material is encrypted at rest via safeStorage-equivalent
 * storage and never leaves the device.
 */
function cmdProvider(sub: string | undefined): void {
  boot();
  const scope = activeSyncScope();
  if (scope === null) {
    console.error('[anvil-daemon] not enrolled — run `anvil-daemon enroll` first');
    process.exit(1);
  }
  switch (sub) {
    case 'list': {
      console.log(JSON.stringify(listProviderConnections(scope), null, 2));
      return;
    }
    case 'add': {
      const provider = process.argv[4];
      if (!isEnvironmentProviderId(provider)) {
        console.error(
          'usage: provider add <aws-lambda-microvm|cloudflare-sandbox|vercel-sandbox|anvil-managed> [--name <name>] [--config <json>] [--secret <json>]',
        );
        process.exit(1);
      }
      const configText = arg('--config');
      const secretText = arg('--secret');
      let config: Record<string, unknown> = {};
      if (configText !== undefined) {
        try {
          const parsed: unknown = JSON.parse(configText);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('not an object');
          }
          config = parsed as Record<string, unknown>;
        } catch {
          console.error('[anvil-daemon] --config must be a JSON object');
          process.exit(1);
        }
      }
      if (secretText !== undefined) {
        try {
          const parsed: unknown = JSON.parse(secretText);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('not an object');
          }
        } catch {
          console.error('[anvil-daemon] --secret must be a JSON object');
          process.exit(1);
        }
      }
      const created = addProviderConnection(scope, {
        provider,
        ...(arg('--name') === undefined ? {} : { displayName: arg('--name') }),
        config,
        ...(secretText === undefined ? {} : { secret: secretText }),
      });
      console.log(JSON.stringify(created, null, 2));
      return;
    }
    case 'remove': {
      const connectionId = process.argv[4];
      if (!connectionId) {
        console.error('usage: provider remove <connectionId>');
        process.exit(1);
      }
      const removed = removeProviderConnection(scope, connectionId);
      if (!removed) {
        console.error(`[anvil-daemon] no provider connection ${connectionId}`);
        process.exit(1);
      }
      console.log(`[anvil-daemon] removed ${connectionId}`);
      return;
    }
    default:
      usage();
  }
}

/**
 * ENV-01/ENV-09: `env request` creates a `provision-environment` job —
 * `anvil-managed` provisions on Anvil capacity (an enrollment code staged via
 * environment.bootstrap), BYO providers wait for a provisioner-capable
 * device holding the connection. `env terminate` records durable reap
 * intent; teardown lands wherever the provider lives.
 */
async function cmdEnv(sub: string | undefined): Promise<void> {
  boot();
  switch (sub) {
    case 'list': {
      const listed = await listCloudEnvironments(process.argv[4] === '--all');
      console.log(JSON.stringify(listed.environments, null, 2));
      return;
    }
    case 'request': {
      const provider = process.argv[4];
      const ttlSeconds = Number(arg('--ttl'));
      if (!isEnvironmentProviderId(provider) || !Number.isFinite(ttlSeconds) || ttlSeconds < 60) {
        console.error(
          'usage: env request <aws-lambda-microvm|cloudflare-sandbox|vercel-sandbox|anvil-managed> --ttl <seconds> [--image <ref>] [--name <name>] [--connection <id>]',
        );
        process.exit(1);
      }
      const requested = await requestCloudEnvironment({
        provider,
        ttlSeconds,
        ...(arg('--image') === undefined ? {} : { imageRef: arg('--image') }),
        ...(arg('--name') === undefined ? {} : { displayName: arg('--name') }),
        ...(arg('--connection') === undefined ? {} : { connectionId: arg('--connection') }),
      });
      console.log(JSON.stringify(requested, null, 2));
      return;
    }
    case 'terminate': {
      const environmentId = process.argv[4];
      if (!environmentId) {
        console.error('usage: env terminate <environmentId>');
        process.exit(1);
      }
      const reaped = await reapCloudEnvironment(environmentId);
      console.log(JSON.stringify(reaped.environment, null, 2));
      return;
    }
    default:
      usage();
  }
}

async function cmdPolicy(sub: string | undefined): Promise<void> {
  boot();
  switch (sub) {
    case 'list': {
      const policies = listCompanionEnrollmentPolicies();
      console.log(JSON.stringify(policies, null, 2));
      return;
    }
    case 'set': {
      const enrollmentId = process.argv[4];
      const tier = process.argv[5] as PolicyTier;
      if (!enrollmentId || !TIERS.includes(tier)) {
        console.error('usage: policy set <enrollmentId> <observe|approve|steer|denied>');
        process.exit(1);
      }
      const updated = setCompanionEnrollmentPolicy(enrollmentId, tier);
      if (updated === null) {
        console.error(
          `[anvil-daemon] no policy row for ${enrollmentId} — device must contact this host first`,
        );
        process.exit(1);
      }
      console.log(JSON.stringify(updated, null, 2));
      return;
    }
    case 'forget': {
      const enrollmentId = process.argv[4];
      if (!enrollmentId) {
        console.error('usage: policy forget <enrollmentId>');
        process.exit(1);
      }
      removeCompanionEnrollmentPolicy(enrollmentId);
      console.log(`[anvil-daemon] forgot ${enrollmentId} — next contact re-pends`);
      return;
    }
    case 'default-tier': {
      const tier = process.argv[4] as PolicyTier | 'pending';
      if (![...TIERS, 'pending'].includes(tier)) {
        console.error('usage: policy default-tier <observe|approve|steer|denied|pending>');
        process.exit(1);
      }
      writeConfig({ defaultPolicyTier: tier });
      setCompanionDefaultPolicyTier(tier === 'pending' ? null : tier);
      console.log(`[anvil-daemon] default policy tier: ${tier}`);
      return;
    }
    default:
      usage();
  }
}

async function main(): Promise<void> {
  // Unlock in the process that performs the command, never in a one-shot
  // unlock process whose in-memory key would disappear immediately.
  if (hasFlag('--vault-passphrase-stdin')) {
    if (process.argv.filter((value) => value === '--vault-passphrase-stdin').length !== 1)
      throw new Error('Supply --vault-passphrase-stdin once.');
    await unlockSecretVault(readVaultPassphraseFromStdin());
    process.argv = process.argv.filter((value) => value !== '--vault-passphrase-stdin');
  }
  const command = process.argv[2];
  switch (command) {
    case 'vault': {
      const action = parseVaultCommand(process.argv.slice(3));
      initDatabase();
      if (action.kind === 'setup') {
        await configureSecretVault(
          action.mode === 'passphrase'
            ? { mode: action.mode, passphrase: readVaultPassphraseFromStdin() }
            : { mode: action.mode, keyFilePath: action.keyFilePath },
        );
        console.log(JSON.stringify(migrateSavedCredentials()));
      } else if (action.kind === 'use') {
        selectSecretStorageProvider(action.provider);
      } else if (action.kind === 'migrate') {
        console.log(JSON.stringify(migrateSavedCredentials()));
      }
      console.log(JSON.stringify(getCredentialStorageStatus()));
      break;
    }
    case 'enroll':
      await cmdEnroll();
      break;
    case 'enroll-environment':
      await cmdEnrollEnvironment(process.argv.slice(3));
      break;
    case 'run':
      await cmdRun();
      break;
    case 'sign-in':
      await cmdSignIn(process.argv.slice(3));
      break;
    case 'status':
      cmdStatus(process.argv.slice(3));
      break;
    case 'security':
      await cmdSecurity(process.argv.slice(3));
      break;
    case 'sign-out':
      boot();
      await signOutSync();
      console.log('[anvil-daemon] signed out');
      break;
    case 'worker': {
      boot();
      const action = process.argv[3];
      if (action === 'mode') {
        const mode = process.argv[4];
        try {
          if (mode === undefined) console.log(getMeshWorkerStatus().maxPermissionMode);
          else {
            if (!isPermissionMode(mode))
              throw new Error('Use read-only, on-request, workspace-auto, or full-access.');
            await setMeshMaximumPermissionMode(mode);
            console.log(`[anvil-daemon] maximum job permission mode: ${mode}`);
          }
        } finally {
          stopSyncRuntimeForOneShot();
        }
        break;
      }
      if (action !== 'on' && action !== 'off') throw new Error('Use worker on, off, or mode.');
      const on = action === 'on';
      try {
        await setMeshWorkerOptIn(on);
        writeConfig({ worker: on });
        console.log(`[anvil-daemon] mesh worker ${on ? 'enabled' : 'disabled'}`);
      } finally {
        // The worker command saves an opt-in; `run` owns its long-lived lease.
        stopSyncRuntimeForOneShot();
      }
      break;
    }
    case 'companion': {
      boot();
      const on = process.argv[3] === 'on';
      await setMobileCompanionEnabled(on);
      writeConfig({ companion: on });
      console.log(`[anvil-daemon] companion server ${on ? 'enabled' : 'disabled'}`);
      break;
    }
    case 'provider':
      cmdProvider(process.argv[3]);
      break;
    case 'env':
      await cmdEnv(process.argv[3]);
      break;
    case 'policy':
      await cmdPolicy(process.argv[3]);
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`[anvil-daemon] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
