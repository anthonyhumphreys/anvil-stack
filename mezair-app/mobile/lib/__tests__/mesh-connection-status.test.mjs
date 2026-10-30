import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meshPathLabel } from '../mesh-connection-status.ts';

test('connection details distinguish host LAN hints from verified physical locality', () => {
  assert.equal(
    meshPathLabel({ state: 'live', path: 'direct', lanAddress: true }),
    'Direct · host LAN address',
  );
  assert.equal(
    meshPathLabel({ state: 'live', path: 'private-network', lanAddress: false }),
    'Private Network',
  );
  assert.equal(
    meshPathLabel({ state: 'live', path: 'managed', lanAddress: false }),
    'Managed Tunnel',
  );
  assert.equal(
    meshPathLabel({ state: 'authorization-unavailable', path: null, lanAddress: false }),
    'Authorization unavailable',
  );
});
