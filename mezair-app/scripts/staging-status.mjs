import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isManagedEndpointDomain } from '../cloud/backend/scripts/staging-config.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = resolve(repoRoot, 'mezair-app/cloud/backend/hosted-targets.ci.json');
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
  MEZAIR_CLOUD_AGENTS_ENABLED: 'false',
  MEZAIR_MESH_MANAGED_ENDPOINTS: 'true',
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

export function parseArguments(args) {
  const options = { json: false, help: false, pullRequestNumber: null, ref: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--help') options.help = true;
    else if (argument === '--pr' || argument === '--ref') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('missing option value');
      index += 1;
      if (argument === '--pr') {
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
          throw new Error('invalid pull request number');
        if (options.pullRequestNumber !== null) throw new Error('duplicate pull request option');
        options.pullRequestNumber = Number(value);
      } else {
        if (options.ref !== null || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value))
          throw new Error('invalid ref');
        options.ref = value;
      }
    } else throw new Error('unknown option');
  }
  if (options.pullRequestNumber !== null && options.ref !== null)
    throw new Error('choose either a pull request or a ref');
  if (options.help && (options.json || options.pullRequestNumber !== null || options.ref !== null))
    throw new Error('help cannot be combined with other options');
  return options;
}

export function summarizeCheckoutCandidate(checkout) {
  return {
    source: 'checkout',
    ref: checkout?.branch ?? null,
    headSha: commitSha(checkout?.headSha) ? checkout.headSha.toLowerCase() : null,
    modified: checkout?.dirty === true,
    localCheckoutRelation: 'current',
  };
}

