import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateRelation,
  inspectWorkerFlags,
  inspectManagedDomain,
  summarizeChecks,
  summarizeWorkflowRun,
  validatePublicDescriptor,
} from './staging-status.mjs';

const currentSha = 'a'.repeat(40);
const oldSha = 'b'.repeat(40);

test('candidate relation distinguishes the current PR head from an older checkout', () => {
  assert.equal(candidateRelation(currentSha, currentSha), 'current');
  assert.equal(candidateRelation(oldSha, currentSha), 'different');
  assert.equal(candidateRelation(null, currentSha), 'unknown');
});

test('PR checks fail closed for failures, pending checks, and empty results', () => {
  assert.equal(summarizeChecks([{ bucket: 'fail' }]).state, 'failed');
  assert.equal(summarizeChecks([{ bucket: 'pending' }]).state, 'pending');
  assert.equal(summarizeChecks([{ bucket: 'skipping' }]).state, 'blocked');
  assert.equal(summarizeChecks([], true).state, 'blocked');
  assert.equal(summarizeChecks(null, false).state, 'blocked');
});

test('staging worker flags expose only whether each safe expected value matches', () => {
  const expectedStagingFlags = {
    HOSTED_CHECKOUT_ENABLED: 'false',
    ANVIL_CLOUD_AGENTS_ENABLED: 'false',
    ANVIL_MESH_MANAGED_ENDPOINTS: 'true',
  };
  assert.deepEqual(
    inspectWorkerFlags(expectedStagingFlags).map(({ state }) => state),
    ['match', 'match', 'match'],
  );

  const mismatch = inspectWorkerFlags({
    ...expectedStagingFlags,
    ANVIL_CLOUD_AGENTS_ENABLED: 'true',
  }).find(({ name }) => name === 'ANVIL_CLOUD_AGENTS_ENABLED');
  assert.deepEqual(mismatch, {
    name: 'ANVIL_CLOUD_AGENTS_ENABLED',
    expected: 'false',
    state: 'mismatch',
  });
});

test('managed staging reports missing, invalid and valid domains without exposing configuration', () => {
  assert.deepEqual(inspectManagedDomain({}), { state: 'missing' });
  assert.deepEqual(inspectManagedDomain({ MACHINE_ENDPOINT_DOMAIN: 'https://evil.test/path' }), {
    state: 'failed',
  });
  assert.deepEqual(
    inspectManagedDomain({ MACHINE_ENDPOINT_DOMAIN: 'anvilstack.dev', secret: 'never-display' }),
    { state: 'passed' },
  );
  const disabled = inspectWorkerFlags({ ANVIL_MESH_MANAGED_ENDPOINTS: 'false' });
  assert.equal(
    disabled.find(({ name }) => name === 'ANVIL_MESH_MANAGED_ENDPOINTS').state,
    'mismatch',
  );
});

test('a workflow run only identifies the current candidate when its head matches', () => {
  const currentRun = summarizeWorkflowRun(
    { headSha: currentSha, status: 'completed', conclusion: 'success', databaseId: 42 },
    currentSha,
  );
  const oldRun = summarizeWorkflowRun(
    { headSha: oldSha, status: 'completed', conclusion: 'success', databaseId: 41 },
    currentSha,
  );
  assert.deepEqual([currentRun.state, currentRun.relation], ['passed', 'current']);
  assert.deepEqual([oldRun.state, oldRun.relation], ['passed', 'different']);
});

test('the public descriptor must match both protocol profiles and the manifest WorkOS client', () => {
  const target = {
    desktopClientId: 'client_staging_desktop',
    issuer: 'https://api.workos.com/user_management',
  };
  const currentDescriptor = {
    descriptorVersion: 1,
    protocols: ['anvil-backend/1'],
    profiles: ['sync/2', 'mesh/2'],
    authModes: ['workos-device'],
    auth: { issuer: target.issuer, publicClientId: target.desktopClientId },
  };
  assert.deepEqual(validatePublicDescriptor(currentDescriptor, target), {
    state: 'passed',
    missing: [],
  });

  const mismatchedDescriptor = {
    ...currentDescriptor,
    profiles: ['sync/2'],
    auth: { issuer: 'https://issuer.stale', publicClientId: 'client_stale' },
  };
  assert.deepEqual(validatePublicDescriptor(mismatchedDescriptor, target), {
    state: 'failed',
    missing: ['profile mesh/2', 'WorkOS issuer target', 'WorkOS desktop client target'],
  });
});
