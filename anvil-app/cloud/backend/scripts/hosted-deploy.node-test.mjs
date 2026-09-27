import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BACKEND_DIR,
  HostedDeployError,
  assertProductionSecretsAreFresh,
  checkedFlags,
  cliArgs,
  mergeTargetVars,
  run,
  validateBackendSecrets,
  validateCheckoutSecrets,
  validateGeneratedConfig,
  validateManifest,
  validateStripeSecretMode,
} from './hosted-deploy.mjs';

const manifest = JSON.parse(
  readFileSync(new URL('../hosted-targets.example.json', import.meta.url), 'utf8'),
);
const staging = manifest.environments.staging;
const paths = {
  config: '/tmp/staging/wrangler.jsonc',
  vars: '/tmp/staging/vars.json',
  connection: '/tmp/staging/connection.json',
  provisioner: '/tmp/staging/provisioner.jsonc',
};

test('the checked-in target example keeps current resources assigned to staging', () => {
  const selected = validateManifest(manifest, 'staging');
  assert.equal(selected.workerName, 'anvil-sync-hosted-staging');
  assert.equal(selected.databaseId, '9d396edc-2967-4d94-9ca0-51311c2c4f13');
  assert.equal(selected.workos.hostedClientId, 'client_01M27GDYFBX70F16V6ZQ74KSDE');
});

test('production is blocked until its independent Cloudflare and WorkOS target is configured', () => {
  assert.throws(() => validateManifest(manifest, 'production'), /production\.accountId/);
});

test('production rejects staging resource and either staging WorkOS client reuse', () => {
  const production = {
    ...staging,
    stage: 'production',
    workerName: 'anvil-sync-production',
    baseUrl: 'https://anvil-sync-production.example.workers.dev',
    artifactsBucket: 'anvil-sync-production-artifacts',
    databaseName: 'anvil-sync-production-billing',
    databaseId: null,
    deploymentId: 'anvil-backend-production',
    deploymentName: 'Anvil hosted production',
    provisionerName: 'anvil-sync-production-provisioner',
    workos: {
      ...staging.workos,
      desktopClientId: 'client_other_desktop',
      hostedClientId: 'client_other_hosted',
    },
  };
  const configured = { ...manifest, environments: { ...manifest.environments, production } };
  assert.equal(validateManifest(configured, 'production').workerName, production.workerName);

  for (const [field, stagingName] of [
    ['workerName', staging.provisionerName],
    ['provisionerName', staging.workerName],
  ]) {
    assert.throws(
      () =>
        validateManifest(
          {
            ...configured,
            environments: {
              ...configured.environments,
              production: { ...production, [field]: stagingName },
            },
          },
          'production',
        ),
      /must not reuse either staging Worker/,
    );
  }

  configured.environments.production.workos.desktopClientId = staging.workos.hostedClientId;
  assert.throws(
    () => validateManifest(configured, 'production'),
    /desktopClientId must use the production WorkOS application/,
  );

  configured.environments.production.workos.desktopClientId = 'client_other_desktop';
  configured.environments.production.artifactsBucket = staging.artifactsBucket;
  assert.throws(
    () => validateManifest(configured, 'production'),
    /artifactsBucket must be separate/,
  );
});

test('target vars retain optional settings but lock deployment and WorkOS identity', () => {
  const vars = mergeTargetVars(
    {
      HOSTED_CHECKOUT_ENABLED: 'true',
      HOSTED_SYNC_LIMITS: '{"jobs":10}',
      OIDC_CLIENT_ID: 'client_stale',
    },
    staging,
  );
  assert.equal(vars.HOSTED_CHECKOUT_ENABLED, 'true');
  assert.equal(vars.HOSTED_SYNC_LIMITS, '{"jobs":10}');
  assert.equal(vars.OIDC_CLIENT_ID, staging.workos.desktopClientId);
  assert.equal(vars.ANVIL_DEPLOYMENT_ID, staging.deploymentId);
  assert.equal(vars.HOSTED_BILLING_ENVIRONMENT, 'staging');
  assert.throws(
    () => mergeTargetVars({ ANVIL_DEV_SPIKE: 'true' }, staging),
    /invalid or secret Worker var/,
  );
});

