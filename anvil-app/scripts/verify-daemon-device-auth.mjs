#!/usr/bin/env node
// Cross-process-boundary check: actual device-flow client and Worker code,
// with WorkOS replaced by a deterministic in-memory authorization provider.
// No requests leave the test and no user credentials are needed.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// Use the same workerd/Miniflare version as the backend's installed Wrangler.
const requireWrangler = createRequire(
  require.resolve(join(appDir, 'cloud/backend/node_modules/wrangler/package.json')),
);
const { Miniflare, convertV4MiniflareOptions } = requireWrangler('miniflare');
const issuer = 'https://api.workos.com/user_management';
const clientId = 'client_device_auth_integration';
const origin = 'https://device-auth.anvil.test';
const providerAccessToken = 'provider-access-token-must-not-reach-client';
const providerRefreshToken = 'provider-refresh-token-must-not-reach-client';
const grants = new Map();
const authorizationCodes = new Map();
const subject = 'user_device_auth_integration';
let nextOutcomes = [];
let lastDeviceCode;
const privateCodes = [];
const publicChallenges = [];
const wireResponses = [];
const delays = [];
let clock = Date.now();

function providerResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function providerExchange(request) {
  assert.equal(request.url, issuer + '/authenticate');
  assert.equal(request.method, 'POST');
  const params = new URLSearchParams(await request.text());
  assert.equal(params.get('client_id'), clientId);
  assert.equal(params.has('client_secret'), false);
  if (params.get('grant_type') === 'authorization_code') {
    const code = params.get('code');
    const user = authorizationCodes.get(code);
    if (!user) return providerResponse({ error: 'invalid_grant' }, 400);
    authorizationCodes.delete(code);
    return providerResponse({ user: { id: user }, access_token: providerAccessToken });
  }
  assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  const code = params.get('device_code');
  const grant = grants.get(code);
  if (!grant) return providerResponse({ error: 'invalid_grant' }, 400);
  const outcome = grant.outcomes.shift();
  if (outcome) {
    if (outcome === 'access_denied' || outcome === 'expired_token') grants.delete(code);
    return providerResponse({ error: outcome }, 400);
  }
  grants.delete(code);
  return providerResponse({
    user: { id: grant.subject },
    access_token: providerAccessToken,
    refresh_token: providerRefreshToken,
  });
}

