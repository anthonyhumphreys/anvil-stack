import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FairUseCliError, parseArgs, run } from './hosted-fair-use.mjs';

const example = JSON.parse(
  readFileSync(new URL('../hosted-targets.example.json', import.meta.url), 'utf8'),
);

function fixture(t, operator = true) {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-fair-use-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const backendFile = join(directory, 'backend-secrets.json');
  const secrets = {
    HOSTED_SERVICE_KEYS: JSON.stringify({ website: 'w'.repeat(40) }),
    ...(operator ? { HOSTED_OPERATOR_KEYS: JSON.stringify({ ops: 'o'.repeat(40) }) } : {}),
  };
  writeFileSync(backendFile, JSON.stringify(secrets));
  const manifest = structuredClone(example);
  manifest.environments.staging.secrets.backendFile = backendFile;
  const manifestPath = join(directory, 'targets.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { directory, backendFile, manifestPath, secret: 'o'.repeat(40) };
}

function verifySignedRequest(url, init, secret, now) {
  const body = Buffer.from(init.body);
  const urlValue = new URL(url);
  const signatureInput = [
    'anvil-hosted/1',
    'anvil-hosted-operator',
    init.headers['x-anvil-key-id'],
    'POST',
    urlValue.pathname + urlValue.search,
    String(now),
    init.headers['x-anvil-request-id'],
    createHash('sha256').update(body).digest('hex'),
  ].join('\n');
  const expected = createHmac('sha256', secret).update(signatureInput).digest('hex');
  assert.equal(init.headers['x-anvil-timestamp'], String(now));
  assert.equal(init.headers['x-anvil-signature'], expected);
}

test('operator CLI signs a status request with the operator audience and selected staging origin', async (t) => {
  const fx = fixture(t);
  const now = Date.now();
  let request;
  const status = await run(
    [
      '--environment',
      'staging',
      '--manifest',
      fx.manifestPath,
      '--account',
      'sync-personal-1',
      '--action',
      'status',
    ],
    {
      now,
      requestId: 'request_id_1234567890',
      write: () => {},
      fetchFn: async (url, init) => {
        request = { url, init };
        return { ok: true, status: 200, text: async () => '{"status":"clear"}' };
      },
    },
  );
  assert.equal(status, 0);
  assert.equal(
    request.url.href,
    `${example.environments.staging.baseUrl}/internal/hosted/operator/fair-use`,
  );
  assert.deepEqual(JSON.parse(request.init.body), {
    accountId: 'sync-personal-1',
    action: 'status',
  });
  assert.equal(request.init.headers['x-anvil-key-id'], 'ops');
  verifySignedRequest(request.url, request.init, fx.secret, now);
});

test('operator CLI reads set details from a file and requires explicit emergency confirmation', async (t) => {
  const fx = fixture(t);
  const now = Date.now();
  const bodyFile = join(fx.directory, 'restriction.json');
  writeFileSync(
    bodyFile,
    JSON.stringify({
      code: 'storage-usage',
      message: 'Please reduce retained hosted data.',
      restrictAt: new Date(now + 8 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  );
  let body;
  await run(
    [
      '--environment',
      'staging',
      '--manifest',
      fx.manifestPath,
      '--account',
      'sync-personal-1',
      '--action',
      'set',
      '--body-file',
      bodyFile,
    ],
    {
      now,
      write: () => {},
      fetchFn: async (_url, init) => {
        body = JSON.parse(init.body);
        return { ok: true, status: 200, text: async () => '{"status":"notice"}' };
      },
    },
  );
  assert.equal(body.action, 'set');
  assert.equal(body.accountId, 'sync-personal-1');
  assert.equal(body.code, 'storage-usage');
  assert.equal(body.message, 'Please reduce retained hosted data.');

  writeFileSync(
    bodyFile,
    JSON.stringify({
      code: 'service-protection',
      message: 'Service protection is required.',
      restrictAt: new Date(now).toISOString(),
      emergency: true,
    }),
  );
  await assert.rejects(
    run(
      [
        '--environment',
        'staging',
        '--manifest',
        fx.manifestPath,
        '--account',
        'sync-personal-1',
        '--action',
        'set',
        '--body-file',
        bodyFile,
      ],
      { now, fetchFn: async () => assert.fail('request must not be sent'), write: () => {} },
    ),
    /--confirm-emergency/,
  );
});

test('operator CLI never falls back to website service keys', async (t) => {
  const fx = fixture(t, false);
  await assert.rejects(
    run(
      [
        '--environment',
        'staging',
        '--manifest',
        fx.manifestPath,
        '--account',
        'sync-personal-1',
        '--action',
        'status',
      ],
      { fetchFn: async () => assert.fail('request must not be sent'), write: () => {} },
    ),
    /HOSTED_OPERATOR_KEYS is not configured/,
  );
});

test('operator CLI rejects unsupported or invalid account and action options before fetch', () => {
  assert.throws(
    () => parseArgs(['--environment', 'production', '--account', 'x', '--action', 'status']),
    /--manifest must explicitly select/,
  );
  assert.throws(
    () =>
      parseArgs([
        '--environment',
        'production',
        '--manifest',
        'targets.json',
        '--account',
        'x',
        '--action',
        'other',
      ]),
    /must be status, set or clear/,
  );
  assert.throws(() => parseArgs(['--account', 'x', '--action', 'status']), FairUseCliError);
});
