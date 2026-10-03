#!/usr/bin/env node
/** Operator-only CLI for the hosted fair-use status and restriction endpoint. */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HostedDeployError, resolveSecretPath, validateManifest } from './hosted-deploy.mjs';

const AUDIENCE = 'anvil-hosted-operator';
const ENDPOINT = '/internal/hosted/operator/fair-use';
const RESTRICTION_CODES = new Set([
  'storage-usage',
  'sustained-excessive-usage',
  'service-protection',
]);
const SECRET_MIN_BYTES = 32;
const NOTICE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const EMERGENCY_SKEW_MS = 5 * 60 * 1000;

export class FairUseCliError extends Error {}

export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--confirm-emergency') {
      options.confirmEmergency = true;
      continue;
    }
    if (
      !['--environment', '--manifest', '--account', '--action', '--body-file', '--key-id'].includes(
        option,
      )
    )
      throw new FairUseCliError(`Unsupported option ${option}.`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new FairUseCliError(`${option} requires a value.`);
    if (option === '--environment') options.environment = value;
    else if (option === '--manifest') options.manifest = resolve(value);
    else if (option === '--account') options.accountId = value;
    else if (option === '--action') options.action = value;
    else if (option === '--body-file') options.bodyFile = resolve(value);
    else if (option === '--key-id') options.keyId = value;
  }
  if (!['staging', 'production'].includes(options.environment))
    throw new FairUseCliError('Choose an explicit --environment staging or production.');
  if (typeof options.manifest !== 'string')
    throw new FairUseCliError('--manifest must explicitly select the hosted target manifest.');
  if (
    typeof options.accountId !== 'string' ||
    options.accountId.length === 0 ||
    options.accountId.length > 256
  )
    throw new FairUseCliError('--account must be the personal sync account id.');
  if (!['status', 'set', 'clear'].includes(options.action))
    throw new FairUseCliError('--action must be status, set or clear.');
  if (options.action === 'set' && !options.bodyFile)
    throw new FairUseCliError('--body-file is required for --action set.');
  if (options.action !== 'set' && options.bodyFile)
    throw new FairUseCliError('--body-file is supported only for --action set.');
  return options;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new FairUseCliError(`${label} is missing or invalid JSON.`);
  }
}

function readOperatorKeys(secretFile) {
  const secrets = readJson(resolveSecretPath(secretFile), 'Backend secret file');
  const raw = secrets?.HOSTED_OPERATOR_KEYS;
  if (typeof raw !== 'string')
    throw new FairUseCliError(
      'HOSTED_OPERATOR_KEYS is not configured for the selected environment.',
    );
  const keys = readJsonText(raw, 'HOSTED_OPERATOR_KEYS');
  if (
    !keys ||
    typeof keys !== 'object' ||
    Array.isArray(keys) ||
    Object.keys(keys).length === 0 ||
    Object.entries(keys).some(
      ([keyId, secret]) =>
        !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) ||
        typeof secret !== 'string' ||
        Buffer.byteLength(secret, 'utf8') < SECRET_MIN_BYTES,
    )
  )
    throw new FairUseCliError('HOSTED_OPERATOR_KEYS has an invalid key map.');
  return keys;
}

function readJsonText(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new FairUseCliError(`${label} is not valid JSON.`);
  }
}

