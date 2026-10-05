#!/usr/bin/env node

// One disposable synthetic account, one staging allocation; transport only.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const target = Object.freeze({
  name: 'anvil-sync-hosted-staging',
  base: 'https://anvil-sync-hosted-staging.still-glitter-7d20.workers.dev',
  account: '715060911f9418f1df0f9de0265d8a64',
  zone: 'aa52d2318e7bb29a10e3d54c27153ca4',
  domain: 'anvilstack.dev',
});
const cfApi = 'https://api.cloudflare.com/client/v4';
const cloudflared = '/opt/homebrew/bin/cloudflared';
const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
let interrupted = false;
let cleaningUp = false;

const onSignal = () => {
  interrupted = true;
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

class Failure extends Error {
  constructor(code, status = null) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function credentialsArg() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: node scripts/managed-endpoint-smoke.mjs --credentials-file <0600-json-file>\n',
    );
    return null;
  }
  if (args.length !== 2 || args[0] !== '--credentials-file' || !args[1]) throw new Failure('usage');
  return resolve(args[1]);
}

async function loadCredentials(path) {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size < 2 || opened.size > 16_384)
      throw new Failure('credentials-file-invalid');
    if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600)
      throw new Failure('credentials-file-mode');
    if (typeof process.getuid === 'function' && opened.uid !== process.getuid())
      throw new Failure('credentials-file-owner');
    const data = JSON.parse(await handle.readFile('utf8'));
    const keys = [
      'enrollmentAdminToken',
      'cloudflareApiToken',
      'cloudflareAccountId',
      'cloudflareZoneId',
      'domain',
    ];
    if (
      !record(data) ||
      Object.keys(data).some((key) => !keys.includes(key)) ||
      keys.some((key) => !(key in data))
    ) {
      throw new Failure('credentials-shape');
    }
    if (
      typeof data.enrollmentAdminToken !== 'string' ||
      data.enrollmentAdminToken.length < 20 ||
      typeof data.cloudflareApiToken !== 'string' ||
      data.cloudflareApiToken.length < 20 ||
      data.cloudflareAccountId !== target.account ||
      data.cloudflareZoneId !== target.zone ||
      data.domain !== target.domain
    )
      throw new Failure('credentials-target-mismatch');
    return data;
  } finally {
    await handle.close();
  }
}

async function request(url, { method = 'GET', token, body, timeoutMs = 12_000 } = {}) {
  if (interrupted && !cleaningUp) throw new Failure('interrupted');
  const headers = new Headers({ accept: 'application/json' });
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      throw new Failure('network-request-failed');
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* Never expose response bodies. */
    }
    return { status: response.status, ok: response.ok, payload };
  } finally {
    clearTimeout(timer);
  }
}

function broker(path, options) {
  if (!path.startsWith('/v1/') || path.includes('..')) throw new Failure('invalid-route');
  return request(`${target.base}${path}`, options);
}

async function advertise(session, machine) {
  const params = { endpoints: [], capabilities: [], ...(machine ? { machine } : {}) };
  const response = await broker('/v1/rpc', {
    method: 'POST',
    token: session.accessToken,
    body: {
      protocol: 'anvil-backend/1',
      requestId: randomUUID(),
      operation: 'device.advertise',
      params,
    },
  });
  if (response.status !== 200 || response.payload?.error || !response.payload?.result?.advertised) {
    throw new Failure('advertise-failed', response.status);
  }
}

async function findHost(session, machineId) {
  const response = await broker('/v1/mesh/hosts', { token: session.accessToken });
  if (response.status !== 200 || !Array.isArray(response.payload?.hosts))
    throw new Failure('discovery-failed', response.status);
  return response.payload.hosts.find((host) => host?.machineId === machineId) ?? null;
}

