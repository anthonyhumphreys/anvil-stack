import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { validateManifest } from '../../backend/scripts/hosted-deploy.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../backend/hosted-targets.ci.json', import.meta.url), 'utf8'));
const target = validateManifest(manifest, 'staging');
const origin = new URL(target.baseUrl);
assert.ok(origin.hostname.startsWith(`${target.workerName}.`));
assert.ok(origin.hostname.endsWith('.workers.dev'));
origin.hostname = `${target.provisionerName}.${origin.hostname.slice(target.workerName.length + 1)}`;
const token = process.env.MANAGED_PROVISIONER_TOKEN;
assert.ok(typeof token === 'string' && token.length >= 32, 'Missing provisioner token');

async function request(path, method = 'GET', authenticated = true, body = undefined) {
  return fetch(new URL(path, origin), {
    method,
    headers: {
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  });
}

const denied = await request('/v1/health', 'GET', false);
assert.equal(denied.status, 401, 'Provisioner must reject unauthenticated requests');
const health = await request('/v1/health');
assert.equal(health.status, 200, 'Authenticated provisioner health check failed');
assert.equal((await health.json()).ok, true);
console.log('Provisioner authentication passed.');

// listProcesses starts a real Sandbox container without enrolling an Anvil
// device or requiring user credentials. A fresh sandbox has no daemon process.
const id = `ci-smoke-${randomUUID()}`;
try {
  let started = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const status = await request(`/v1/environments/${id}`);
      if (status.status === 200) {
        assert.equal((await status.json()).status, 'unknown');
        started = true;
        break;
      }
    } catch (error) {
      // Only transient network failures are retried; bad response shapes fail.
      if (error instanceof assert.AssertionError) throw error;
    }
    if (attempt < 7) await setTimeout(15_000);
  }
  assert.ok(started, 'Sandbox container did not become ready');
  console.log('Sandbox container startup passed.');

  const suspended = await request(`/v1/environments/${id}/suspend`, 'POST');
  assert.equal(suspended.status, 200, 'Sandbox snapshot request failed');
  const parked = await request(`/v1/environments/${id}`);
  assert.equal(parked.status, 200);
  assert.equal((await parked.json()).status, 'suspended', 'Paused status check woke the snapshot');

  // A deliberately invalid loopback API and fake one-shot code prove the same
  // filesystem snapshot can boot again without touching a user's account.
  const restoredResponse = await request(`/v1/environments/${id}/boot`, 'POST', true, {
    bootstrap: {
      kind: 'anvil.mesh-environment',
      schemaVersion: '0.2',
      environmentId: id,
      provider: 'anvil-managed',
      backendUrl: 'http://127.0.0.1:9',
      enrollmentCode: 'anvil-ec-AAAAA-BBBBB-CCCCC-DDDDD',
      ttlSeconds: 300,
      resumeFromSnapshot: true,
    },
  });
  assert.ok(restoredResponse.status === 200 || restoredResponse.status === 201, 'Snapshot restore failed');
  const restored = await restoredResponse.json();
  assert.equal(restored.providerRef, id);
  assert.equal(typeof restored.processId, 'string');
  console.log('Sandbox snapshot, non-waking status check, and restore passed.');
} finally {
  const deleted = await request(`/v1/environments/${id}`, 'DELETE');
  assert.equal(deleted.status, 200, 'Sandbox cleanup failed');
  assert.equal((await deleted.json()).ok, true);
  console.log('Sandbox destroy request succeeded. Full enrolled-worker acceptance remains manual.');
}
