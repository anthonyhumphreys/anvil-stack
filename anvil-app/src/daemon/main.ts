/**
 * anvil-daemon — headless Anvil host (DAEMON-01).
 *
 * Runs the sync runtime, mesh worker, and companion server as a plain
 * Node process on always-on machines. Enrollment is code-only; policy
 * grants are CLI-managed; state lives under ANVIL_DATA_DIR (default
 * ~/.anvil-daemon). See docs/runbooks/hosted-sync/headless-daemon.md.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDatabase } from '../main/db/database.js';
import { discover } from '../main/services/sync-backend-client.service.js';
import { pinBackend } from '../main/services/sync-backend.service.js';
import {
  activeSyncScope,
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
  formatVerificationCode,
  parseSecurityCommand,
  readRecoveryCode,
  type SecurityCommand,
} from './security-cli.js';
import { parseSignInCommand, runSignIn } from './signin-cli.js';

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
  anvil-daemon sign-in --api-url <url> [--worker]
  anvil-daemon run
  anvil-daemon status
  anvil-daemon security status
  anvil-daemon security devices
  anvil-daemon security verify <enrollmentId>
  anvil-daemon security approve <enrollmentId> --verification-code <NNN-NNN-NNN>
  anvil-daemon security setup [--policy <require-approval|auto-trust-authenticated>]
  anvil-daemon security unlock (--stdin | --file <protected-file>)
  anvil-daemon security policy <require-approval|auto-trust-authenticated>
  anvil-daemon security recovery-replace
  anvil-daemon sign-out
  anvil-daemon worker on|off
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

--pair accepts an anvil-pair-… payload for user-device pairing. Environment
enrollments use a plain code and remain task-key-only.
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
  // --pair redeems an anvil-pair-… payload for a user-device pairing;
  // --code stays the plain enrollment-code path used by ordinary and
  // environment enrollments. Environment enrollments remain task-key-only
  // and never receive account ADKs through this command.
  const code = arg('--pair') ?? arg('--code');
  if (!apiUrl || !code) {
    console.error('enroll requires --api-url <url> and (--code <code> | --pair <payload>)');
    process.exit(1);
  }
  boot();
  const conn = await discover(apiUrl, {
    allowLoopbackHttp: apiUrl.includes('127.0.0.1') || apiUrl.includes('localhost'),
  });
  pinBackend({ baseUrl: conn.baseUrl, descriptor: conn.descriptor });
  const snapshot = await enrollWithEnrollmentCode(code);
  enableSync();
  await setMobileCompanionEnabled(true);
  if (hasFlag('--worker') || readConfig().worker === true) {
    await setMeshWorkerOptIn(true);
  }
  console.log(`[anvil-daemon] enrolled: ${JSON.stringify(snapshot)}`);
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
  console.log(`[anvil-daemon] running — status: ${JSON.stringify(getRuntimeStatus())}`);

  const shutdown = (signal: string) => {
    console.log(`[anvil-daemon] ${signal} — shutting down`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  setInterval(() => undefined, 60_000); // keepalive — real work rides sockets/timers
}

function cmdStatus(): void {
  boot();
  const status = getRuntimeStatus();
  console.log(JSON.stringify(status, null, 2));
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
    if (command.kind === 'devices' || command.kind === 'verify' || command.kind === 'approve') {
      await refreshDeviceIdentitiesForOneShot();
    }
    switch (command.kind) {
      case 'status':
        console.log(JSON.stringify(await getDeviceSecurityStatus(), null, 2));
        return;
      case 'devices':
        console.log(JSON.stringify(await listDevices(), null, 2));
        return;
      case 'verify': {
        const result = deviceVerificationCode(command.enrollmentId);
        console.log(formatVerificationCode(result.code));
        return;
      }
      case 'approve':
        await approveDeviceTrust(command.enrollmentId, command.verificationCode);
        console.log(`[anvil-daemon] device ${command.enrollmentId} approved`);
        return;
      case 'setup': {
        const result = await setupDeviceRecovery(command.policy);
        console.log(result.recoveryCode);
        return;
      }
      case 'unlock': {
        const code = readRecoveryCode(command.source);
        console.log(JSON.stringify(await unlockDeviceRecovery(code), null, 2));
        return;
      }
      case 'policy':
        console.log(JSON.stringify(await setNewDeviceTrustPolicy(command.policy), null, 2));
        return;
      case 'recovery-replace': {
        const result = await replaceDeviceRecovery();
        console.log(result.recoveryCode);
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
  const command = process.argv[2];
  switch (command) {
    case 'enroll':
      await cmdEnroll();
      break;
    case 'run':
      await cmdRun();
      break;
    case 'sign-in':
      await cmdSignIn(process.argv.slice(3));
      break;
    case 'status':
      cmdStatus();
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
      const on = process.argv[3] === 'on';
      await setMeshWorkerOptIn(on);
      writeConfig({ worker: on });
      console.log(`[anvil-daemon] mesh worker ${on ? 'enabled' : 'disabled'}`);
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
