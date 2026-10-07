import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isManagedEndpointDomain } from '../cloud/backend/scripts/staging-config.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = resolve(repoRoot, 'anvil-app/cloud/backend/hosted-targets.ci.json');
const maxOutput = 1024 * 1024;
const maxDescriptor = 64 * 1024;
const timeout = 20_000;
const requiredSecrets = [
  'CLOUDFLARE_DEPLOY_API_TOKEN',
  'HOSTED_SERVICE_KEYS',
  'WORKOS_API_KEY',
  'WORKOS_WEBHOOK_SECRET',
  'CLOUDFLARE_TUNNEL_ACCOUNT_ID',
  'CLOUDFLARE_TUNNEL_ZONE_ID',
  'CLOUDFLARE_TUNNEL_API_TOKEN',
];
const expectedFlags = {
  HOSTED_CHECKOUT_ENABLED: 'false',
  ANVIL_CLOUD_AGENTS_ENABLED: 'false',
  ANVIL_MESH_MANAGED_ENDPOINTS: 'true',
};
const runFields = 'databaseId,headSha,headBranch,status,conclusion,createdAt';

async function capture(program, args) {
  try {
    const { stdout } = await execFileAsync(program, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: maxOutput,
      timeout,
      windowsHide: true,
    });
    return { ok: true, stdout };
  } catch (error) {
    // Never expose stderr or the CLI error message. `gh pr checks` can return
    // useful JSON with exit code 8 while checks are still pending.
    return { ok: false, stdout: typeof error?.stdout === 'string' ? error.stdout : '' };
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commitSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

function label(value, limit = 100) {
  if (typeof value !== 'string') return null;
  const result = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
  return result || null;
}

async function ghJson(args, { acceptNonzeroJson = false } = {}) {
  const result = await capture('gh', args);
  if (!result.ok && !acceptNonzeroJson) return null;
  return parseJson(result.stdout);
}

export function candidateRelation(localHead, remoteHead) {
  if (!commitSha(localHead) || !commitSha(remoteHead)) return 'unknown';
  return localHead.toLowerCase() === remoteHead.toLowerCase() ? 'current' : 'different';
}

export function summarizeChecks(checks, available = true) {
  const counts = { pass: 0, fail: 0, pending: 0, skipped: 0, cancelled: 0 };
  if (!available || !Array.isArray(checks) || checks.length === 0) {
    return { state: 'blocked', counts };
  }
  for (const check of checks) {
    const bucket = check?.bucket;
    if (bucket === 'pass') counts.pass += 1;
    else if (bucket === 'fail') counts.fail += 1;
    else if (bucket === 'skipping') counts.skipped += 1;
    else if (bucket === 'cancel') counts.cancelled += 1;
    else counts.pending += 1;
  }
  const state = counts.fail
    ? 'failed'
    : counts.pending || counts.cancelled
      ? 'pending'
      : counts.pass
        ? 'passed'
        : 'blocked';
  return { state, counts };
}

export function inspectWorkerFlags(config) {
  return Object.entries(expectedFlags).map(([name, expected]) => {
    const value = record(config) ? config[name] : undefined;
    return {
      name,
      expected,
      state: value === undefined ? 'missing' : value === expected ? 'match' : 'mismatch',
    };
  });
}

export function inspectManagedDomain(config) {
  const value = record(config) ? config.MACHINE_ENDPOINT_DOMAIN : undefined;
  return {
    state: value === undefined ? 'missing' : isManagedEndpointDomain(value) ? 'passed' : 'failed',
  };
}

export function validatePublicDescriptor(descriptor, target) {
  const has = (field, value) =>
    Array.isArray(descriptor?.[field]) && descriptor[field].includes(value);
  const checks = [
    ['descriptorVersion', descriptor?.descriptorVersion === 1],
    ['protocol anvil-backend/1', has('protocols', 'anvil-backend/1')],
    ['profile sync/2', has('profiles', 'sync/2')],
    ['profile mesh/2', has('profiles', 'mesh/2')],
    ['WorkOS device auth', has('authModes', 'workos-device')],
    ['WorkOS issuer target', descriptor?.auth?.issuer === target?.issuer],
    ['WorkOS desktop client target', descriptor?.auth?.publicClientId === target?.desktopClientId],
  ];
  const missing = checks.filter(([, matches]) => !matches).map(([name]) => name);
  return { state: missing.length ? 'failed' : 'passed', missing };
}

export function summarizeWorkflowRun(run, expectedHead = null) {
  const headSha = commitSha(run?.headSha) ? run.headSha.toLowerCase() : null;
  const status = label(run?.status, 30)?.toLowerCase() ?? null;
  const conclusion = label(run?.conclusion, 30)?.toLowerCase() ?? null;
  const state = !run
    ? 'blocked'
    : status && status !== 'completed'
      ? 'pending'
      : status === 'completed' && conclusion === 'success'
        ? 'passed'
        : status === 'completed' && conclusion
          ? 'failed'
          : 'blocked';
  return {
    state,
    relation: expectedHead ? candidateRelation(headSha, expectedHead) : null,
    id: Number.isSafeInteger(run?.databaseId) ? run.databaseId : null,
    headSha,
    headBranch: label(run?.headBranch),
    status,
    conclusion,
    createdAt: label(run?.createdAt, 40),
  };
}

async function localCheckout() {
  const [head, branch, status] = await Promise.all([
    capture('git', ['rev-parse', 'HEAD']),
    capture('git', ['branch', '--show-current']),
    capture('git', ['status', '--porcelain']),
  ]);
  const sha = head.ok ? head.stdout.trim() : '';
  return {
    headSha: commitSha(sha) ? sha.toLowerCase() : null,
    branch: branch.ok ? (label(branch.stdout.trim()) ?? 'detached') : null,
    dirty: status.ok ? status.stdout.trim().length > 0 : null,
    available: head.ok && branch.ok && status.ok && commitSha(sha),
  };
}

async function targetFromManifest() {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const staging = manifest?.environments?.staging;
    const url = new URL(staging?.baseUrl);
    const desktopClientId = staging?.workos?.desktopClientId;
    const issuer = staging?.workos?.issuer;
    const workerName = staging?.workerName;
    if (
      manifest?.schemaVersion !== 1 ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      typeof desktopClientId !== 'string' ||
      !desktopClientId ||
      typeof issuer !== 'string' ||
      !issuer ||
      typeof workerName !== 'string' ||
      !workerName
    )
      return null;
    return {
      url: url.origin,
      workerName,
      issuer,
      descriptorUrl: new URL('/.well-known/anvil-backend', url).href,
      desktopClientId,
    };
  } catch {
    return null;
  }
}

