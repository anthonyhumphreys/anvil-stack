#!/usr/bin/env node
/** Select and validate a hosted target before invoking the Anvil Cloud CLI. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

export const BACKEND_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_MANIFEST = join(BACKEND_DIR, '.wrangler', 'hosted-targets.json');
const WORKOS_ISSUER = 'https://api.workos.com/user_management';
const SECRET_NAMES = new Set([
  'HOSTED_SERVICE_KEYS',
  'HOSTED_OPERATOR_KEYS',
  'MANAGED_PROVISIONER_TOKEN',
  'WORKOS_API_KEY',
  'WORKOS_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
]);

export class HostedDeployError extends Error {}

export function parseArgs(args) {
  let environment;
  let manifestPath = DEFAULT_MANIFEST;
  const positionals = [];
  const flags = [];
  for (let i = args[0] === '--' ? 1 : 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--environment' || arg === '--manifest') {
      const value = args[++i];
      if (!value) throw new HostedDeployError(`${arg} requires a value.`);
      if (arg === '--environment') environment = value;
      else manifestPath = resolve(value);
    } else if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg.startsWith('--')) {
      flags.push(arg);
      if (arg === '--evidence') {
        const value = args[++i];
        if (!value || value.startsWith('--'))
          throw new HostedDeployError('--evidence requires a reference.');
        flags.push(value);
      }
    } else positionals.push(arg);
  }
  if (!['staging', 'production'].includes(environment)) {
    throw new HostedDeployError(
      'Choose an explicit --environment staging or --environment production.',
    );
  }
  return { environment, manifestPath, command: positionals[0], subcommand: positionals[1], flags };
}

function requireName(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new HostedDeployError(`${label} must be a lowercase Cloudflare resource name.`);
  }
}

function validateTarget(target, environment) {
  if (!target || target.stage !== environment)
    throw new HostedDeployError(`${environment} target is missing or has the wrong stage.`);
  if (!/^[a-f0-9]{32}$/i.test(target.accountId ?? ''))
    throw new HostedDeployError(`${environment}.accountId must be a Cloudflare account id.`);
  for (const field of ['workerName', 'artifactsBucket', 'databaseName'])
    requireName(target[field], `${environment}.${field}`);
  if (target.databaseId && !/^[a-f0-9-]{36}$/i.test(target.databaseId))
    throw new HostedDeployError(
      `${environment}.databaseId must be a D1 UUID or null until provisioned.`,
    );
  let origin;
  try {
    origin = new URL(target.baseUrl);
  } catch {
    throw new HostedDeployError(`${environment}.baseUrl must be an HTTPS origin.`);
  }
  if (origin.protocol !== 'https:' || origin.origin !== target.baseUrl || origin.pathname !== '/') {
    throw new HostedDeployError(`${environment}.baseUrl must be an HTTPS origin without a path.`);
  }
  if (
    typeof target.deploymentId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.deploymentId)
  ) {
    throw new HostedDeployError(`${environment}.deploymentId must be a stable descriptor id.`);
  }
  if (typeof target.deploymentName !== 'string' || !target.deploymentName.trim())
    throw new HostedDeployError(`${environment}.deploymentName is required.`);
  if (target.workos?.issuer !== WORKOS_ISSUER)
    throw new HostedDeployError(`${environment}.workos.issuer must be ${WORKOS_ISSUER}.`);
  for (const key of ['desktopClientId', 'hostedClientId']) {
    if (!/^client_[A-Za-z0-9_-]{1,240}$/.test(target.workos?.[key] ?? ''))
      throw new HostedDeployError(`${environment}.workos.${key} must be a WorkOS client id.`);
  }
  if (typeof target.managedProvisioner !== 'boolean')
    throw new HostedDeployError(`${environment}.managedProvisioner must be true or false.`);
  if (target.managedProvisioner)
    requireName(target.provisionerName, `${environment}.provisionerName`);
  const secretSources = ['backendFile', 'backendEnvFile', 'backendEnv'].filter(
    (key) => target.secrets?.[key] !== undefined,
  );
  if (secretSources.length !== 1)
    throw new HostedDeployError(
      `${environment}.secrets must select exactly one of backendFile, backendEnvFile, or backendEnv.`,
    );
  if (target.secrets.backendEnv !== undefined && target.secrets.backendEnv !== 'process')
    throw new HostedDeployError(`${environment}.secrets.backendEnv must be "process".`);
  if (
    (target.secrets.backendEnvFile !== undefined &&
      (typeof target.secrets.backendEnvFile !== 'string' || !target.secrets.backendEnvFile)) ||
    (target.secrets.backendFile !== undefined &&
      (typeof target.secrets.backendFile !== 'string' || !target.secrets.backendFile))
  )
    throw new HostedDeployError(`${environment} backend secret source must be a non-empty path.`);
  const usesEnvironmentSecrets = Boolean(
    target.secrets.backendEnvFile || target.secrets.backendEnv === 'process',
  );
  if (usesEnvironmentSecrets && target.secrets.provisionerTokenFile !== undefined)
    throw new HostedDeployError(
      `${environment}.secrets.provisionerTokenFile cannot be used with an environment secret source.`,
    );
  if (target.managedProvisioner && !usesEnvironmentSecrets && !target.secrets.provisionerTokenFile)
    throw new HostedDeployError(`${environment}.secrets.provisionerTokenFile is required.`);
  return target;
}

export function validateManifest(manifest, environment) {
  if (manifest?.schemaVersion !== 1 || !manifest.environments)
    throw new HostedDeployError('Manifest must have schemaVersion 1 and an environments object.');
  const staging = validateTarget(manifest.environments.staging, 'staging');
  const target = validateTarget(manifest.environments[environment], environment);
  if (environment === 'production') {
    const stagingWorkers = new Set([
      staging.workerName,
      ...(staging.managedProvisioner ? [staging.provisionerName] : []),
    ]);
    const productionWorkers = [
      target.workerName,
      ...(target.managedProvisioner ? [target.provisionerName] : []),
    ];
    if (productionWorkers.some((name) => stagingWorkers.has(name))) {
      throw new HostedDeployError(
        'Production backend and provisioner Workers must not reuse either staging Worker.',
      );
    }
    for (const field of [
      'workerName',
      'artifactsBucket',
      'databaseName',
      'baseUrl',
      'deploymentId',
    ]) {
      if (target[field] === staging[field])
        throw new HostedDeployError(`Production ${field} must be separate from staging.`);
    }
    if (target.databaseId && target.databaseId === staging.databaseId)
      throw new HostedDeployError('Production D1 id must be separate from staging.');
    if (target.managedProvisioner && target.provisionerName === staging.provisionerName)
      throw new HostedDeployError('Production provisioner Worker must be separate from staging.');
    for (const key of ['desktopClientId', 'hostedClientId']) {
      if (
        [staging.workos.desktopClientId, staging.workos.hostedClientId].includes(target.workos[key])
      ) {
        throw new HostedDeployError(
          `Production WorkOS ${key} must use the production WorkOS application.`,
        );
      }
    }
  }
  if (target.managedProvisioner && target.provisionerName === target.workerName)
    throw new HostedDeployError('Backend and provisioner Worker names must differ.');
  return target;
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new HostedDeployError(
      `Cannot read valid JSON from ${path}. Copy hosted-targets.example.json to .wrangler/hosted-targets.json and complete production before deployment.`,
    );
  }
}

function pathsFor(target) {
  const directory = join(BACKEND_DIR, '.wrangler', 'mesh', target.workerName);
  return {
    directory,
    vars: join(directory, 'vars.json'),
    config: join(directory, 'wrangler.jsonc'),
    connection: join(directory, 'connection.json'),
    provisioner: join(directory, 'provisioner.jsonc'),
  };
}

export function resolveSecretPath(path) {
  return isAbsolute(path) ? path : resolve(BACKEND_DIR, path);
}

export function mergeTargetVars(existing, target) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing))
    throw new HostedDeployError('Existing vars must be a JSON object.');
  if (
    Object.keys(existing).some(
      (name) =>
        SECRET_NAMES.has(name) ||
        ['ANVIL_DEV_SPIKE', 'ENROLLMENT_ADMIN_TOKEN'].includes(name) ||
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ||
        typeof existing[name] !== 'string',
    )
  ) {
    throw new HostedDeployError('Existing vars contain an invalid or secret Worker var.');
  }
  return {
    ...existing,
    // Managed Anvil compute is a separate product and stays opt-in. Sync
    // subscription settings are deliberately retired in this service.
    HOSTED_CHECKOUT_ENABLED: 'false',
    ANVIL_CLOUD_AGENTS_ENABLED: existing.ANVIL_CLOUD_AGENTS_ENABLED ?? 'false',
    ANVIL_DEPLOYMENT_ID: target.deploymentId,
    ANVIL_DEPLOYMENT_NAME: target.deploymentName,
    HOSTED_BILLING_ENVIRONMENT: target.stage,
    HOSTED_WORKOS_CLIENT_ID: target.workos.hostedClientId,
    OIDC_ISSUER: target.workos.issuer,
    OIDC_CLIENT_ID: target.workos.desktopClientId,
    OIDC_SCOPES: 'openid profile',
  };
}

function targetVars(target, path) {
  let existing = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new HostedDeployError(`${path} must contain a JSON object of non-secret Worker vars.`);
    }
  }
  const vars = mergeTargetVars(existing, target);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(vars, null, 2)}\n`, { mode: 0o600 });
  return vars;
}

function configuredWorkosAdmissions(config, environment) {
  const value = config.vars?.HOSTED_ADMITTED_WORKOS_USER_IDS;
  if (value === undefined) return new Set();
  if (typeof value !== 'string')
    throw new HostedDeployError(
      `${environment} HOSTED_ADMITTED_WORKOS_USER_IDS must be a JSON array string.`,
    );
  let userIds;
  try {
    userIds = JSON.parse(value);
  } catch {
    throw new HostedDeployError(
      `${environment} HOSTED_ADMITTED_WORKOS_USER_IDS must be valid JSON.`,
    );
  }
  if (
    !Array.isArray(userIds) ||
    userIds.length > 1000 ||
    userIds.some((id) => typeof id !== 'string' || !/^user_[A-Za-z0-9_-]{1,240}$/.test(id)) ||
    new Set(userIds).size !== userIds.length
  )
    throw new HostedDeployError(
      `${environment} HOSTED_ADMITTED_WORKOS_USER_IDS must contain at most 1,000 unique WorkOS user IDs.`,
    );
  return new Set(userIds);
}

export function validateGeneratedConfig(
  path,
  target,
  environment,
  requireD1 = false,
  stagingConfigPath,
) {
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new HostedDeployError(
      `${environment} generated config is missing or invalid; run plan or provision first.`,
    );
  }
  if (config.name !== target.workerName || config.account_id !== target.accountId)
    throw new HostedDeployError(
      `${environment} generated config has the wrong Worker or Cloudflare account.`,
    );
  if (config.vars?.HOSTED_BILLING_ENFORCEMENT !== 'true')
    throw new HostedDeployError(`${environment} hosted billing enforcement must be enabled.`);
  if (config.vars?.HOSTED_BILLING_ENVIRONMENT !== environment)
    throw new HostedDeployError(
      `${environment} generated config has the wrong HOSTED_BILLING_ENVIRONMENT.`,
    );
  if (config.vars?.HOSTED_CHECKOUT_ENABLED === 'true')
    throw new HostedDeployError(`${environment} Sync checkout is retired and must remain disabled.`);
  if (!['true', 'false'].includes(config.vars?.ANVIL_CLOUD_AGENTS_ENABLED))
    throw new HostedDeployError(
      `${environment} ANVIL_CLOUD_AGENTS_ENABLED must be the literal string 'true' or 'false'.`,
    );
  const admissions = configuredWorkosAdmissions(config, environment);
  if (environment === 'production' && config.vars?.STRIPE_API_BASE)
    throw new HostedDeployError('Production generated config must not set STRIPE_API_BASE.');
  for (const [key, value] of Object.entries({
    ANVIL_DEPLOYMENT_ID: target.deploymentId,
    ANVIL_DEPLOYMENT_NAME: target.deploymentName,
    HOSTED_WORKOS_CLIENT_ID: target.workos.hostedClientId,
    OIDC_ISSUER: target.workos.issuer,
    OIDC_CLIENT_ID: target.workos.desktopClientId,
  }))
    if (config.vars?.[key] !== value)
      throw new HostedDeployError(
        `${environment} generated vars.${key} does not match the selected target.`,
      );
  if (
    config.r2_buckets?.find((binding) => binding.binding === 'ARTIFACTS')?.bucket_name !==
    target.artifactsBucket
  )
    throw new HostedDeployError(`${environment} generated config has the wrong ARTIFACTS bucket.`);
  const d1 = config.d1_databases?.find((binding) => binding.binding === 'HOSTED_DB');
  if (d1?.database_name !== target.databaseName)
    throw new HostedDeployError(
      `${environment} generated config has the wrong HOSTED_DB database.`,
    );
  const id = d1?.database_id;
  if (requireD1 && (!id || /unprovisioned|placeholder/i.test(id)))
    throw new HostedDeployError(
      `${environment} D1 database must be provisioned before this command.`,
    );
  const unresolvedD1 = !id || /unprovisioned|placeholder/i.test(id);
  if (target.databaseId && id !== target.databaseId && !(unresolvedD1 && !requireD1))
    throw new HostedDeployError(
      `${environment} generated config does not match the manifest D1 id.`,
    );
  if (environment === 'production' && id && id === target._stagingDatabaseId)
    throw new HostedDeployError('Production generated config points at the staging D1 database.');
  if (
    environment === 'production' &&
    Object.hasOwn(config.vars ?? {}, 'HOSTED_ALLOW_EARLY_CHECKOUT')
  )
    throw new HostedDeployError(
      'Production generated config must not set HOSTED_ALLOW_EARLY_CHECKOUT.',
    );
  if (
    environment === 'staging' &&
    config.vars?.HOSTED_ALLOW_EARLY_CHECKOUT !== undefined &&
    config.vars?.HOSTED_ALLOW_EARLY_CHECKOUT !== 'true'
  )
    throw new HostedDeployError(
      'Staging HOSTED_ALLOW_EARLY_CHECKOUT must be the literal string true.',
    );
  if (
    environment === 'production' &&
    admissions.size > 0
  ) {
    let stagingConfig;
    try {
      stagingConfig = JSON.parse(readFileSync(stagingConfigPath, 'utf8'));
    } catch {
      throw new HostedDeployError(
        'Production isolation checks require the generated Staging config first.',
      );
    }
    const stagingAdmissions = configuredWorkosAdmissions(stagingConfig, 'staging');
    if ([...admissions].some((id) => stagingAdmissions.has(id)))
      throw new HostedDeployError(
        'Production HOSTED_ADMITTED_WORKOS_USER_IDS must not reuse Staging WorkOS user IDs.',
      );
  }
  if (
    target.managedProvisioner &&
    config.services?.find((binding) => binding.binding === 'MANAGED_PROVISIONER')?.service !==
      target.provisionerName
  ) {
    throw new HostedDeployError(
      `${environment} generated config has the wrong managed provisioner binding.`,
    );
  }
  if (
    !target.managedProvisioner &&
    config.services?.some((binding) => binding.binding === 'MANAGED_PROVISIONER')
  )
    throw new HostedDeployError(
      `${environment} generated config unexpectedly binds a managed provisioner.`,
    );
  return config;
}

export function validateStripeSecretMode(key, environment) {
  const expectedPrefix = environment === 'staging' ? 'sk_test_' : 'sk_live_';
  if (typeof key !== 'string' || !key.startsWith(expectedPrefix))
    throw new HostedDeployError(
      `${environment} STRIPE_SECRET_KEY must use the ${environment === 'staging' ? 'test' : 'live'} Stripe mode.`,
    );
}

function validateHmacKeyMap(value, label, environment) {
  if (typeof value !== 'string' || value.length < 32)
    throw new HostedDeployError(
      `${environment} ${label} must be a JSON map of secrets at least 32 characters long.`,
    );
  let keys;
  try {
    keys = JSON.parse(value);
  } catch {
    throw new HostedDeployError(`${environment} ${label} must be a JSON object.`);
  }
  if (
    !keys ||
    typeof keys !== 'object' ||
    Array.isArray(keys) ||
    Object.keys(keys).length === 0 ||
    Object.entries(keys).some(
      ([id, secret]) =>
        !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
        typeof secret !== 'string' ||
        new TextEncoder().encode(secret).byteLength < 32,
    )
  )
    throw new HostedDeployError(
      `${environment} ${label} must map key ids to secrets of at least 32 bytes.`,
    );
  return keys;
}

function assertSeparateHmacAudiences(serviceKeys, operatorKeys, environment) {
  if (!operatorKeys) return;
  const serviceValues = new Set(Object.values(serviceKeys));
  if (Object.values(operatorKeys).some((secret) => serviceValues.has(secret)))
    throw new HostedDeployError(
      `${environment} HOSTED_OPERATOR_KEYS must not reuse a HOSTED_SERVICE_KEYS secret.`,
    );
}

export function validateBackendSecrets(secrets, target, environment) {
  if (
    !secrets ||
    typeof secrets !== 'object' ||
    Array.isArray(secrets) ||
    Object.keys(secrets).some(
      (name) => !SECRET_NAMES.has(name) || typeof secrets[name] !== 'string',
    )
  ) {
    throw new HostedDeployError(`${environment} backend secret file has an invalid shape.`);
  }
  const serviceKeys = validateHmacKeyMap(
    secrets.HOSTED_SERVICE_KEYS,
    'HOSTED_SERVICE_KEYS',
    environment,
  );
  if (typeof secrets.WORKOS_API_KEY !== 'string' || !secrets.WORKOS_API_KEY.startsWith('sk_'))
    throw new HostedDeployError(
      `${environment} requires its WorkOS environment WORKOS_API_KEY secret.`,
    );
  if (
    typeof secrets.WORKOS_WEBHOOK_SECRET !== 'string' ||
    secrets.WORKOS_WEBHOOK_SECRET.length < 20 ||
    /\s/.test(secrets.WORKOS_WEBHOOK_SECRET)
  )
    throw new HostedDeployError(`${environment} requires its WorkOS WORKOS_WEBHOOK_SECRET.`);
  const operatorKeys =
    secrets.HOSTED_OPERATOR_KEYS === undefined
      ? undefined
      : validateHmacKeyMap(secrets.HOSTED_OPERATOR_KEYS, 'HOSTED_OPERATOR_KEYS', environment);
  assertSeparateHmacAudiences(serviceKeys, operatorKeys, environment);
  if (Boolean(secrets.STRIPE_SECRET_KEY) !== Boolean(secrets.STRIPE_WEBHOOK_SECRET))
    throw new HostedDeployError(`${environment} Stripe secrets must be configured together.`);
  if (secrets.STRIPE_SECRET_KEY) validateStripeSecretMode(secrets.STRIPE_SECRET_KEY, environment);
  if (
    target.managedProvisioner &&
    (typeof secrets.MANAGED_PROVISIONER_TOKEN !== 'string' ||
      secrets.MANAGED_PROVISIONER_TOKEN.length < 32)
  )
    throw new HostedDeployError(
      `${environment} requires MANAGED_PROVISIONER_TOKEN for its managed provisioner.`,
    );
  return secrets;
}

export function validateCheckoutSecrets(config, secrets, environment) {
  if (config.vars?.HOSTED_CHECKOUT_ENABLED === 'true')
    throw new HostedDeployError(`${environment} Sync checkout is retired and must remain disabled.`);
  // Stripe credentials are optional: they support cleanup of existing
  // subscriptions through the portal and webhook mirror, never new sales.
  if (secrets?.STRIPE_SECRET_KEY) validateStripeSecretMode(secrets.STRIPE_SECRET_KEY, environment);
}

function validateDotenvSyntax(contents, environment) {
  let multilineQuote;
  for (const line of contents.split(/\r?\n/)) {
    if (multilineQuote) {
      const end = findDotenvQuote(line, multilineQuote, 0);
      if (end < 0) continue;
      if (!validDotenvTrailingText(line.slice(end + 1)))
        throw new HostedDeployError(`${environment} backend environment file is malformed.`);
      multilineQuote = undefined;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const assignment = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(trimmed);
    if (!assignment)
      throw new HostedDeployError(`${environment} backend environment file is malformed.`);
    const value = assignment[1];
    const quote = value[0];
    if (quote !== '"' && quote !== "'" && quote !== '`') continue;
    const end = findDotenvQuote(value, quote);
    if (end < 0) multilineQuote = quote;
    else if (!validDotenvTrailingText(value.slice(end + 1)))
      throw new HostedDeployError(`${environment} backend environment file is malformed.`);
  }
  if (multilineQuote)
    throw new HostedDeployError(`${environment} backend environment file is malformed.`);
}

function findDotenvQuote(value, quote, start = 1) {
  return value.indexOf(quote, start);
}

function validDotenvTrailingText(value) {
  const trailing = value.trim();
  return !trailing || trailing.startsWith('#');
}

function selectBackendSecrets(values) {
  return Object.fromEntries(
    [...SECRET_NAMES]
      .filter((name) => Object.hasOwn(values, name))
      .map((name) => [name, values[name]]),
  );
}

export function readBackendSecrets(target, environment) {
  const source = target.secrets;
  let secrets;
  if (source.backendFile) {
    try {
      secrets = JSON.parse(readFileSync(resolveSecretPath(source.backendFile), 'utf8'));
    } catch {
      throw new HostedDeployError(`${environment} backend secret file is missing or invalid JSON.`);
    }
  } else if (source.backendEnvFile) {
    let values;
    try {
      const contents = readFileSync(resolveSecretPath(source.backendEnvFile), 'utf8');
      validateDotenvSyntax(contents, environment);
      values = parseEnv(contents);
    } catch (error) {
      if (error instanceof HostedDeployError) throw error;
      throw new HostedDeployError(`${environment} backend environment file is missing or invalid.`);
    }
    if (values.ANVIL_DEPLOYMENT_ENV !== environment)
      throw new HostedDeployError(
        `${environment} backend environment file must set ANVIL_DEPLOYMENT_ENV=${environment}.`,
      );
    secrets = selectBackendSecrets(values);
  } else if (source.backendEnv === 'process') {
    if (process.env.ANVIL_DEPLOYMENT_ENV !== environment)
      throw new HostedDeployError(
        `${environment} process environment must set ANVIL_DEPLOYMENT_ENV=${environment}.`,
      );
    secrets = selectBackendSecrets(process.env);
  } else {
    throw new HostedDeployError(`${environment} backend secret source is not configured.`);
  }
  return validateBackendSecrets(secrets, target, environment);
}

export function readProvisionerToken(target, environment) {
  if (target.secrets.backendEnvFile || target.secrets.backendEnv === 'process') {
    const secrets = readBackendSecrets(target, environment);
    return secrets.MANAGED_PROVISIONER_TOKEN;
  }
  let token;
  try {
    token = readFileSync(resolveSecretPath(target.secrets.provisionerTokenFile), 'utf8').trim();
  } catch {
    throw new HostedDeployError(`${environment} provisioner token file is missing.`);
  }
  if (token.length < 32)
    throw new HostedDeployError(
      `${environment} provisioner token must contain at least 32 characters.`,
    );
  return token;
}

export function assertProductionSecretsAreFresh(manifest, secrets) {
  const staging = manifest.environments.staging;
  if (
    !staging.secrets?.backendFile &&
    !staging.secrets?.backendEnvFile &&
    staging.secrets?.backendEnv !== 'process'
  )
    throw new HostedDeployError(
      'Production requires a Staging backend secret source for isolation checks.',
    );
  if (staging.secrets.backendEnv === 'process')
    throw new HostedDeployError(
      'Production requires Staging secrets in a file for isolation checks; process environment secrets cannot supply both environments.',
    );
  if (staging.secrets.backendFile && !existsSync(resolveSecretPath(staging.secrets.backendFile)))
    throw new HostedDeployError(
      'Production requires the Staging backend secret file for isolation checks.',
    );
  const stagingSecrets = readBackendSecrets(staging, 'staging');
  for (const [name, value] of Object.entries(secrets)) {
    if (name !== 'HOSTED_SERVICE_KEYS' && value === stagingSecrets[name])
      throw new HostedDeployError(`Production secret ${name} reuses staging.`);
  }
  for (const name of ['HOSTED_SERVICE_KEYS', 'HOSTED_OPERATOR_KEYS']) {
    if (stagingSecrets[name] && secrets[name]) {
      const stageKeys = JSON.parse(stagingSecrets[name]);
      const prodKeys = JSON.parse(secrets[name]);
      if (Object.values(prodKeys).some((value) => Object.values(stageKeys).includes(value)))
        throw new HostedDeployError(`Production ${name} reuses a staging key.`);
    }
  }
  const stageService = Object.values(JSON.parse(stagingSecrets.HOSTED_SERVICE_KEYS));
  const stageOperator = stagingSecrets.HOSTED_OPERATOR_KEYS
    ? Object.values(JSON.parse(stagingSecrets.HOSTED_OPERATOR_KEYS))
    : [];
  const productionService = Object.values(JSON.parse(secrets.HOSTED_SERVICE_KEYS));
  const productionOperator = secrets.HOSTED_OPERATOR_KEYS
    ? Object.values(JSON.parse(secrets.HOSTED_OPERATOR_KEYS))
    : [];
  if (
    productionOperator.some((value) => stageService.includes(value)) ||
    productionService.some((value) => stageOperator.includes(value))
  )
    throw new HostedDeployError(
      'Production hosted HMAC keys must not reuse keys from either staging audience.',
    );
  if (secrets.MANAGED_PROVISIONER_TOKEN && staging.managedProvisioner) {
    if (staging.secrets.backendEnvFile || staging.secrets.backendEnv === 'process') {
      if (stagingSecrets.MANAGED_PROVISIONER_TOKEN === secrets.MANAGED_PROVISIONER_TOKEN)
        throw new HostedDeployError('Production provisioner token reuses staging.');
    } else if (staging.secrets.provisionerTokenFile) {
      const path = resolveSecretPath(staging.secrets.provisionerTokenFile);
      if (
        existsSync(path) &&
        readFileSync(path, 'utf8').trim() === secrets.MANAGED_PROVISIONER_TOKEN
      )
        throw new HostedDeployError('Production provisioner token reuses staging.');
    }
  }
}

export function withSecretFiles({ backendSecrets, provisionerToken }, action) {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-hosted-secrets-'));
  const files = {};
  try {
    if (backendSecrets !== undefined) {
      files.backendSecretFile = join(directory, 'backend-secrets.json');
      writeFileSync(files.backendSecretFile, JSON.stringify(selectBackendSecrets(backendSecrets)), {
        flag: 'wx',
        mode: 0o600,
      });
    }
    if (provisionerToken !== undefined) {
      files.provisionerTokenFile = join(directory, 'provisioner-token');
      writeFileSync(files.provisionerTokenFile, provisionerToken, {
        flag: 'wx',
        mode: 0o600,
      });
    }
    return action(files);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function checkedFlags(command, subcommand, flags, environment) {
  const simple = new Set(['--json', '--dry-run', '--test-deployment', '--first-deploy']);
  const accepted = [];
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === '--evidence') {
      if (
        !(
          command === 'apply' ||
          command === 'remove' ||
          (command === 'provisioner' && (subcommand === 'apply' || subcommand === 'remove'))
        )
      ) {
        throw new HostedDeployError('--evidence is supported only for apply or remove.');
      }
      accepted.push('--evidence', flags[++i]);
    } else if (simple.has(flags[i])) accepted.push(flags[i]);
    else
      throw new HostedDeployError(
        `Unsupported flag ${flags[i]}; resource and config selection comes from the manifest.`,
      );
  }
  if (environment === 'production' && accepted.includes('--test-deployment'))
    throw new HostedDeployError('--test-deployment is forbidden for production.');
  if (
    accepted.includes('--dry-run') &&
    !(command === 'apply' || (command === 'provisioner' && subcommand === 'apply'))
  )
    throw new HostedDeployError('--dry-run is supported only for apply.');
  if (accepted.includes('--first-deploy') && !['plan', 'provision'].includes(command))
    throw new HostedDeployError('--first-deploy is supported only for plan or provision.');
  return accepted;
}

export function cliArgs(command, subcommand, target, paths, flags, secretFiles = {}) {
  const common = ['--stage', target.stage, '--account-id', target.accountId];
  if (command === 'provisioner')
    return [
      'mesh',
      'provisioner',
      subcommand,
      '--provisioner',
      join(BACKEND_DIR, '..', 'provisioner'),
      '--name',
      target.provisionerName,
      '--mode',
      'managed',
      ...common,
      '--config-out',
      paths.provisioner,
      ...(subcommand === 'secrets'
        ? [
            '--from-file',
            secretFiles.provisionerTokenFile ??
              resolveSecretPath(target.secrets.provisionerTokenFile),
          ]
        : []),
      ...flags,
    ];
  if (command === 'connection')
    return [
      'mesh',
      'connection',
      '--name',
      target.workerName,
      '--stage',
      target.stage,
      '--base-url',
      target.baseUrl,
      '--out',
      paths.connection,
      ...flags,
    ];
  return [
    'mesh',
    command,
    '--backend',
    BACKEND_DIR,
    '--mode',
    'hosted',
    '--name',
    target.workerName,
    ...common,
    '--base-url',
    target.baseUrl,
    '--bucket',
    target.artifactsBucket,
    '--database',
    target.databaseName,
    '--vars-file',
    paths.vars,
    '--config-out',
    paths.config,
    '--connection-out',
    paths.connection,
    ...(target.managedProvisioner ? ['--managed-provisioner', target.provisionerName] : []),
    ...(command === 'secrets'
      ? [
          '--from-file',
          secretFiles.backendSecretFile ?? resolveSecretPath(target.secrets.backendFile),
        ]
      : []),
    ...flags,
  ];
}

function resolveCli() {
  const configured = process.env.ANVIL_CLOUD_CLI;
  if (configured)
    return configured.endsWith('.js') ? [process.execPath, resolve(configured)] : [configured];
  const checkout = resolve(BACKEND_DIR, '../../../anvil-cloud/packages/cli/dist/index.js');
  return existsSync(checkout) ? [process.execPath, checkout] : ['anvil-cloud'];
}

function execute(args, environment) {
  const [executable, ...prefix] = resolveCli();
  const result = spawnSync(executable, [...prefix, ...args], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ANVIL_DEPLOYMENT_ENV: environment },
    stdio: 'inherit',
  });
  if (result.error)
    throw new HostedDeployError(`Could not start the Anvil Cloud CLI: ${result.error.message}`);
  return result.status ?? 1;
}

export function usage() {
  return 'Usage: pnpm hosted:deploy -- --environment staging|production <plan|provision|migrate|apply|remove|secrets|connection|provisioner plan|apply|remove|secrets> [--json] [--test-deployment|--evidence <ref>]';
}

export function run(argv, executeCommand = execute) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const { environment, manifestPath, command, subcommand, flags } = parsed;
  if (process.env.ANVIL_DEPLOYMENT_ENV && process.env.ANVIL_DEPLOYMENT_ENV !== environment)
    throw new HostedDeployError(
      `ANVIL_DEPLOYMENT_ENV conflicts with --environment ${environment}.`,
    );
  const manifest = readManifest(manifestPath);
  const target = validateManifest(manifest, environment);
  const supported = [
    'plan',
    'provision',
    'migrate',
    'apply',
    'remove',
    'secrets',
    'connection',
    'provisioner',
  ];
  if (
    !supported.includes(command) ||
    (command === 'provisioner' && !['plan', 'apply', 'remove', 'secrets'].includes(subcommand)) ||
    (command !== 'provisioner' && subcommand)
  ) {
    throw new HostedDeployError(`Unsupported command. ${usage()}`);
  }
  if (command === 'provisioner' && !target.managedProvisioner)
    throw new HostedDeployError(`${environment} has no managed provisioner.`);
  const paths = pathsFor(target);
  mkdirSync(paths.directory, { recursive: true });
  targetVars(target, paths.vars);
  const selectedFlags = checkedFlags(command, subcommand, flags, environment);
  let backendSecrets;
  const needsBackendSecrets =
    ['provision', 'migrate', 'apply', 'secrets'].includes(command) ||
    (command === 'provisioner' && ['apply', 'secrets'].includes(subcommand));
  if (needsBackendSecrets && command !== 'provisioner') {
    backendSecrets = readBackendSecrets(target, environment);
    if (environment === 'production') assertProductionSecretsAreFresh(manifest, backendSecrets);
    if (
      target.managedProvisioner &&
      !target.secrets.backendEnvFile &&
      target.secrets.backendEnv !== 'process' &&
      backendSecrets.MANAGED_PROVISIONER_TOKEN !== readProvisionerToken(target, environment)
    )
      throw new HostedDeployError('Backend and provisioner production tokens must match.');
  }
  let provisionerToken;
  if (command === 'provisioner' && subcommand === 'secrets') {
    if (target.secrets.backendEnvFile || target.secrets.backendEnv === 'process') {
      backendSecrets = readBackendSecrets(target, environment);
      if (environment === 'production') assertProductionSecretsAreFresh(manifest, backendSecrets);
      provisionerToken = backendSecrets.MANAGED_PROVISIONER_TOKEN;
    } else provisionerToken = readProvisionerToken(target, environment);
  }
  if (
    command === 'provision' ||
    command === 'apply' ||
    command === 'migrate' ||
    command === 'remove' ||
    command === 'secrets'
  ) {
    const generatedConfig = validateGeneratedConfig(
      paths.config,
      { ...target, _stagingDatabaseId: manifest.environments.staging.databaseId },
      environment,
      command !== 'remove' && command !== 'provision',
      pathsFor(manifest.environments.staging).config,
    );
    if (command !== 'remove') validateCheckoutSecrets(generatedConfig, backendSecrets, environment);
  }
  if (command === 'provisioner' && ['apply', 'remove', 'secrets'].includes(subcommand)) {
    let config;
    try {
      config = JSON.parse(readFileSync(paths.provisioner, 'utf8'));
    } catch {
      throw new HostedDeployError(
        `${environment} provisioner config is missing; run provisioner plan first.`,
      );
    }
    if (
      config.name !== target.provisionerName ||
      config.account_id !== target.accountId ||
      config.vars?.ALLOW_UNAUTHENTICATED !== 'false'
    )
      throw new HostedDeployError(
        `${environment} provisioner config does not match the selected target or auth guard.`,
      );
  }
  if (command === 'plan') selectedFlags.push('--write');
  if (command === 'provisioner' && subcommand === 'plan') selectedFlags.push('--write');
  let status;
  if (command === 'secrets') {
    status = withSecretFiles({ backendSecrets }, (secretFiles) =>
      executeCommand(
        cliArgs(command, subcommand, target, paths, selectedFlags, secretFiles),
        environment,
      ),
    );
  } else if (command === 'provisioner' && subcommand === 'secrets') {
    status = withSecretFiles({ provisionerToken }, (secretFiles) =>
      executeCommand(
        cliArgs(command, subcommand, target, paths, selectedFlags, secretFiles),
        environment,
      ),
    );
  } else {
    status = executeCommand(
      cliArgs(command, subcommand, target, paths, selectedFlags),
      environment,
    );
  }
  if (status !== 0) return status;
  if (command === 'plan')
    validateGeneratedConfig(
      paths.config,
      { ...target, _stagingDatabaseId: manifest.environments.staging.databaseId },
      environment,
      false,
      pathsFor(manifest.environments.staging).config,
    );
  if (command === 'provision') {
    const generatedConfig = validateGeneratedConfig(
      paths.config,
      { ...target, _stagingDatabaseId: manifest.environments.staging.databaseId },
      environment,
      true,
      pathsFor(manifest.environments.staging).config,
    );
    validateCheckoutSecrets(generatedConfig, backendSecrets, environment);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `hosted-deploy: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
