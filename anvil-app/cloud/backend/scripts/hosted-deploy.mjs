#!/usr/bin/env node
/** Select and validate a hosted target before invoking the Anvil Cloud CLI. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const BACKEND_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_MANIFEST = join(BACKEND_DIR, '.wrangler', 'hosted-targets.json');
const WORKOS_ISSUER = 'https://api.workos.com/user_management';
const SECRET_NAMES = new Set([
  'HOSTED_SERVICE_KEYS',
  'MANAGED_PROVISIONER_TOKEN',
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
  if (!target.secrets?.backendFile)
    throw new HostedDeployError(`${environment}.secrets.backendFile is required.`);
  if (target.managedProvisioner && !target.secrets.provisionerTokenFile)
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

function resolveSecretPath(path) {
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
    ANVIL_DEPLOYMENT_ID: target.deploymentId,
    ANVIL_DEPLOYMENT_NAME: target.deploymentName,
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

function validateGeneratedConfig(path, target, environment, requireD1 = false) {
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

function readBackendSecrets(target, environment) {
  let secrets;
  try {
    secrets = JSON.parse(readFileSync(resolveSecretPath(target.secrets.backendFile), 'utf8'));
  } catch {
    throw new HostedDeployError(`${environment} backend secret file is missing or invalid JSON.`);
  }
  if (
    !secrets ||
    typeof secrets !== 'object' ||
    Array.isArray(secrets) ||
    Object.keys(secrets).some(
      (name) => !SECRET_NAMES.has(name) || typeof secrets[name] !== 'string' || !secrets[name],
    )
  ) {
    throw new HostedDeployError(`${environment} backend secret file has an invalid shape.`);
  }
  if (typeof secrets.HOSTED_SERVICE_KEYS !== 'string' || secrets.HOSTED_SERVICE_KEYS.length < 32)
    throw new HostedDeployError(
      `${environment} requires a fresh HOSTED_SERVICE_KEYS secret of at least 32 characters.`,
    );
  let serviceKeys;
  try {
    serviceKeys = JSON.parse(secrets.HOSTED_SERVICE_KEYS);
  } catch {
    throw new HostedDeployError(`${environment} HOSTED_SERVICE_KEYS must be a JSON object.`);
  }
  if (
    !serviceKeys ||
    typeof serviceKeys !== 'object' ||
    Array.isArray(serviceKeys) ||
    Object.keys(serviceKeys).length === 0 ||
    Object.entries(serviceKeys).some(
      ([key, value]) =>
        !/^[A-Za-z0-9_-]{1,64}$/.test(key) || typeof value !== 'string' || value.length < 32,
    )
  ) {
    throw new HostedDeployError(
      `${environment} HOSTED_SERVICE_KEYS must map key ids to secrets of at least 32 characters.`,
    );
  }
  if (Boolean(secrets.STRIPE_SECRET_KEY) !== Boolean(secrets.STRIPE_WEBHOOK_SECRET))
    throw new HostedDeployError(`${environment} Stripe secrets must be configured together.`);
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

function readProvisionerToken(target, environment) {
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

function assertProductionSecretsAreFresh(manifest, secrets) {
  const staging = manifest.environments.staging;
  if (staging.secrets?.backendFile) {
    const stagingPath = resolveSecretPath(staging.secrets.backendFile);
    if (existsSync(stagingPath)) {
      const stagingSecrets = readBackendSecrets(staging, 'staging');
      for (const [name, value] of Object.entries(secrets)) {
        if (name !== 'HOSTED_SERVICE_KEYS' && value === stagingSecrets[name])
          throw new HostedDeployError(`Production secret ${name} reuses staging.`);
      }
      const stageKeys = JSON.parse(stagingSecrets.HOSTED_SERVICE_KEYS);
      const prodKeys = JSON.parse(secrets.HOSTED_SERVICE_KEYS);
      if (Object.values(prodKeys).some((value) => Object.values(stageKeys).includes(value)))
        throw new HostedDeployError('Production HOSTED_SERVICE_KEYS reuses staging.');
    }
  }
  if (secrets.MANAGED_PROVISIONER_TOKEN && staging.secrets?.provisionerTokenFile) {
    const path = resolveSecretPath(staging.secrets.provisionerTokenFile);
    if (existsSync(path) && readFileSync(path, 'utf8').trim() === secrets.MANAGED_PROVISIONER_TOKEN)
      throw new HostedDeployError('Production provisioner token reuses staging.');
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

export function cliArgs(command, subcommand, target, paths, flags) {
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
        ? ['--from-file', resolveSecretPath(target.secrets.provisionerTokenFile)]
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
      ? ['--from-file', resolveSecretPath(target.secrets.backendFile)]
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
  const needsProductionSecrets =
    ['provision', 'migrate', 'apply', 'secrets'].includes(command) ||
    (command === 'provisioner' && ['apply', 'secrets'].includes(subcommand));
  if (environment === 'production' && needsProductionSecrets) {
    backendSecrets = readBackendSecrets(target, environment);
    assertProductionSecretsAreFresh(manifest, backendSecrets);
    if (
      target.managedProvisioner &&
      backendSecrets.MANAGED_PROVISIONER_TOKEN !== readProvisionerToken(target, environment)
    )
      throw new HostedDeployError('Backend and provisioner production tokens must match.');
  }
  if (command === 'secrets' && !backendSecrets) {
    backendSecrets = readBackendSecrets(target, environment);
    if (environment === 'production') assertProductionSecretsAreFresh(manifest, backendSecrets);
  }
  if (command === 'provisioner' && subcommand === 'secrets')
    readProvisionerToken(target, environment);
  if (
    command === 'apply' ||
    command === 'migrate' ||
    command === 'remove' ||
    command === 'secrets'
  ) {
    validateGeneratedConfig(
      paths.config,
      { ...target, _stagingDatabaseId: manifest.environments.staging.databaseId },
      environment,
      command !== 'remove',
    );
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
  const status = executeCommand(
    cliArgs(command, subcommand, target, paths, selectedFlags),
    environment,
  );
  if (status !== 0) return status;
  if (command === 'plan')
    validateGeneratedConfig(
      paths.config,
      { ...target, _stagingDatabaseId: manifest.environments.staging.databaseId },
      environment,
    );
  if (command === 'provision')
    validateGeneratedConfig(
      paths.config,
      { ...target, _stagingDatabaseId: manifest.environments.staging.databaseId },
      environment,
      true,
    );
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