function hostedConfig(target, environment, extraVars = {}) {
  return {
    name: target.workerName,
    account_id: target.accountId,
    vars: {
      HOSTED_BILLING_ENFORCEMENT: 'true',
      HOSTED_BILLING_ENVIRONMENT: environment,
      ANVIL_DEPLOYMENT_ID: target.deploymentId,
      ANVIL_DEPLOYMENT_NAME: target.deploymentName,
      HOSTED_WORKOS_CLIENT_ID: target.workos.hostedClientId,
      OIDC_ISSUER: target.workos.issuer,
      OIDC_CLIENT_ID: target.workos.desktopClientId,
      ...extraVars,
    },
    r2_buckets: [{ binding: 'ARTIFACTS', bucket_name: target.artifactsBucket }],
    d1_databases: [
      {
        binding: 'HOSTED_DB',
        database_name: target.databaseName,
        database_id: target.databaseId ?? 'unprovisioned',
      },
    ],
    services: target.managedProvisioner
      ? [{ binding: 'MANAGED_PROVISIONER', service: target.provisionerName }]
      : [],
  };
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value));
}

test('generated config pins its WorkOS clients and billing environment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-config-test-'));
  const configPath = join(directory, 'staging.json');
  const valid = hostedConfig(staging, 'staging');
  try {
    writeJson(configPath, valid);
    assert.equal(validateGeneratedConfig(configPath, staging, 'staging').name, staging.workerName);

    writeJson(configPath, hostedConfig(staging, 'production'));
    assert.throws(
      () => validateGeneratedConfig(configPath, staging, 'staging'),
      /wrong HOSTED_BILLING_ENVIRONMENT/,
    );

    writeJson(configPath, {
      ...valid,
      vars: { ...valid.vars, OIDC_CLIENT_ID: 'client_wrong_environment' },
    });
    assert.throws(
      () => validateGeneratedConfig(configPath, staging, 'staging'),
      /OIDC_CLIENT_ID does not match the selected target/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migration admission IDs are strict, bounded, and unique per environment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-config-test-'));
  const configPath = join(directory, 'staging.json');
  try {
    writeJson(
      configPath,
      hostedConfig(staging, 'staging', {
        HOSTED_ADMITTED_WORKOS_USER_IDS: '["user_existingA","user_existingB"]',
      }),
    );
    assert.equal(validateGeneratedConfig(configPath, staging, 'staging').name, staging.workerName);

    for (const value of ['not-json', '["alice@example.com"]', '["user_same","user_same"]']) {
      writeJson(
        configPath,
        hostedConfig(staging, 'staging', { HOSTED_ADMITTED_WORKOS_USER_IDS: value }),
      );
      assert.throws(
        () => validateGeneratedConfig(configPath, staging, 'staging'),
        /HOSTED_ADMITTED_WORKOS_USER_IDS/,
      );
    }

    writeJson(
      configPath,
      hostedConfig(staging, 'staging', {
        HOSTED_ADMITTED_WORKOS_USER_IDS: JSON.stringify(
          Array.from({ length: 1001 }, (_, index) => `user_migration${index}`),
        ),
      }),
    );
    assert.throws(
      () => validateGeneratedConfig(configPath, staging, 'staging'),
      /at most 1,000 unique WorkOS user IDs/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('generated production config rejects the staging-only early checkout flag', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-config-test-'));
  const production = {
    ...staging,
    stage: 'production',
    workerName: 'anvil-sync-hosted-production',
    baseUrl: 'https://anvil-sync-hosted-production.example.workers.dev',
    artifactsBucket: 'anvil-sync-hosted-production-artifacts',
    databaseName: 'anvil-sync-hosted-production-billing',
    databaseId: '7b42c49a-c234-496f-9241-5f3912d80037',
    deploymentId: 'anvil-backend-production',
    deploymentName: 'Anvil hosted production',
    provisionerName: 'anvil-sync-hosted-production-provisioner',
    workos: {
      ...staging.workos,
      desktopClientId: 'client_prod_desktop',
      hostedClientId: 'client_prod_site',
    },
  };
  const configPath = join(directory, 'production.json');
  try {
    writeJson(
      configPath,
      hostedConfig(production, 'production', { HOSTED_ALLOW_EARLY_CHECKOUT: 'true' }),
    );
    assert.throws(
      () => validateGeneratedConfig(configPath, production, 'production'),
      /must not set HOSTED_ALLOW_EARLY_CHECKOUT/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production checkout requires four distinct prices and rejects staging Price reuse', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-config-test-'));
  const production = {
    ...staging,
    stage: 'production',
    workerName: 'anvil-sync-hosted-production',
    baseUrl: 'https://anvil-sync-hosted-production.example.workers.dev',
    artifactsBucket: 'anvil-sync-hosted-production-artifacts',
    databaseName: 'anvil-sync-hosted-production-billing',
    databaseId: '7b42c49a-c234-496f-9241-5f3912d80037',
    deploymentId: 'anvil-backend-production',
    deploymentName: 'Anvil hosted production',
    provisionerName: 'anvil-sync-hosted-production-provisioner',
    workos: {
      ...staging.workos,
      desktopClientId: 'client_prod_desktop',
      hostedClientId: 'client_prod_site',
    },
  };
  const stagePath = join(directory, 'staging.json');
  const productionPath = join(directory, 'production.json');
  const stagePrices = {
    STRIPE_PRICE_SYNC_MONTHLY: 'price_stagepersonalmonth',
    STRIPE_PRICE_SYNC_ANNUAL: 'price_stagepersonalyear',
    STRIPE_PRICE_TEAM_MONTHLY: 'price_stageteammonth',
    STRIPE_PRICE_TEAM_ANNUAL: 'price_stageteamyear',
  };
  const prodPrices = {
    STRIPE_PRICE_SYNC_MONTHLY: 'price_prodpersonalmonth',
    STRIPE_PRICE_SYNC_ANNUAL: 'price_prodpersonalyear',
    STRIPE_PRICE_TEAM_MONTHLY: 'price_prodteammonth',
    STRIPE_PRICE_TEAM_ANNUAL: 'price_prodteamyear',
  };
  try {
    writeJson(
      stagePath,
      hostedConfig(staging, 'staging', { HOSTED_CHECKOUT_ENABLED: 'true', ...stagePrices }),
    );
    writeJson(
      productionPath,
      hostedConfig(production, 'production', { HOSTED_CHECKOUT_ENABLED: 'true', ...prodPrices }),
    );
    assert.equal(
      validateGeneratedConfig(productionPath, production, 'production', false, stagePath).name,
      production.workerName,
    );

    writeJson(
      productionPath,
      hostedConfig(production, 'production', {
        HOSTED_CHECKOUT_ENABLED: 'true',
        ...prodPrices,
        STRIPE_PRICE_TEAM_ANNUAL: stagePrices.STRIPE_PRICE_SYNC_MONTHLY,
      }),
    );
    assert.throws(
      () => validateGeneratedConfig(productionPath, production, 'production', false, stagePath),
      /reuses a staging Stripe Price id/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production migration list cannot reuse staging WorkOS user IDs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-config-test-'));
  const production = {
    ...staging,
    stage: 'production',
    workerName: 'anvil-sync-hosted-production',
    baseUrl: 'https://anvil-sync-hosted-production.example.workers.dev',
    artifactsBucket: 'anvil-sync-hosted-production-artifacts',
    databaseName: 'anvil-sync-hosted-production-billing',
    databaseId: '7b42c49a-c234-496f-9241-5f3912d80037',
    deploymentId: 'anvil-backend-production',
    deploymentName: 'Anvil hosted production',
    provisionerName: 'anvil-sync-hosted-production-provisioner',
    workos: {
      ...staging.workos,
      desktopClientId: 'client_prod_desktop',
      hostedClientId: 'client_prod_site',
    },
  };
  const stagePath = join(directory, 'staging.json');
  const productionPath = join(directory, 'production.json');
  try {
    writeJson(
      stagePath,
      hostedConfig(staging, 'staging', {
        HOSTED_ADMITTED_WORKOS_USER_IDS: '["user_stage_only"]',
      }),
    );
    writeJson(
      productionPath,
      hostedConfig(production, 'production', {
        HOSTED_ADMITTED_WORKOS_USER_IDS: '["user_prod_only"]',
      }),
    );
    assert.equal(
      validateGeneratedConfig(productionPath, production, 'production', false, stagePath).name,
      production.workerName,
    );

    writeJson(
      productionPath,
      hostedConfig(production, 'production', {
        HOSTED_ADMITTED_WORKOS_USER_IDS: '["user_stage_only"]',
      }),
    );
    assert.throws(
      () => validateGeneratedConfig(productionPath, production, 'production', false, stagePath),
      /must not reuse Staging WorkOS user IDs/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('backend secrets keep WorkOS and Stripe environment credentials correctly scoped', () => {
  const shared = {
    HOSTED_SERVICE_KEYS: JSON.stringify({ website: 'w'.repeat(40) }),
    WORKOS_API_KEY: 'sk_test_workos_staging',
    WORKOS_WEBHOOK_SECRET: 'WorkOSDashboardSecret12345',
    MANAGED_PROVISIONER_TOKEN: 'p'.repeat(40),
  };
  validateBackendSecrets(shared, staging, 'staging');
  validateBackendSecrets(
    {
      ...shared,
      HOSTED_OPERATOR_KEYS: JSON.stringify({ operator: 'o'.repeat(40) }),
    },
    staging,
    'staging',
  );
  assert.throws(
    () =>
      validateBackendSecrets(
        {
          ...shared,
          HOSTED_OPERATOR_KEYS: JSON.stringify({ operator: 'w'.repeat(40) }),
        },
        staging,
        'staging',
      ),
    /must not reuse a HOSTED_SERVICE_KEYS secret/,
  );
  validateCheckoutSecrets(
    { vars: { HOSTED_CHECKOUT_ENABLED: 'true' } },
    { STRIPE_SECRET_KEY: 'sk_test_staging', STRIPE_WEBHOOK_SECRET: 'whsec_staging' },
    'staging',
  );
  assert.throws(
    () => validateCheckoutSecrets({ vars: { HOSTED_CHECKOUT_ENABLED: 'true' } }, shared, 'staging'),
    /Stripe API and webhook secrets are missing/,
  );
  validateCheckoutSecrets({ vars: { HOSTED_CHECKOUT_ENABLED: 'false' } }, shared, 'staging');
  validateStripeSecretMode('sk_test_staging', 'staging');
  validateStripeSecretMode('sk_live_production', 'production');
  assert.throws(() => validateStripeSecretMode('sk_live_wrong', 'staging'), /test Stripe mode/);
  assert.throws(() => validateStripeSecretMode('sk_test_wrong', 'production'), /live Stripe mode/);
  assert.throws(
    () =>
      validateBackendSecrets(
        { ...shared, STRIPE_SECRET_KEY: 'sk_live_wrong', STRIPE_WEBHOOK_SECRET: 'whsec_test' },
        staging,
        'staging',
      ),
    /test Stripe mode/,
  );
  assert.throws(
    () => validateBackendSecrets({ ...shared, WORKOS_API_KEY: '' }, staging, 'staging'),
    /WORKOS_API_KEY/,
  );
  assert.throws(
    () =>
      validateBackendSecrets({ ...shared, WORKOS_WEBHOOK_SECRET: 'invalid' }, staging, 'staging'),
    /WORKOS_WEBHOOK_SECRET/,
  );
});

test('production requires staging secrets and rejects keys shared across HMAC audiences', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-secrets-test-'));
  const stagingSecretPath = join(directory, 'staging-secrets.json');
  const stageSiteKey = 's'.repeat(48);
  const stageOperatorKey = 'o'.repeat(48);
  const stageSecrets = {
    HOSTED_SERVICE_KEYS: JSON.stringify({ website: stageSiteKey }),
    HOSTED_OPERATOR_KEYS: JSON.stringify({ operator: stageOperatorKey }),
    WORKOS_API_KEY: 'sk_workos_staging_unique',
    WORKOS_WEBHOOK_SECRET: 'whsec_staging_unique',
    MANAGED_PROVISIONER_TOKEN: 'p'.repeat(48),
  };
  const productionSecrets = {
    HOSTED_SERVICE_KEYS: JSON.stringify({ website: 'x'.repeat(48) }),
    HOSTED_OPERATOR_KEYS: JSON.stringify({ operator: 'y'.repeat(48) }),
    WORKOS_API_KEY: 'sk_workos_production_unique',
    WORKOS_WEBHOOK_SECRET: 'whsec_production_unique',
    MANAGED_PROVISIONER_TOKEN: 'q'.repeat(48),
  };
  const targetManifest = {
    ...manifest,
    environments: {
      ...manifest.environments,
      staging: {
        ...staging,
        secrets: { ...staging.secrets, backendFile: stagingSecretPath },
      },
    },
  };
  try {
    assert.throws(
      () => assertProductionSecretsAreFresh(targetManifest, productionSecrets),
      /requires the Staging backend secret file/,
    );
    writeJson(stagingSecretPath, stageSecrets);
    assert.doesNotThrow(() => assertProductionSecretsAreFresh(targetManifest, productionSecrets));

    assert.throws(
      () =>
        assertProductionSecretsAreFresh(targetManifest, {
          ...productionSecrets,
          HOSTED_OPERATOR_KEYS: JSON.stringify({ operator: stageSiteKey }),
        }),
      /must not reuse keys from either staging audience/,
    );
    assert.throws(
      () =>
        assertProductionSecretsAreFresh(targetManifest, {
          ...productionSecrets,
          WORKOS_API_KEY: stageSecrets.WORKOS_API_KEY,
        }),
      /Production secret WORKOS_API_KEY reuses staging/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('target command construction pins all resource and generated-config inputs', () => {
  const args = cliArgs('plan', undefined, staging, paths, ['--json', '--write']);
  assert.deepEqual(args.slice(0, 4), ['mesh', 'plan', '--backend', BACKEND_DIR]);
  assert.ok(args.includes('--stage') && args.includes('staging'));
  assert.ok(args.includes('--name') && args.includes(staging.workerName));
  assert.ok(args.includes('--bucket') && args.includes(staging.artifactsBucket));
  assert.ok(args.includes('--database') && args.includes(staging.databaseName));
  assert.ok(args.includes('--config-out') && args.includes(paths.config));
  assert.ok(args.includes('--managed-provisioner') && args.includes(staging.provisionerName));
  assert.ok(!args.includes('--production'));
});

test('arbitrary resource overrides and production test-deployment are rejected', () => {
  assert.throws(
    () => checkedFlags('apply', undefined, ['--bucket', 'wrong'], 'staging'),
    HostedDeployError,
  );
  assert.throws(
    () => checkedFlags('apply', undefined, ['--test-deployment'], 'production'),
    /forbidden for production/,
  );
});

test('a complete production target invokes only the explicitly selected CLI plan', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const workerName = `anvil-sync-hosted-prod-test-${suffix}`;
  const production = {
    ...staging,
    stage: 'production',
    workerName,
    baseUrl: `https://${workerName}.example.workers.dev`,
    artifactsBucket: `${workerName}-artifacts`,
    databaseName: `${workerName}-billing`,
    databaseId: null,
    deploymentId: 'anvil-backend-production-test',
    deploymentName: 'Anvil hosted production test',
    provisionerName: `${workerName}-provisioner`,
    workos: {
      ...staging.workos,
      desktopClientId: 'client_prod_desktop',
      hostedClientId: 'client_prod_website',
    },
  };
  const fullManifest = { ...manifest, environments: { ...manifest.environments, production } };
  const directory = mkdtempSync(join(tmpdir(), 'hosted-target-test-'));
  const manifestPath = join(directory, 'targets.json');
  const outputDir = join(BACKEND_DIR, '.wrangler', 'mesh', production.workerName);
  const previousDeploymentEnv = process.env.ANVIL_DEPLOYMENT_ENV;
  delete process.env.ANVIL_DEPLOYMENT_ENV;
  writeFileSync(manifestPath, JSON.stringify(fullManifest));
  try {
    let invocation;
    const status = run(
      ['--environment', 'production', '--manifest', manifestPath, 'plan', '--json'],
      (args, environment) => {
        invocation = { args, environment };
        return 23;
      },
    );
    assert.equal(status, 23);
    assert.equal(invocation.environment, 'production');
    assert.ok(invocation.args.includes(production.workerName));
    assert.ok(invocation.args.includes(production.artifactsBucket));
    assert.ok(invocation.args.includes(production.databaseName));
    assert.ok(invocation.args.includes('production'));
  } finally {
    if (previousDeploymentEnv === undefined) delete process.env.ANVIL_DEPLOYMENT_ENV;
    else process.env.ANVIL_DEPLOYMENT_ENV = previousDeploymentEnv;
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