export function summarizeRemoteCandidate(source, ref, headSha, checkout) {
  return {
    source,
    ref: label(ref),
    headSha: commitSha(headSha) ? headSha.toLowerCase() : null,
    modified: false,
    localCheckoutRelation: candidateRelation(checkout?.headSha, headSha),
  };
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
    ['protocol mezair-backend/1', has('protocols', 'mezair-backend/1')],
    ['profile sync/2', has('profiles', 'sync/2')],
    ['profile mesh/2', has('profiles', 'mesh/2')],
    ['WorkOS device auth', has('authModes', 'workos-device')],
    ['legacy enrollment auth disabled', !has('authModes', 'enrollment-code')],
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
      descriptorUrl: new URL('/.well-known/mezair-backend', url).href,
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
    ghJson(['secret', 'list', '--env', 'mezair-staging', '--json', 'name']),
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
    ghJson(['variable', 'list', '--env', 'mezair-staging', '--json', 'name']),
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
  const key = 'MEZAIR_STAGING_WORKER_VARS_JSON';
  const scope = envNames.has(key) ? ['--env', 'mezair-staging'] : repoNames.has(key) ? [] : null;
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

async function pullRequestByNumber(number) {
  const value = await ghJson([
    'pr',
    'view',
    String(number),
    '--json',
    'number,headRefOid,headRefName,state',
  ]);
  if (!record(value) || !commitSha(value.headRefOid)) return null;
  return {
    number: Number.isSafeInteger(value.number) ? value.number : number,
    headSha: value.headRefOid.toLowerCase(),
    branch: label(value.headRefName),
    state: label(value.state, 20)?.toLowerCase() ?? null,
  };
}

async function pullRequestForBranch(branch, localHead) {
  if (!branch) return { pullRequest: null, reason: 'local branch unavailable' };
  const values = await ghJson([
    'pr',
    'list',
    '--state',
    'open',
    '--head',
    branch,
    '--json',
    'number,headRefOid,headRefName,state',
    '--limit',
    '20',
  ]);
  if (!Array.isArray(values))
    return { pullRequest: null, reason: 'pull request lookup unavailable' };
  const candidates = values
    .filter((value) => record(value) && commitSha(value.headRefOid))
    .map((value) => ({
      number: Number.isSafeInteger(value.number) ? value.number : null,
      headSha: value.headRefOid.toLowerCase(),
      branch: label(value.headRefName),
      state: label(value.state, 20)?.toLowerCase() ?? null,
    }));
  if (candidates.length === 1) return { pullRequest: candidates[0], reason: null };
  const exact = candidates.filter((value) => value.headSha === localHead);
  if (exact.length === 1) return { pullRequest: exact[0], reason: null };
  return {
    pullRequest: null,
    reason: candidates.length ? 'multiple open pull requests; select one with --pr' : null,
  };
}

async function remoteRef(ref) {
  const repository = await ghJson(['repo', 'view', '--json', 'nameWithOwner']);
  const nameWithOwner = label(repository?.nameWithOwner, 200);
  if (!nameWithOwner || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(nameWithOwner)) return null;
  const value = await ghJson(['api', `repos/${nameWithOwner}/commits/${encodeURIComponent(ref)}`]);
  return record(value) && commitSha(value.sha) ? value.sha.toLowerCase() : null;
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
  const relation =
    run.relation === 'current'
      ? ', same commit as selected candidate'
      : run.relation === 'different'
        ? ', different commit from selected candidate'
        : '';
  return `${id}${branch}, head ${run.headSha ?? 'unknown'}, ${outcome}${relation}`;
}

export async function buildStagingStatusReport() {
  return buildStagingStatusReportFor({});
}

export async function buildStagingStatusReportFor(options = {}) {
  const target = await targetFromManifest();
  const [checkout, latestRaw, latestPreviewRaw, secrets, workerFlags, descriptor] =
    await Promise.all([
      localCheckout(),
      workflowRun('sync-backend-staging.yml'),
      workflowRun('app-candidate-preview.yml'),
      secretStatus(),
      workerFlagStatus(),
      publicDescriptor(target),
    ]);
  let pr = null;
  let prLookupReason = null;
  if (options.pullRequestNumber !== null && options.pullRequestNumber !== undefined) {
    pr = await pullRequestByNumber(options.pullRequestNumber);
    if (!pr) prLookupReason = 'selected pull request unavailable';
  } else if (options.ref === undefined || options.ref === null) {
    ({ pullRequest: pr, reason: prLookupReason } = await pullRequestForBranch(
      checkout.branch,
      checkout.headSha,
    ));
  }

  const candidate = options.ref
    ? summarizeRemoteCandidate('ref', options.ref, await remoteRef(options.ref), checkout)
    : pr && options.pullRequestNumber !== null && options.pullRequestNumber !== undefined
      ? summarizeRemoteCandidate('pull-request', `#${pr.number}`, pr.headSha, checkout)
      : summarizeCheckoutCandidate(checkout);
  const [checksRaw, prAfter, candidateBackendRaw, candidatePreviewRaw] = await Promise.all([
    pr
      ? ghJson(['pr', 'checks', String(pr.number), '--json', 'bucket,name,state,workflow'], {
          acceptNonzeroJson: true,
        })
      : Promise.resolve(null),
    pr ? pullRequestByNumber(pr.number) : Promise.resolve(null),
    candidate.headSha ? workflowRun('sync-backend-staging.yml', candidate.headSha) : null,
    candidate.headSha ? workflowRun('app-candidate-preview.yml', candidate.headSha) : null,
  ]);
  const samePrHead = Boolean(pr?.headSha && prAfter?.headSha === pr.headSha);
  const checks = pr
    ? samePrHead
      ? summarizeChecks(checksRaw, true)
      : summarizeChecks(null, false)
    : {
        state: 'not_applicable',
        counts: { pass: 0, fail: 0, pending: 0, skipped: 0, cancelled: 0 },
      };
  const latestRun = summarizeWorkflowRun(latestRaw, candidate.headSha);
  const candidateBackend = summarizeWorkflowRun(candidateBackendRaw, candidate.headSha);
  const latestPreview = summarizeWorkflowRun(latestPreviewRaw, candidate.headSha);
  const candidatePreview = summarizeWorkflowRun(candidatePreviewRaw, candidate.headSha);
  const report = {
    preflight: { state: 'blocked', blockers: [] },
    candidate,
    checkout,
    pullRequest: {
      number: pr?.number ?? null,
      headSha: pr?.headSha ?? null,
      branch: pr?.branch ?? null,
      state: pr?.state ?? (prLookupReason ? 'unavailable' : 'none selected'),
      relation: candidateRelation(checkout.headSha, pr?.headSha),
      checks,
      headStayedCurrent: samePrHead,
      lookupReason: prLookupReason,
    },
    backend: {
      targetName: target?.workerName ?? null,
      targetUrl: target?.url ?? null,
      latestRun,
      candidateRun: candidateBackend,
      descriptor,
    },
    preview: { latestRun: latestPreview, candidateRun: candidatePreview },
    secrets,
    workerFlags,
    manualAcceptance: 'not verified',
  };
  const blockers = [];
  const block = (ok, reason) => {
    if (!ok) blockers.push(reason);
  };
  block(checkout.available, 'local checkout status unavailable');
  block(candidate.headSha !== null, 'selected candidate commit is unavailable');
  if (candidate.source === 'checkout')
    block(checkout.dirty === false, 'selected checkout candidate has uncommitted changes');
  block(
    pr?.state === 'open',
    pr
      ? `selected PR #${pr.number} is ${pr.state ?? 'not open'}`
      : 'no open PR is associated with the selected candidate',
  );
  block(!prLookupReason, prLookupReason ?? 'pull request lookup was ambiguous');
  block(
    !pr || candidate.headSha === pr.headSha,
    'pull request head differs from the selected candidate',
  );
  block(!pr || samePrHead, 'pull request head changed while status was read');
  if (pr) block(checks.state === 'passed', 'PR checks are not all passing');
  block(readyRun(candidateBackend), 'staging workflow has not succeeded on the selected candidate');
  block(readyRun(candidatePreview), 'desktop preview has not succeeded on the selected candidate');
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
    'Rerun `pnpm staging:status` from `mezair-app/` after each setup or workflow change.',
  ];
  if (pr?.headSha && pr.branch && candidate.headSha === pr.headSha && !readyRun(candidatePreview)) {
    report.nextCommands.push(
      `Build the exact macOS and Linux previews with: gh workflow run app-candidate-preview.yml --ref ${shellQuote(pr.branch)} -f pull_request=${pr.number} -f head_sha=${pr.headSha}`,
    );
  }
  if (!pr && !prLookupReason)
    report.nextCommands.push(
      'Select an open PR explicitly with `pnpm staging:status --pr <number>` to check PR gates.',
    );
  if (report.preflight.state === 'ready_for_manual_acceptance') {
    report.nextCommands.push(
      'Start the signed-in and physical-device gates in `docs/runbooks/hosted-sync/staging-acceptance.md`.',
    );
  }
  return report;
}