function readyManagedAllocation(host, machineId, generation, expectedHostname) {
  if (host?.allocationState !== 'ready') return null;
  const routes = Array.isArray(host.routes)
    ? host.routes.filter((route) => route?.kind === 'managed')
    : [];
  if (routes.length !== 1) throw new Failure('managed-route-shape-invalid');
  const route = routes[0];
  let url;
  try {
    url = new URL(route.url);
  } catch {
    throw new Failure('managed-route-url-invalid');
  }
  if (
    host.machineId !== machineId ||
    host.endpointGeneration !== generation ||
    route.machineId !== machineId ||
    route.endpointGeneration !== generation ||
    typeof route.allocationGeneration !== 'string' ||
    !/^[1-9][0-9]*$/.test(route.allocationGeneration) ||
    url.protocol !== 'https:' ||
    url.hostname !== expectedHostname ||
    url.pathname !== '/' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Failure('managed-route-shape-invalid');
  }
  const allocationGeneration = Number(route.allocationGeneration);
  if (!Number.isSafeInteger(allocationGeneration)) throw new Failure('managed-route-shape-invalid');
  return { url: route.url, hostname: url.hostname, allocationGeneration };
}

function startLoopback(marker, markerPath) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== markerPath) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end(marker);
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', () => reject(new Failure('loopback-listener-failed')));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Failure('loopback-listener-failed'));
      resolvePromise({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function stopConnector(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return true;
  child.kill('SIGTERM');
  for (let i = 0; i < 25; i++) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await wait(200);
  }
  child.kill('SIGKILL');
  for (let i = 0; i < 15; i++) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await wait(200);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

async function allocateAndDiscover(
  session,
  machineId,
  generation,
  origin,
  requestId,
  expectedHostname,
) {
  const response = await broker(`/v1/mesh/hosts/${machineId}/endpoint`, {
    method: 'POST',
    token: session.accessToken,
    body: { action: 'allocate', endpointGeneration: generation, requestId, localOrigin: origin },
  });
  const pending = response.payload?.allocation;
  if (
    !response.ok ||
    ![200, 201, 202].includes(response.status) ||
    !record(pending) ||
    pending.machineId !== machineId ||
    pending.endpointGeneration !== generation ||
    (pending.state !== 'ready' && pending.state !== 'allocating')
  ) {
    throw new Failure('allocation-request-failed', response.status);
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const host = await findHost(session, machineId);
    if (host?.allocationState === 'failed') throw new Failure('allocation-failed');
    const allocation = readyManagedAllocation(host, machineId, generation, expectedHostname);
    if (allocation) return allocation;
    await wait(2_000);
  }
  throw new Failure('allocation-timeout');
}

async function ingress(url, marker, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (interrupted && !cleaningUp) throw new Failure('interrupted');
    if (child.exitCode !== null || child.signalCode !== null) throw new Failure('connector-exited');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7_000);
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.status === 200 && (await response.text()) === marker) return true;
    } catch {
      /* Allow the connector time to attach. */
    } finally {
      clearTimeout(timer);
    }
    await wait(1_000);
  }
  return false;
}

async function cloudflareAbsent(path, token) {
  const response = await request(`${cfApi}${path}`, { token });
  return {
    absent:
      response.ok &&
      response.payload?.success === true &&
      Array.isArray(response.payload.result) &&
      response.payload.result.length === 0,
    status: response.status,
  };
}