async function publicDescriptor(target) {
  if (!target)
    return { state: 'blocked', missing: [], reason: 'public manifest target unavailable' };
  try {
    const response = await fetch(target.descriptorUrl, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok || !response.body) throw new Error();
    if (Number(response.headers.get('content-length')) > maxDescriptor) throw new Error();
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxDescriptor) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = parseJson(new TextDecoder().decode(bytes));
    if (!record(value)) throw new Error();
    return { ...validatePublicDescriptor(value, target), reason: null };
  } catch {
    return { state: 'blocked', missing: [], reason: 'descriptor request unavailable or invalid' };
  }
}

function namesFrom(value) {
  return Array.isArray(value)
    ? new Set(value.map((item) => item?.name).filter((name) => typeof name === 'string'))
    : null;
}

async function secretStatus() {
  const [repo, env] = await Promise.all([
    ghJson(['secret', 'list', '--json', 'name']),
    ghJson(['secret', 'list', '--env', 'anvil-staging', '--json', 'name']),
  ]);
  const repoNames = namesFrom(repo);
  const envNames = namesFrom(env);
  if (!repoNames || !envNames) {
    return {
      state: 'blocked',
      requiredPresent: [],
      requiredMissing: [],
      reason: 'secret names unavailable',
    };
  }
  const names = new Set([...repoNames, ...envNames]);
  const requiredPresent = requiredSecrets.filter((name) => names.has(name));
  const requiredMissing = requiredSecrets.filter((name) => !names.has(name));
  return {
    state: requiredMissing.length ? 'failed' : 'passed',
    requiredPresent,
    requiredMissing,
    reason: null,
  };
}