const temporaryDir = await mkdtemp(join(tmpdir(), 'anvil-device-auth-'));
let worker;
try {
  const workerBundle = await build({
    absWorkingDir: appDir,
    entryPoints: ['cloud/backend/src/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['cloudflare:workers'],
    logLevel: 'silent',
  });
  worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: workerBundle.outputFiles[0].text,
      compatibilityDate: '2026-09-01',
      durableObjects: {
        ACCOUNT: { className: 'AccountCoordinator', useSQLite: true },
        SESSIONS: { className: 'SessionCoordinator', useSQLite: true },
      },
      r2Buckets: ['ARTIFACTS'],
      bindings: { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId },
      outboundService: providerExchange,
    }),
  );
  const clientBundle = await build({
    absWorkingDir: appDir,
    stdin: {
      contents: [
        "export { runWorkOSDeviceFlow } from './src/main/services/workos-device-auth.service.ts';",
        "export { postAuthRoute } from './src/main/services/sync-backend-client.service.ts';",
      ].join('\n'),
      resolveDir: appDir,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const clientPath = join(temporaryDir, 'client.mjs');
  await writeFile(clientPath, clientBundle.outputFiles[0].text);
  const { runWorkOSDeviceFlow, postAuthRoute } = await import(pathToFileURL(clientPath).href);
  const connection = { apiUrl: origin + '/v1/' };
  const backendFetch = async (input, init) => {
    assert.equal(new URL(String(input)).origin, origin);
    const response = await worker.dispatchFetch(input, init);
    wireResponses.push(await response.clone().text());
    return response;
  };
  const authorizationFetch = async (input, init) => {
    assert.equal(input, issuer + '/authorize/device');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('client_id'), clientId);
    assert.equal(params.has('client_secret'), false);
    lastDeviceCode = randomBytes(32).toString('base64url');
    privateCodes.push(lastDeviceCode);
    grants.set(lastDeviceCode, { subject, outcomes: [...nextOutcomes] });
    return providerResponse({
      device_code: lastDeviceCode,
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://auth.anvil.test/device',
      verification_uri_complete: 'https://auth.anvil.test/device?user_code=ABCD-EFGH',
      expires_in: 300,
      interval: 5,
    });
  };
  const flow = (installationId, outcomes = []) => {
    nextOutcomes = outcomes;
    return runWorkOSDeviceFlow({
      clientId,
      installationId,
      fetchFn: authorizationFetch,
      enrollFn: (params, signal) =>
        postAuthRoute(connection, 'enroll', params, {
          fetchFn: backendFetch,
          signal,
        }),
      onChallenge: (challenge) => publicChallenges.push(challenge),
      now: () => clock,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        clock += milliseconds;
        // Keep the client clock fast while respecting the Worker's real
        // one-second provider backpressure floor.
        await new Promise((resolve) => setTimeout(resolve, 1_250));
      },
    });
  };
  const rpc = async (session, operation, params = {}) => {
    const response = await backendFetch(origin + '/v1/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + session.accessToken,
      },
      body: JSON.stringify({
        protocol: 'anvil-backend/1',
        requestId: randomUUID(),
        operation,
        params,
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, 'Expected successful Anvil RPC');
    assert.equal(payload.error, undefined, 'Expected successful Anvil RPC envelope');
    return payload.result;
  };

  const descriptor = await (await backendFetch(origin + '/.well-known/anvil-backend')).json();
  assert.ok(descriptor.authModes.includes('workos-device'));
  const first = await flow('first-device', ['authorization_pending', 'slow_down']);
  assert.ok(delays.includes(5_000));
  assert.ok(delays.includes(10_000));
  const consumedCode = lastDeviceCode;
  await assert.rejects(
    () =>
      postAuthRoute(
        connection,
        'enroll',
        {
          installationId: 'replayed-device',
          proof: { method: 'workos-device', issuer, deviceCode: consumedCode },
        },
        { fetchFn: backendFetch },
      ),
    { code: 'invalid-proof' },
  );

  const pending = await flow('manual-second-device');
  assert.equal(pending.accountId, first.accountId);
  assert.equal((await rpc(pending, 'security.get')).trustState, 'pending');
  const pkceCode = randomUUID();
  authorizationCodes.set(pkceCode, subject);
  const desktop = await postAuthRoute(
    connection,
    'enroll',
    {
      installationId: 'desktop-same-user',
      proof: {
        method: 'oidc-pkce',
        issuer,
        authorizationCode: pkceCode,
        codeVerifier: 'test-verifier',
        redirectUri: 'http://127.0.0.1:50000/callback',
        nonce: 'test-nonce',
      },
    },
    { fetchFn: backendFetch },
  );
  assert.equal(desktop.accountId, first.accountId);

  await rpc(first, 'security.configure', {
    policy: 'auto-trust-authenticated',
    backendId: 'device-auth-integration',
    envelope: {
      v: 1,
      algorithm: 'aes-256-gcm',
      recoveryId: randomUUID(),
      publicKey: randomBytes(32).toString('base64url'),
      nonce: randomBytes(12).toString('base64'),
      ct: randomBytes(32).toString('base64'),
    },
  });
  const automatic = await flow('automatic-device');
  const automaticView = await rpc(automatic, 'security.get');
  assert.equal(automatic.accountId, first.accountId);
  assert.equal(automaticView.trustState, 'trusted');
  assert.equal(automaticView.trustSource, 'automatic-auth');
  assert.equal(automaticView.requiresRecovery, true);
  assert.equal((await rpc(pending, 'security.get')).trustState, 'pending');
  await rpc(first, 'device.revoke', { enrollmentId: automatic.enrollmentId });
  await assert.rejects(() =>
    postAuthRoute(
      connection,
      'session/refresh',
      {
        enrollmentId: automatic.enrollmentId,
        refreshToken: automatic.refreshToken,
      },
      { fetchFn: backendFetch },
    ),
  );
  const replacement = await flow('fresh-enrollment-after-revoke');
  assert.notEqual(replacement.enrollmentId, automatic.enrollmentId);
  assert.equal((await rpc(replacement, 'security.get')).trustState, 'trusted');
  await assert.rejects(() => flow('denied-device', ['access_denied']), { code: 'access_denied' });
  await assert.rejects(() => flow('expired-device', ['expired_token']), { code: 'expired_token' });

  const publicOutput = JSON.stringify(publicChallenges);
  for (const code of privateCodes) assert.ok(!publicOutput.includes(code));
  for (const token of [providerAccessToken, providerRefreshToken]) {
    assert.ok(!publicOutput.includes(token));
    assert.ok(wireResponses.every((response) => !response.includes(token)));
  }
  console.log(
    'Device authorization integration passed: polling, account identity, trust policy, revocation, replay, denial, expiry, and token isolation.',
  );
} finally {
  await worker?.dispose();
  await rm(temporaryDir, { recursive: true });
}
