import assert from 'node:assert/strict';
import test from 'node:test';
import { stagingVars } from './staging-config.mjs';

const configured = { HOSTED_CHECKOUT_ENABLED: 'false' };

test('automatic staging pushes preserve an explicitly enabled managed rollout', () => {
  const input = {
    ...configured,
    MEZAIR_MESH_MANAGED_ENDPOINTS: 'true',
    MACHINE_ENDPOINT_DOMAIN: 'mezair.dev',
    MEZAIR_CLOUD_AGENTS_ENABLED: 'true',
    unrelated: 'preserved',
  };
  const vars = stagingVars(input);
  assert.equal(vars.MEZAIR_MESH_MANAGED_ENDPOINTS, 'true');
  assert.equal(vars.MEZAIR_CLOUD_AGENTS_ENABLED, 'false');
  assert.equal(vars.unrelated, 'preserved');
  assert.equal(input.MEZAIR_CLOUD_AGENTS_ENABLED, 'true');
});

test('default staging remains off and a manual pilot still opts in', () => {
  assert.equal(stagingVars(configured).MEZAIR_MESH_MANAGED_ENDPOINTS, 'false');
  assert.equal(
    stagingVars(
      {
        ...configured,
        MACHINE_ENDPOINT_DOMAIN: 'mezair.dev',
      },
      { managedEndpointPilot: true },
    ).MEZAIR_MESH_MANAGED_ENDPOINTS,
    'true',
  );
  assert.equal(
    stagingVars({
      ...configured,
      MEZAIR_MESH_MANAGED_ENDPOINTS: 'false',
    }).MEZAIR_MESH_MANAGED_ENDPOINTS,
    'false',
  );
});

test('an enabled rollout fails before deployment on invalid or missing configuration', () => {
  for (const domain of [undefined, 'https://mezair.dev', 'evil.test/path', 'a..test']) {
    assert.throws(
      () =>
        stagingVars({
          ...configured,
          MEZAIR_MESH_MANAGED_ENDPOINTS: 'true',
          MACHINE_ENDPOINT_DOMAIN: domain,
        }),
      /valid nonsecret MACHINE_ENDPOINT_DOMAIN/,
    );
  }
  assert.throws(
    () => stagingVars({ ...configured, MEZAIR_MESH_MANAGED_ENDPOINTS: true }),
    /string true or false/,
  );
  assert.throws(() => stagingVars({ HOSTED_CHECKOUT_ENABLED: 'true' }), /disabled checkout/);
  assert.throws(() => stagingVars([]), /must be an object/);
});