async function workerFlagStatus() {
  const [repo, env] = await Promise.all([
    ghJson(['variable', 'list', '--json', 'name']),
    ghJson(['variable', 'list', '--env', 'anvil-staging', '--json', 'name']),
  ]);
  const repoNames = namesFrom(repo);
  const envNames = namesFrom(env);
  if (!repoNames || !envNames) {
    return {
      state: 'blocked',
      flags: inspectWorkerFlags(null).map((flag) => ({ ...flag, state: 'unavailable' })),
      domain: { state: 'unavailable' },
      reason: 'variable names unavailable',
    };
  }
  const key = 'ANVIL_STAGING_WORKER_VARS_JSON';
  const scope = envNames.has(key) ? ['--env', 'anvil-staging'] : repoNames.has(key) ? [] : null;
  if (!scope)
    return {
      state: 'failed',
      flags: inspectWorkerFlags({}),
      domain: inspectManagedDomain({}),
      reason: null,
    };
  const envelope = await ghJson(['variable', 'get', key, ...scope, '--json', 'value']);
  const config =
    record(envelope) && typeof envelope.value === 'string' ? parseJson(envelope.value) : null;
  if (!record(config)) {
    return {
      state: 'blocked',
      flags: inspectWorkerFlags(null).map((flag) => ({ ...flag, state: 'unavailable' })),
      domain: { state: 'unavailable' },
      reason: 'worker variable unavailable or invalid',
    };
  }
  const flags = inspectWorkerFlags(config);
  const domain = inspectManagedDomain(config);
  return {
    state:
      flags.every((flag) => flag.state === 'match') && domain.state === 'passed'
        ? 'passed'
        : 'failed',
    flags,
    domain,
    reason: null,
  };
}

async function pullRequest() {
  const value = await ghJson(['pr', 'view', '91', '--json', 'headRefOid,headRefName,state']);
  if (!record(value) || !commitSha(value.headRefOid)) return null;
  return {
    headSha: value.headRefOid.toLowerCase(),
    branch: label(value.headRefName),
    state: label(value.state, 20)?.toLowerCase() ?? null,
  };
}

async function workflowRun(workflow, sha = null) {
  const args = ['run', 'list', '--workflow', workflow];
  if (sha) args.push('--commit', sha);
  args.push('--limit', '1', '--json', runFields);
  const result = await ghJson(args);
  return Array.isArray(result) ? (result[0] ?? null) : null;
}