async function releaseAndPoll(
  session,
  machineId,
  generation,
  allocationGeneration,
  hostname,
  tunnelName,
  apiToken,
) {
  const released = await broker(`/v1/mesh/hosts/${machineId}/endpoint`, {
    method: 'POST',
    token: session.accessToken,
    body: {
      action: 'release',
      endpointGeneration: generation,
      ...(Number.isSafeInteger(allocationGeneration) ? { allocationGeneration } : {}),
    },
  }).catch(() => null);
  let allocationClean = false,
    dnsAbsent = false,
    tunnelAbsent = false;
  let dnsStatus = null,
    tunnelStatus = null;
  const deadline = Date.now() + 60_000;
  do {
    const [host, dns, tunnel] = await Promise.all([
      findHost(session, machineId).catch(() => null),
      cloudflareAbsent(
        `/zones/${target.zone}/dns_records?${new URLSearchParams({ type: 'CNAME', name: hostname, per_page: '100' })}`,
        apiToken,
      ).catch(() => null),
      cloudflareAbsent(
        `/accounts/${target.account}/cfd_tunnel?${new URLSearchParams({ name: tunnelName, is_deleted: 'false', per_page: '100' })}`,
        apiToken,
      ).catch(() => null),
    ]);
    allocationClean =
      host?.allocationState === 'unallocated' &&
      !host.routes?.some((route) => route?.kind === 'managed');
    dnsAbsent = dns?.absent ?? false;
    tunnelAbsent = tunnel?.absent ?? false;
    dnsStatus = dns?.status ?? null;
    tunnelStatus = tunnel?.status ?? null;
    if (allocationClean && dnsAbsent && tunnelAbsent) break;
    if (Date.now() + 5_000 > deadline) break;
    await wait(5_000);
  } while (Date.now() < deadline);
  return {
    allocationClean,
    dnsAbsent,
    tunnelAbsent,
    releaseStatus: released?.status ?? null,
    dnsStatus,
    tunnelStatus,
  };
}

