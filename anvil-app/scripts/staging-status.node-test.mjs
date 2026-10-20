import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateRelation,
  parseArguments,
  summarizeCheckoutCandidate,
  summarizeRemoteCandidate,
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

test('a modified checkout is reported separately from its commit SHA', () => {
  const candidate = summarizeCheckoutCandidate({
    branch: 'develop',
    headSha: currentSha,
    dirty: true,
  });
  assert.deepEqual(candidate, {
    source: 'checkout',
    ref: 'develop',
    headSha: currentSha,
    modified: true,
    localCheckoutRelation: 'current',
  });

  const previewCandidate = summarizeRemoteCandidate('pull-request', '#91', oldSha, {
    headSha: currentSha,
    dirty: true,
  });
  assert.deepEqual(previewCandidate, {
    source: 'pull-request',
    ref: '#91',
    headSha: oldSha,
    modified: false,
    localCheckoutRelation: 'different',
  });
});

test('candidate selection accepts an explicit PR or remote ref and rejects ambiguous input', () => {
  assert.deepEqual(parseArguments([]), {
    json: false,
    help: false,
    pullRequestNumber: null,
    ref: null,
  });
  assert.deepEqual(parseArguments(['--pr', '91', '--json']), {
    json: true,
    help: false,
    pullRequestNumber: 91,
    ref: null,
  });
  assert.deepEqual(parseArguments(['--ref', 'feature/sync-mesh']), {
    json: false,
    help: false,
    pullRequestNumber: null,
    ref: 'feature/sync-mesh',
  });
  assert.throws(() => parseArguments(['--pr', '91', '--ref', 'develop']));
  assert.throws(() => parseArguments(['--pr', '0']));
  assert.throws(() => parseArguments(['--ref', '--json']));
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

test('the public descriptor must match protocol, WorkOS target and disabled legacy auth', () => {
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
    authModes: ['workos-device', 'enrollment-code'],
    auth: { issuer: 'https://issuer.stale', publicClientId: 'client_stale' },
  };
  assert.deepEqual(validatePublicDescriptor(mismatchedDescriptor, target), {
    state: 'failed',
    missing: [
      'profile mesh/2',
      'legacy enrollment auth disabled',
      'WorkOS issuer target',
      'WorkOS desktop client target',
    ],
  });
});