function readyRun(run) {
  return run.state === 'passed' && run.relation === 'current';
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatRun(run) {
  if (run.state === 'blocked') return 'BLOCKED (run unavailable)';
  const id = run.id === null ? 'run ID unavailable' : `run #${run.id}`;
  const branch = run.headBranch ? ` on ${run.headBranch}` : '';
  const outcome = run.conclusion ?? run.status ?? 'unknown status';
  const relation = run.relation ? `, ${run.relation} candidate head` : '';
  return `${id}${branch}, head ${run.headSha ?? 'unknown'}, ${outcome}${relation}`;
}

export async function buildStagingStatusReport() {
  const target = await targetFromManifest();
  const [checkout, pr, latestRaw, secrets, workerFlags, descriptor] = await Promise.all([
    localCheckout(),
    pullRequest(),
    workflowRun('sync-backend-staging.yml'),
    secretStatus(),
    workerFlagStatus(),
    publicDescriptor(target),
  ]);
  const [checksRaw, previewRaw, prAfter] = pr?.headSha
    ? await Promise.all([
        ghJson(['pr', 'checks', '91', '--json', 'bucket,name,state,workflow'], {
          acceptNonzeroJson: true,
        }),
        workflowRun('app-candidate-preview.yml', pr.headSha),
        pullRequest(),
      ])
    : [null, null, null];
  const samePrHead = Boolean(pr?.headSha && prAfter?.headSha === pr.headSha);
  const checks = samePrHead ? summarizeChecks(checksRaw, true) : summarizeChecks(null, false);
  const relation = candidateRelation(checkout.headSha, pr?.headSha);
  const latestRun = summarizeWorkflowRun(latestRaw, pr?.headSha ?? null);
  const preview = summarizeWorkflowRun(previewRaw, pr?.headSha ?? null);
  const report = {
    preflight: { state: 'blocked', blockers: [] },
    checkout,
    pullRequest: {
      number: 91,
      headSha: pr?.headSha ?? null,
      branch: pr?.branch ?? null,
      state: pr?.state ?? 'unavailable',
      relation,
      checks,
      headStayedCurrent: samePrHead,
    },
    backend: {
      targetName: target?.workerName ?? null,
      targetUrl: target?.url ?? null,
      latestRun,
      descriptor,
    },
    preview: { candidateRun: preview },
    secrets,
    workerFlags,
    manualAcceptance: 'not verified',
  };
  const blockers = [];
  const block = (ok, reason) => {
    if (!ok) blockers.push(reason);
  };
  block(checkout.available, 'local checkout status unavailable');
  block(
    relation === 'current' && checkout.dirty === false,
    'checkout is old, dirty, or PR head unavailable',
  );
  block(pr?.state === 'open', 'PR #91 is unavailable or not open');
  block(samePrHead, 'PR #91 head changed while status was read');
  block(checks.state === 'passed', 'PR checks are not all passing');
  block(readyRun(latestRun), 'latest staging workflow is not successful on the current PR head');
  block(readyRun(preview), 'desktop previews have not succeeded for the current PR head');
  block(descriptor.state === 'passed', 'public descriptor does not match the staging target');
  block(secrets.state === 'passed', 'required staging secrets are missing or unavailable');
  block(
    workerFlags.state === 'passed',
    'desired staging worker flags are missing, wrong, or unavailable',
  );
  report.preflight = {
    state: blockers.length ? 'blocked' : 'ready_for_manual_acceptance',
    blockers,
  };

  report.nextCommands = [
    'Read `docs/runbooks/hosted-sync/staging-next-steps.md` before changing staging or starting acceptance.',
    'Rerun `pnpm staging:status` from `anvil-app/` after each setup or workflow change.',
  ];
  if (pr?.headSha && pr.branch && relation === 'current' && !readyRun(preview)) {
    report.nextCommands.push(
      `Build the exact macOS and Linux previews with: gh workflow run app-candidate-preview.yml --ref ${shellQuote(pr.branch)} -f pull_request=91 -f head_sha=${pr.headSha}`,
    );
  }
  if (report.preflight.state === 'ready_for_manual_acceptance') {
    report.nextCommands.push(
      'Start the signed-in and physical-device gates in `docs/runbooks/hosted-sync/staging-acceptance.md`.',
    );
  }
  return report;
}

function render(report) {
  const lines = [
    `Automated preflight: ${report.preflight.state === 'ready_for_manual_acceptance' ? 'PASS, ready for manual acceptance' : 'BLOCKED'}`,
    `Checkout: ${report.checkout.branch ?? 'branch unavailable'} ${report.checkout.headSha ?? 'HEAD unavailable'} (${report.checkout.dirty === null ? 'dirty state unavailable' : report.checkout.dirty ? 'dirty' : 'clean'})`,
    report.pullRequest.headSha
      ? `PR #91: ${report.pullRequest.headSha}, local checkout ${report.pullRequest.relation}; checks ${report.pullRequest.checks.state} (${report.pullRequest.checks.counts.pass} pass, ${report.pullRequest.checks.counts.fail} fail, ${report.pullRequest.checks.counts.pending} pending, ${report.pullRequest.checks.counts.skipped} skipped)`
      : 'PR #91: BLOCKED (remote head unavailable)',
    `Latest staging workflow: ${formatRun(report.backend.latestRun)}`,
    'The staging workflow head identifies the deployed candidate; descriptor profiles do not prove commit identity.',
    `Candidate macOS and Linux previews: ${formatRun(report.preview.candidateRun)}`,
    `Staging backend target: ${report.backend.targetName ?? 'unavailable'} at ${report.backend.targetUrl ?? 'unavailable'}`,
    report.backend.descriptor.state === 'passed'
      ? 'Public backend descriptor: PASS'
      : `Public backend descriptor: ${report.backend.descriptor.state.toUpperCase()} (${report.backend.descriptor.reason ?? report.backend.descriptor.missing.join(', ')})`,
    `Required GitHub secrets: ${report.secrets.state}${report.secrets.requiredPresent.length ? `, present ${report.secrets.requiredPresent.join(', ')}` : ''}${report.secrets.requiredMissing.length ? `, missing ${report.secrets.requiredMissing.join(', ')}` : ''}${report.secrets.reason ? ` (${report.secrets.reason})` : ''}`,
    `Desired staging worker flags: ${report.workerFlags.flags.map(({ name, expected, state }) => `${name}=${expected} (${state})`).join(', ')}${report.workerFlags.reason ? ` (${report.workerFlags.reason})` : ''}`,
    `Managed endpoint domain: ${report.workerFlags.domain.state}. Secret presence and domain syntax do not prove provider permissions or tunnel connectivity.`,
    'Manual acceptance: NOT VERIFIED. CI and a matching descriptor do not pass signed-in or physical-device tests.',
    'Next:',
    ...report.nextCommands.map((command) => `  - ${command}`),
  ];
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !['--json', '--help'].includes(args[0]))) {
    process.stderr.write('Usage: pnpm staging:status [--json]\n');
    process.exitCode = 2;
    return;
  }
  if (args[0] === '--help') {
    process.stdout.write(
      'Read-only staging preflight for PR #91. Use `pnpm --silent staging:status --json` for sanitized output.\n',
    );
    return;
  }
  try {
    const report = await buildStagingStatusReport();
    process.stdout.write(
      args[0] === '--json' ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`,
    );
    if (report.preflight.state !== 'ready_for_manual_acceptance') process.exitCode = 1;
  } catch {
    process.stderr.write('Staging status check failed; details were suppressed.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
