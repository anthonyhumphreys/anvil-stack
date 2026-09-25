import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BACKEND_DIR,
  HostedDeployError,
  checkedFlags,
  cliArgs,
  mergeTargetVars,
  run,
  validateManifest,
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
  assert.throws(
    () => mergeTargetVars({ ANVIL_DEV_SPIKE: 'true' }, staging),
    /invalid or secret Worker var/,
  );
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
