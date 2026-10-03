import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier === "./hosted/types" ? `${specifier}.ts` : specifier,
      context
    );
  }
});

const { hmacSha256, x25519 } = await import("../lib/mesh-crypto.ts");
const { BrowserWorkspaceKeyStore } = await import("../lib/browser-workspace-auth.ts");

function fromHex(value) {
  return new Uint8Array(Buffer.from(value, "hex"));
}

function toHex(value) {
  return Buffer.from(value).toString("hex");
}

test("X25519 matches RFC 7748 public-key and shared-secret vectors", () => {
  const alicePrivate = fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const alicePublic = fromHex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  const bobPrivate = fromHex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
  const bobPublic = fromHex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
  const basePoint = new Uint8Array(32);
  basePoint[0] = 9;

  assert.equal(toHex(x25519(alicePrivate, basePoint)), toHex(alicePublic));
  const sharedByAlice = x25519(alicePrivate, bobPublic);
  const sharedByBob = x25519(bobPrivate, alicePublic);
  assert.equal(toHex(sharedByAlice), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
  assert.deepEqual(sharedByAlice, sharedByBob);
});

test("browser renewal HMAC matches Node's SHA-256 implementation", async () => {
  const key = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));
  const message = "anvil/dashboard-renewal-proof/v1|account|request|challenge";
  const expected = createHmac("sha256", key).update(message).digest();

  assert.deepEqual(await hmacSha256(key, message), new Uint8Array(expected));
  await assert.rejects(hmacSha256(new Uint8Array(31), message), /must be 32 bytes/);
});

test("local session clearing retains remembered machine trust but account clearing removes it", async () => {
  const store = new BrowserWorkspaceKeyStore();
  const accountScope = "workspace-test-account";
  await store.clearAccount(accountScope);
  const trust = {
    accountScope,
    accountId: "sync-account",
    trustId: "trusted-machine-123",
    origin: "https://anvil.example",
    targetEnrollmentId: "desktop-123",
    browserPub: "browser-public-key",
    privateKey: new Uint8Array(32).fill(7),
    proofKey: new Uint8Array(32).fill(9),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    workspaceBindings: [{ workspaceId: "workspace-1", repositoryIds: ["repo-1"] }],
    scopes: ["workspace-read"],
    createdAt: new Date().toISOString()
  };
  const session = {
    accountScope,
    requestId: "request-12345678",
    browserPub: trust.browserPub,
    challenge: "challenge",
    expiresAt: trust.expiresAt,
    origin: trust.origin,
    targetEnrollmentId: trust.targetEnrollmentId,
    trustId: trust.trustId,
    privateKey: new Uint8Array(32).fill(3)
  };

  assert.equal(await store.saveTrust(trust), "memory");
  assert.equal(await store.save(session), "memory");
  store.clearSessionMemory(accountScope);
  assert.equal(await store.load(accountScope, session.requestId), null);
  assert.equal((await store.loadTrust(accountScope, trust.trustId))?.proofKey[0], 9);

  await store.clearAccount(accountScope);
  assert.equal(await store.loadTrust(accountScope, trust.trustId), null);
});
