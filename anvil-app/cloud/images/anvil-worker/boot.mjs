#!/usr/bin/env node
/**
 * anvil-worker boot — provisioner-independent entrypoint for cloud agent
 * environments. Reads the mesh-environment bootstrap document, enrolls the
 * headless daemon via its ephemeral enrollment code, then runs the worker
 * under a TTL watchdog.
 *
 * Bootstrap channels (first wins):
 *   1. argv[2] — raw JSON (provider run-hook style injection)
 *   2. $ANVIL_BOOTSTRAP_JSON — env-carried JSON (Vercel env, Cloudflare exec env)
 *   3. $ANVIL_BOOTSTRAP_FILE — path to a JSON file
 *   4. /run/anvil/bootstrap.json — conventional mount point
 *
 * Payload:
 *   {
 *     kind: 'anvil.mesh-environment', schemaVersion: '0.2',
 *     environmentId, provider, backendUrl, enrollmentCode, ttlSeconds,
 *     networkPolicy?
 *   }
 *
 * The enrollment code is the only secret: authentication-only, single-use,
 * class-bound 'ephemeral'. Account key material must NEVER ride this
 * channel — task content keys arrive via taskkey.* wraps after claim.
 * Legacy `pairing` payloads (anvil-pair-…, which carry keying material)
 * are rejected outright.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, 'anvil-daemon.mjs');
const DEFAULT_BOOTSTRAP_FILE = '/run/anvil/bootstrap.json';
const DATA_DIR = process.env.ANVIL_DATA_DIR ?? '/var/lib/anvil';
const TTL_GRACE_MS = 60_000;

function log(msg) {
  console.log(`[anvil-worker] ${msg}`);
}

function fail(msg) {
  console.error(`[anvil-worker] ${msg}`);
  process.exit(1);
}

export function parseBootstrapPayload(raw) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error('bootstrap payload is not valid JSON');
  }
  if (doc?.kind !== 'anvil.mesh-environment' || doc?.schemaVersion !== '0.2') {
    throw new Error('unrecognized bootstrap document (want kind=anvil.mesh-environment, schemaVersion=0.2)');
  }
  for (const field of ['environmentId', 'backendUrl', 'enrollmentCode']) {
    if (typeof doc[field] !== 'string' || doc[field].length === 0) {
      throw new Error(`bootstrap missing ${field}`);
    }
  }
  // Fail closed on the legacy secret-bearing form — an environment must
  // never receive account key material through bootstrap.
  if (typeof doc.pairing === 'string' || doc.enrollmentCode.startsWith('anvil-pair-')) {
    throw new Error('bootstrap carries account keying material — environments accept enrollment codes only');
  }
  if (typeof doc.ttlSeconds !== 'number' || !(doc.ttlSeconds > 0)) {
    throw new Error('bootstrap missing positive ttlSeconds');
  }
  return doc;
}

export function readBootstrap(
  argv = process.argv,
  env = process.env,
  readFile = (p) => readFileSync(p, 'utf8'),
) {
  const raw =
    argv[2] ??
    env.ANVIL_BOOTSTRAP_JSON ??
    (env.ANVIL_BOOTSTRAP_FILE ? readFile(env.ANVIL_BOOTSTRAP_FILE) : undefined) ??
    (existsSync(DEFAULT_BOOTSTRAP_FILE) ? readFile(DEFAULT_BOOTSTRAP_FILE) : undefined);
  if (raw === undefined) {
    throw new Error(
      'no bootstrap payload — provide argv JSON, $ANVIL_BOOTSTRAP_JSON, $ANVIL_BOOTSTRAP_FILE, or /run/anvil/bootstrap.json',
    );
  }
  return parseBootstrapPayload(raw);
}

function daemon(args, env) {
  return spawn('node', [DAEMON, ...args], { env, stdio: 'inherit' });
}

async function main() {
  const boot = readBootstrap();
  // The enrollment code is consumed once by enroll — don't carry it in this
  // process's env for the worker's whole lifetime.
  delete process.env.ANVIL_BOOTSTRAP_JSON;
  mkdirSync(DATA_DIR, { recursive: true });

  // Ephemeral environment: worker on, companion off (no inbound devices will
  // ever talk to a cloud env's companion server).
  writeFileSync(
    join(DATA_DIR, 'daemon.json'),
    JSON.stringify({ worker: true, companion: false }, null, 2),
    { mode: 0o600 },
  );

  const env = {
    ...process.env,
    ANVIL_DATA_DIR: DATA_DIR,
    // Mesh worker self-report: ephemeral-env capability + environment.report
    // 'enrolled' once worker.connect succeeds.
    ANVIL_ENVIRONMENT_ID: boot.environmentId,
    ANVIL_ENVIRONMENT_PROVIDER: boot.provider ?? 'unknown',
  };

  log(`booting environment ${boot.environmentId} (provider=${env.ANVIL_ENVIRONMENT_PROVIDER}, ttl=${boot.ttlSeconds}s)`);

  const enroll = daemon(
    ['enroll', '--api-url', boot.backendUrl, '--code', boot.enrollmentCode, '--worker'],
    env,
  );
  const enrollCode = await new Promise((resolve) => enroll.on('exit', resolve));
  if (enrollCode !== 0) fail(`enroll exited ${enrollCode}`);
  log('enrolled — starting worker');

  const ttlMs = Math.min(boot.ttlSeconds, 24 * 3600) * 1000;
  const run = daemon(['run'], env);
  let expired = false;
  const ttlTimer = setTimeout(() => {
    expired = true;
    log('ttl elapsed — stopping worker');
    run.kill('SIGTERM');
    setTimeout(() => run.kill('SIGKILL'), TTL_GRACE_MS).unref();
  }, ttlMs);
  ttlTimer.unref();

  const code = await new Promise((resolve) => run.on('exit', resolve));
  clearTimeout(ttlTimer);
  log(`worker exited ${code}${expired ? ' (ttl)' : ''}`);
  process.exit(expired ? 0 : (code ?? 1));
}

// Invoked as script vs imported for tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