function buildBody(options, now) {
  if (options.action !== 'set') return { accountId: options.accountId, action: options.action };
  const details = readJson(options.bodyFile, 'Set payload file');
  const allowedKeys = new Set(['code', 'message', 'restrictAt', 'emergency']);
  if (
    !details ||
    typeof details !== 'object' ||
    Array.isArray(details) ||
    Object.keys(details).some((key) => !allowedKeys.has(key))
  )
    throw new FairUseCliError(
      'Set payload must contain only code, message, restrictAt, and emergency.',
    );
  if (!RESTRICTION_CODES.has(details.code))
    throw new FairUseCliError('Set payload code is not a supported fair-use reason.');
  if (
    typeof details.message !== 'string' ||
    details.message.trim().length === 0 ||
    details.message.length > 500 ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(details.message)
  )
    throw new FairUseCliError(
      'Set payload message must be plain text between 1 and 500 characters.',
    );
  if (
    typeof details.restrictAt !== 'string' ||
    details.restrictAt.length > 32 ||
    !Number.isFinite(Date.parse(details.restrictAt)) ||
    new Date(Date.parse(details.restrictAt)).toISOString() !== details.restrictAt
  )
    throw new FairUseCliError('Set payload restrictAt must be a canonical ISO timestamp.');
  if (details.emergency !== undefined && typeof details.emergency !== 'boolean')
    throw new FairUseCliError('Set payload emergency must be a boolean when present.');
  const emergency = details.emergency === true;
  const restrictionTime = Date.parse(details.restrictAt);
  if (emergency) {
    if (!options.confirmEmergency)
      throw new FairUseCliError('Emergency restrictions require --confirm-emergency.');
    if (Math.abs(restrictionTime - now) > EMERGENCY_SKEW_MS)
      throw new FairUseCliError('Emergency restrictAt must be within five minutes of now.');
  } else if (restrictionTime < now + NOTICE_PERIOD_MS) {
    throw new FairUseCliError('Ordinary restrictions must be scheduled at least seven days ahead.');
  }
  return {
    accountId: options.accountId,
    action: 'set',
    code: details.code,
    message: details.message.trim(),
    restrictAt: details.restrictAt,
    ...(details.emergency === undefined ? {} : { emergency }),
  };
}

export function signedHeaders({ url, body, keyId, secret, now, requestId = randomUUID() }) {
  const timestamp = String(now);
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const parsedUrl = new URL(url);
  const signatureInput = [
    'anvil-hosted/1',
    AUDIENCE,
    keyId,
    'POST',
    parsedUrl.pathname + parsedUrl.search,
    timestamp,
    requestId,
    bodyHash,
  ].join('\n');
  const signature = createHmac('sha256', secret).update(signatureInput, 'utf8').digest('hex');
  return {
    'content-type': 'application/json',
    'x-anvil-key-id': keyId,
    'x-anvil-timestamp': timestamp,
    'x-anvil-request-id': requestId,
    'x-anvil-signature': signature,
  };
}

export async function run(argv, dependencies = {}) {
  const options = parseArgs(argv);
  if (process.env.ANVIL_DEPLOYMENT_ENV && process.env.ANVIL_DEPLOYMENT_ENV !== options.environment)
    throw new FairUseCliError(
      `ANVIL_DEPLOYMENT_ENV conflicts with --environment ${options.environment}.`,
    );
  const manifest = readJson(options.manifest, 'Hosted target manifest');
  const target = validateManifest(manifest, options.environment);
  const keys = readOperatorKeys(target.secrets.backendFile);
  let keyId = options.keyId;
  if (keyId && !Object.hasOwn(keys, keyId))
    throw new FairUseCliError('--key-id is not present in HOSTED_OPERATOR_KEYS.');
  if (!keyId) {
    const ids = Object.keys(keys).sort();
    if (ids.length !== 1)
      throw new FairUseCliError('Pass --key-id when HOSTED_OPERATOR_KEYS contains multiple keys.');
    keyId = ids[0];
  }
  const now = dependencies.now ?? Date.now();
  const body = Buffer.from(JSON.stringify(buildBody(options, now)), 'utf8');
  const url = new URL(ENDPOINT, target.baseUrl);
  const headers = signedHeaders({
    url,
    body,
    keyId,
    secret: keys[keyId],
    now,
    requestId: dependencies.requestId,
  });
  const fetchFn = dependencies.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== 'function')
    throw new FairUseCliError('Fetch is unavailable in this Node runtime.');
  const response = await fetchFn(url, { method: 'POST', headers, body });
  const responseText = await response.text();
  if (!response.ok)
    throw new FairUseCliError(
      `Hosted operator request failed with HTTP ${response.status}: ${responseText}`,
    );
  (dependencies.write ?? process.stdout.write.bind(process.stdout))(`${responseText}\n`);
  return 0;
}

export function usage() {
  return [
    'Usage: node scripts/hosted-fair-use.mjs --environment staging|production --manifest <path> --account <personal-sync-account-id> --action status|set|clear [options]',
    'Options: --key-id <id> --body-file <json> --confirm-emergency',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      process.stdout.write(`${usage()}\n`);
    } else {
      process.exitCode = await run(process.argv.slice(2));
    }
  } catch (error) {
    process.stderr.write(
      `hosted-fair-use: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