function render(report) {
  const candidateTree =
    report.candidate.source === 'checkout'
      ? report.candidate.modified
        ? 'modified local tree; edits are not represented by the SHA'
        : 'clean local tree'
      : `local checkout ${report.candidate.localCheckoutRelation}${report.checkout.dirty ? ' and modified' : ''}`;
  const lines = [
    `Automated preflight: ${report.preflight.state === 'ready_for_manual_acceptance' ? 'PASS, ready for manual acceptance' : 'BLOCKED'}`,
    ...report.preflight.blockers.map((reason) => `Blocked: ${reason}`),
    `Checkout: ${report.checkout.branch ?? 'branch unavailable'} ${report.checkout.headSha ?? 'HEAD unavailable'} (${report.checkout.dirty === null ? 'dirty state unavailable' : report.checkout.dirty ? 'dirty' : 'clean'})`,
    report.pullRequest.headSha
      ? `PR #${report.pullRequest.number}: ${report.pullRequest.headSha}, local checkout ${report.pullRequest.relation}; checks ${report.pullRequest.checks.state} (${report.pullRequest.checks.counts.pass} pass, ${report.pullRequest.checks.counts.fail} fail, ${report.pullRequest.checks.counts.pending} pending, ${report.pullRequest.checks.counts.skipped} skipped)`
      : `PR: ${report.pullRequest.state}${report.pullRequest.lookupReason ? ` (${report.pullRequest.lookupReason})` : ''}`,
    `Selected candidate: ${report.candidate.source}${report.candidate.ref ? ` ${report.candidate.ref}` : ''} ${report.candidate.headSha ?? 'SHA unavailable'} (${candidateTree})`,
    `Latest staging workflow: ${formatRun(report.backend.latestRun)}`,
    `Staging workflow for selected candidate: ${formatRun(report.backend.candidateRun)}`,
    'A successful staging workflow identifies its commit; it does not prove signed-in or physical-device acceptance.',
    `Latest desktop preview: ${formatRun(report.preview.latestRun)}`,
    `Desktop preview for selected candidate: ${formatRun(report.preview.candidateRun)}`,
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
  let options;
  try {
    options = parseArguments(args);
  } catch {
    process.stderr.write('Usage: pnpm staging:status [--json] [--pr <number> | --ref <branch>]\n');
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(
      'Read-only staging preflight for the current checkout. Use --pr <number> to select a PR or --ref <branch> to select a remote branch. Use `pnpm --silent staging:status --json` for sanitized output.\n',
    );
    return;
  }
  try {
    const report = await buildStagingStatusReportFor(options);
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`,
    );
    if (report.preflight.state !== 'ready_for_manual_acceptance') process.exitCode = 1;
  } catch {
    process.stderr.write('Staging status check failed; details were suppressed.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
