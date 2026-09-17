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
  enrollWithEnrollmentCode,
  enableSync,
  getRuntimeStatus,
  initSyncRuntime,
  setMeshWorkerOptIn,
  signOutSync,
} from '../main/services/sync-runtime.service.js';
import {
  listCompanionEnrollmentPolicies,
  removeCompanionEnrollmentPolicy,
  setCompanionDefaultPolicyTier,
  setCompanionEnrollmentPolicy,
  setMobileCompanionEnabled,
  startMobileCompanionServer,
} from '../main/services/mobile-companion.service.js';

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
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usage(): never {
  console.log(`anvil-daemon — headless Anvil host

  anvil-daemon enroll --api-url <url> --code <code> [--worker]
  anvil-daemon run
  anvil-daemon status
  anvil-daemon sign-out
  anvil-daemon worker on|off
  anvil-daemon companion on|off
  anvil-daemon policy list
  anvil-daemon policy set <enrollmentId> <observe|approve|steer|denied>
  anvil-daemon policy forget <enrollmentId>
  anvil-daemon policy default-tier <observe|approve|steer|denied|pending>

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
  const code = arg('--code');
  if (!apiUrl || !code) {
    console.error('enroll requires --api-url <url> and --code <code>');
    process.exit(1);
  }
  boot();
  const conn = await discover(apiUrl, { allowLoopbackHttp: apiUrl.includes('127.0.0.1') || apiUrl.includes('localhost') });
  pinBackend({ baseUrl: conn.baseUrl, descriptor: conn.descriptor });
  const snapshot = await enrollWithEnrollmentCode(code);
  enableSync();
  await setMobileCompanionEnabled(true);
  if (arg('--worker') !== undefined || readConfig().worker === true) {
    await setMeshWorkerOptIn(true);
  }
  console.log(`[anvil-daemon] enrolled: ${JSON.stringify(snapshot)}`);
}

async function cmdRun(): Promise<void> {
  boot();
  const status = getRuntimeStatus();
  if (!status.auth || status.auth.state !== 'signed-in') {
    console.error('[anvil-daemon] not enrolled — run `anvil-daemon enroll` first');
    process.exit(1);
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
        console.error(`[anvil-daemon] no policy row for ${enrollmentId} — device must contact this host first`);
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
    case 'status':
      cmdStatus();
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