async function main() {
  const checks = Object.fromEntries(
    [
      'stagingGuard',
      'credentialGuard',
      'enrollmentIssued',
      'syntheticEnrollment',
      'unauthenticatedRejected',
      'hostAdvertised',
      'allocationReady',
      'connectorTokenFetched',
      'connectorStarted',
      'loopbackIngress',
      'connectorStopped',
      'allocationReleased',
      'dnsAbsent',
      'tunnelAbsent',
      'advertisementCleared',
      'enrollmentRevoked',
      'secretRemoved',
    ].map((key) => [key, null]),
  );
  const statuses = {};
  let failure = null,
    creds = null,
    session = null,
    server = null,
    child = null,
    secretDir = null;
  let machineId = null,
    generation = null,
    allocationGeneration = null,
    hostname = null,
    tunnelName = null;
  let advertised = false,
    allocating = false;

  try {
    const credentialsPath = credentialsArg();
    if (credentialsPath === null) return 0;
    const manifest = JSON.parse(
      await readFile(resolve(root, 'anvil-app/cloud/backend/hosted-targets.ci.json'), 'utf8'),
    );
    const staging = manifest?.environments?.staging;
    if (
      staging?.stage !== 'staging' ||
      staging.workerName !== target.name ||
      staging.baseUrl !== target.base ||
      staging.accountId !== target.account ||
      manifest?.environments?.production?.baseUrl !== '' ||
      manifest?.environments?.production?.accountId !== ''
    )
      throw new Failure('staging-target-mismatch');
    checks.stagingGuard = true;
    creds = await loadCredentials(credentialsPath);
    checks.credentialGuard = true;
    await access(cloudflared, fsConstants.X_OK).catch(() => {
      throw new Failure('trusted-cloudflared-unavailable');
    });

    const accountId = `stg-mesh-smoke-${randomUUID()}`;
    machineId = `mesh-smoke-${randomUUID()}`;
    generation = randomUUID();
    const label = `host-${createHash('sha256').update(`${accountId}\0${machineId}`).digest('hex').slice(0, 24)}`;
    hostname = `${label}.${target.domain}`;
    tunnelName = `anvil-${label}-g1`;
    const displayName = 'Disposable staging managed endpoint transport smoke';

    const issued = await broker('/v1/enrollment-codes', {
      method: 'POST',
      token: creds.enrollmentAdminToken,
      body: { accountId, displayName },
    });
    statuses.enrollmentIssue = issued.status;
    if (issued.status !== 200 || typeof issued.payload?.code !== 'string')
      throw new Failure('enrollment-issue-failed', issued.status);
    checks.enrollmentIssued = true;
    const enrolled = await broker('/v1/enroll', {
      method: 'POST',
      body: {
        proof: { method: 'enrollment-code', code: issued.payload.code },
        installationId: `install-${randomUUID()}`,
        displayName,
      },
    });
    statuses.enrollment = enrolled.status;
    if (
      record(enrolled.payload) &&
      typeof enrolled.payload.enrollmentId === 'string' &&
      typeof enrolled.payload.accessToken === 'string'
    )
      session = enrolled.payload;
    if (
      enrolled.status !== 200 ||
      !record(enrolled.payload) ||
      enrolled.payload.accountId !== accountId ||
      typeof enrolled.payload.enrollmentId !== 'string' ||
      typeof enrolled.payload.accessToken !== 'string' ||
      typeof enrolled.payload.refreshToken !== 'string'
    )
      throw new Failure('synthetic-enrollment-failed', enrolled.status);
    checks.syntheticEnrollment = true;

    const unauth = await broker('/v1/mesh/hosts');
    statuses.unauthenticatedDiscovery = unauth.status;
    checks.unauthenticatedRejected = unauth.status === 401;
    if (!checks.unauthenticatedRejected)
      throw new Failure('unauthenticated-discovery-not-rejected', unauth.status);

    advertised = true;
    await advertise(session, {
      hostEnrollmentId: session.enrollmentId,
      machineId,
      endpointGeneration: generation,
      protocolVersion: 1,
      capabilities: ['machine.session/1'],
      operations: ['read.snapshot', 'command.submit'],
    });
    checks.hostAdvertised = true;
    const found = await findHost(session, machineId);
    if (found?.enrollmentId !== session.enrollmentId || found.endpointGeneration !== generation)
      throw new Failure('advertisement-not-visible');

    const marker = `anvil-staging-managed-smoke-${randomUUID()}`;
    const markerPath = `/health/${randomUUID()}`;
    const loopback = await startLoopback(marker, markerPath);
    server = loopback.server;
    allocating = true;
    const allocated = await allocateAndDiscover(
      session,
      machineId,
      generation,
      loopback.origin,
      randomUUID(),
      hostname,
    );
    allocationGeneration = allocated.allocationGeneration;
    if (
      allocationGeneration !== 1 ||
      allocated.hostname !== hostname ||
      allocated.url !== `https://${hostname}`
    ) {
      throw new Failure('allocation-shape-invalid');
    }
    checks.allocationReady = true;

    const token = await broker(`/v1/mesh/hosts/${machineId}/connector-token`, {
      method: 'POST',
      token: session.accessToken,
      body: { endpointGeneration: generation, allocationGeneration },
    });
    statuses.connectorToken = token.status;
    if (
      token.status !== 200 ||
      typeof token.payload?.connectorToken !== 'string' ||
      token.payload.connectorToken.length < 40 ||
      token.payload.hostname !== hostname ||
      token.payload.endpointGeneration !== generation ||
      token.payload.allocationGeneration !== allocationGeneration
    )
      throw new Failure('connector-token-failed', token.status);
    checks.connectorTokenFetched = true;

    secretDir = await mkdtemp(join(tmpdir(), 'anvil-managed-smoke-'));
    await chmod(secretDir, 0o700);
    const secretPath = join(secretDir, 'token');
    const handle = await open(secretPath, 'wx', 0o600);
    try {
      await handle.writeFile(token.payload.connectorToken, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    token.payload.connectorToken = '';
    if (((await stat(secretPath)).mode & 0o777) !== 0o600)
      throw new Failure('secret-file-mode-invalid');
    if (interrupted) throw new Failure('interrupted');
    child = spawn(
      cloudflared,
      ['tunnel', '--no-autoupdate', '--loglevel', 'error', 'run', '--token-file', secretPath],
      {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        env: {
          PATH: process.env.PATH ?? '/opt/homebrew/bin:/usr/bin:/bin',
          HOME: process.env.HOME ?? tmpdir(),
          TMPDIR: tmpdir(),
        },
      },
    );
    await new Promise((resolvePromise, reject) => {
      child.once('spawn', resolvePromise);
      child.once('error', () => reject(new Failure('cloudflared-spawn-failed')));
      setTimeout(() => reject(new Failure('cloudflared-spawn-timeout')), 5_000).unref?.();
    });
    checks.connectorStarted = true;
    if (!(await ingress(`https://${hostname}${markerPath}`, marker, child)))
      throw new Failure('loopback-ingress-failed');
    checks.loopbackIngress = true;
  } catch (error) {
    failure = error instanceof Failure ? error : new Failure('unexpected-failure');
  } finally {
    cleaningUp = true;
    const stopped = await stopConnector(child).catch(() => false);
    checks.connectorStopped = stopped;
    if (server) {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    }
    if (secretDir) {
      await rm(secretDir, { recursive: true, force: true })
        .then(() => {
          checks.secretRemoved = true;
        })
        .catch(() => {
          checks.secretRemoved = false;
          failure ??= new Failure('secret-cleanup-failed');
        });
    } else checks.secretRemoved = true;
    if (!stopped) failure ??= new Failure('connector-stop-failed');

    if (session && allocating) {
      const cleaned = await releaseAndPoll(
        session,
        machineId,
        generation,
        allocationGeneration,
        hostname,
        tunnelName,
        creds.cloudflareApiToken,
      ).catch(() => null);
      checks.allocationReleased = cleaned?.allocationClean ?? false;
      checks.dnsAbsent = cleaned?.dnsAbsent ?? false;
      checks.tunnelAbsent = cleaned?.tunnelAbsent ?? false;
      statuses.release = cleaned?.releaseStatus ?? null;
      statuses.cloudflareDnsRead = cleaned?.dnsStatus ?? null;
      statuses.cloudflareTunnelRead = cleaned?.tunnelStatus ?? null;
      if (!checks.allocationReleased || !checks.dnsAbsent || !checks.tunnelAbsent) {
        failure ??= new Failure('cleanup-incomplete');
      }
    }
    if (session && advertised) {
      checks.advertisementCleared = await advertise(session, null)
        .then(() => true)
        .catch(() => false);
      if (!checks.advertisementCleared) failure ??= new Failure('advertisement-cleanup-failed');
    }
    if (session) {
      const revoked = await broker('/v1/session/revoke', {
        method: 'POST',
        token: session.accessToken,
        body: { enrollmentId: session.enrollmentId },
      }).catch(() => null);
      statuses.enrollmentRevoke = revoked?.status ?? null;
      checks.enrollmentRevoked = revoked?.status === 200 && revoked.payload?.revoked === true;
      if (!checks.enrollmentRevoked)
        failure ??= new Failure('enrollment-revoke-failed', revoked?.status ?? null);
    }
  }

  if (interrupted && !failure) failure = new Failure('interrupted');
  process.stdout.write(
    `${JSON.stringify({
      scope: 'staging-transport-smoke-only',
      result: failure ? 'failed' : 'passed',
      coverage: {
        applicationSessionAuthentication: 'not-tested',
        physicalWan: 'not-tested',
        syntheticAccountNamespace: session ? 'retained' : 'not-created',
        syntheticEnrollment: checks.enrollmentRevoked
          ? 'revoked'
          : session
            ? 'cleanup-failed'
            : 'not-created',
      },
      checks,
      statuses,
      failure: failure ? { code: failure.code, status: failure.status } : null,
    })}\n`,
  );
  return failure ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    process.stdout.write(
      '{"scope":"staging-transport-smoke-only","result":"failed","failure":{"code":"unexpected-failure"}}\n',
    );
    process.exitCode = 1;
  });
