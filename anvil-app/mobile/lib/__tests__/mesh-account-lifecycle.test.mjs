import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const result = await build({
  entryPoints: [new URL('../anvil-account.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'secure-store-test-adapter',
      setup(api) {
        api.onResolve({ filter: /^expo-secure-store$/ }, () => ({
          path: 'store',
          namespace: 'test',
        }));
        api.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: `
          export const getItemAsync = async (key) => globalThis.__meshAccountStore.get(key) ?? null;
          export const setItemAsync = async (key, value) => { await globalThis.__meshAccountWrite?.(); globalThis.__meshAccountStore.set(key, value); };
          export const deleteItemAsync = async (key) => { globalThis.__meshAccountStore.delete(key); };
        `,
        }));
      },
    },
  ],
});
const account = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const session = (accountId) => ({
  accountId,
  enrollmentId: 'phone',
  datasetEpoch: 'dataset',
  accessToken: `access-${accountId}`,
  refreshToken: `refresh-${accountId}`,
});
const seed = () => {
  globalThis.__meshAccountStore = new Map([
    ['anvil.account.backend.v1', 'https://old.test'],
    ['anvil.account.session.v1', JSON.stringify(session('old'))],
  ]);
};
const response = (body) => new Response(JSON.stringify(body), { status: 200 });

test('sign-out hides credentials immediately and a late refresh cannot overwrite new enrollment', async () => {
  seed();
  const refresh = deferred();
  const revoke = deferred();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    url.endsWith('session/refresh')
      ? refresh.promise
      : url.endsWith('session/revoke')
        ? revoke.promise
        : response(session('new'));
  try {
    const refreshing = account.refreshAccountSession();
    await tick();
    const signingOut = account.signOutAccount();
    assert.equal(await account.getAccountConnection(), null);
    await tick();
    const enrolled = await account.enrollWithCode('https://new.test', 'single-use-code', 'Phone');
    assert.equal(enrolled.session.accountId, 'new');
    const rejected = assert.rejects(refreshing, /account connection changed/);
    refresh.resolve(response(session('old')));
    await rejected;
    revoke.resolve(response({ ok: true }));
    await signingOut;
    assert.equal((await account.getAccountConnection()).session.accountId, 'new');
    assert.equal((await account.getAccountConnection()).apiUrl, 'https://new.test');
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__meshAccountStore;
  }
});

test('sign-out clears an already-writing refresh after both secure-store writes finish', async () => {
  seed();
  const writing = deferred();
  globalThis.__meshAccountWrite = () => writing.promise;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    response(url.endsWith('session/refresh') ? session('old') : { ok: true });
  try {
    const refreshing = account.refreshAccountSession();
    await tick();
    const signingOut = account.signOutAccount();
    assert.equal(await account.getAccountConnection(), null);
    const rejected = assert.rejects(refreshing, /account connection changed/);
    writing.resolve();
    await rejected;
    await signingOut;
    assert.equal(await account.getAccountConnection(), null);
  } finally {
    writing.resolve();
    globalThis.fetch = originalFetch;
    delete globalThis.__meshAccountStore;
    delete globalThis.__meshAccountWrite;
  }
});
