import assert from "node:assert/strict";
import { createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/mesh-crypto") {
      return nextResolve(new URL("../lib/mesh-crypto.ts", import.meta.url).href, context);
    }
    if (
      specifier.endsWith(".js") &&
      context.parentURL?.endsWith("/anvil-website/lib/browser-workspace-transport.ts")
    ) {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    return nextResolve(
      specifier === "./hosted/types" ? `${specifier}.ts` :
      context.parentURL?.endsWith("/anvil-app/cloud/contract/machine.ts") && specifier === "./browser-workspace"
        ? `${specifier}.ts`
        : specifier,
      context
    );
  }
});

const { hmacSha256, x25519 } = await import("../lib/mesh-crypto.ts");
const { BrowserWorkspaceKeyStore } = await import("../lib/browser-workspace-auth.ts");
const {
  browserMachineSessionTokenAssociatedData,
  browserMachineRouteCandidates,
  decideBrowserMachineCursor,
  isUsableBrowserMachineRoute,
  openBrowserMachineSessionToken,
  validateBrowserMachineClaims,
} = await import("../lib/browser-workspace-transport.ts");
const { MESH_MACHINE_CAPABILITIES } = await import("../../anvil-app/cloud/contract/machine.ts");

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

test("browser machine routes reject expired and mixed-content destinations", () => {
  const now = Date.now();
  const route = {
    kind: "private",
    url: "http://192.168.1.22:47631",
    machineId: "machine-1",
    endpointGeneration: "generation-1234567890",
    reachableUntil: new Date(now + 60_000).toISOString(),
  };
  assert.equal(isUsableBrowserMachineRoute(route, "https:", now), false);
  assert.equal(isUsableBrowserMachineRoute(route, "http:", now), true);
  assert.equal(isUsableBrowserMachineRoute({ ...route, kind: "managed", url: "http://192.168.1.22" }, "http:", now), false);
  assert.equal(isUsableBrowserMachineRoute({ ...route, reachableUntil: new Date(now - 1).toISOString() }, "http:", now), false);

  const host = {
    enrollmentId: "enrollment-1",
    machineId: "machine-1",
    endpointGeneration: "generation-1234567890",
    protocolVersion: 1,
    capabilities: ["machine.session/1", "machine.stream/1"],
    operations: ["read.snapshot"],
    online: true,
    lastSeenAt: new Date(now).toISOString(),
    reachableUntil: new Date(now + 60_000).toISOString(),
    routes: [
      { ...route, url: "https://desktop.example" },
      { ...route, kind: "managed", url: "https://machine.example" },
    ],
    allocationState: "ready",
  };
  assert.deepEqual(browserMachineRouteCandidates(host, now).map((item) => item.kind), ["private", "managed"]);
  assert.deepEqual(browserMachineRouteCandidates({ ...host, capabilities: ["machine.session/1"] }, now), []);
});

test("browser machine bootstrap claims bind the grant, workspace, route and exact operations", () => {
  const now = Date.now();
  const keypair = { priv: new Uint8Array(32).fill(7), pub: new Uint8Array(32).fill(8) };
  const clientPublicKey = Buffer.from(keypair.pub).toString("base64");
  const authorization = {
    route: {
      kind: "managed",
      url: "https://machine.example",
      machineId: "machine-1",
      endpointGeneration: "generation-1234567890",
      reachableUntil: new Date(now + 60_000).toISOString(),
    },
    accountId: "account-1",
    grantId: "grant-1",
    targetEnrollmentId: "enrollment-1",
    workspaceId: "workspace-1",
    repositoryIds: ["repo-1"],
    scopes: [],
    dsk: new Uint8Array(32),
    origin: "https://anvil.example",
  };
  const claims = {
    v: 1,
    bootstrapId: "bootstrap-12345678",
    challenge: "abcdefghijklmnopqrstuvwx",
    accountId: "account-1",
    sourceEnrollmentId: null,
    machineId: "machine-1",
    endpointGeneration: "generation-1234567890",
    clientPublicKey,
    capabilities: ["machine.session/1", "machine.stream/1"],
    principal: {
      kind: "dashboard",
      accountId: "account-1",
      sourceBrowserId: "grant-1",
      grantId: "grant-1",
    },
    scope: {
      workspaceIds: ["workspace-1"],
      repositoryIds: ["repo-1"],
      scopes: [],
      operations: [],
    },
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
  };
  assert.equal(validateBrowserMachineClaims(claims, authorization, clientPublicKey, now), true);
  assert.equal(validateBrowserMachineClaims({ ...claims, machineId: "machine-2" }, authorization, clientPublicKey, now), false);
  assert.equal(validateBrowserMachineClaims({ ...claims, scope: { ...claims.scope, operations: ["command.submit"] } }, authorization, clientPublicKey, now), false);
  assert.ok(MESH_MACHINE_CAPABILITIES.includes("machine.session/1"));
});

test("sealed browser session tokens authenticate their full associated scope", async () => {
  const client = await import("../lib/mesh-crypto.ts").then((module) => module.generateBrowserKeypair());
  const clientPublicKey = Buffer.from(client.pub);
  const ephemeralPrivate = new Uint8Array(randomBytes(32));
  const basePoint = new Uint8Array(32);
  basePoint[0] = 9;
  const ephemeralPublic = x25519(ephemeralPrivate, basePoint);
  const shared = x25519(ephemeralPrivate, client.pub);
  const wrapKey = Buffer.from(hkdfSync(
    "sha256",
    shared,
    Buffer.concat([Buffer.from(ephemeralPublic), clientPublicKey]),
    "anvil/keyring-wrap/v1",
    32,
  ));
  const nonce = randomBytes(12);
  const principal = {
    kind: "dashboard",
    accountId: "account-1",
    sourceBrowserId: "browser-1",
    grantId: "grant-1",
  };
  const associatedData = browserMachineSessionTokenAssociatedData({
    accountId: "account-1",
    principal,
    machineId: "machine-1",
    endpointGeneration: "generation-1234567890",
    sessionId: "session-1",
  });
  const plaintext = Buffer.from(JSON.stringify({
    v: 1,
    sessionId: "session-1",
    sessionToken: Buffer.alloc(32, 9).toString("base64"),
  }));
  const cipher = createCipheriv("aes-256-gcm", wrapKey, nonce);
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const sealed = {
    enc: "x25519-aes-256-gcm",
    ephPub: Buffer.from(ephemeralPublic).toString("base64"),
    nonce: nonce.toString("base64"),
    ct: ciphertext.toString("base64"),
  };

  const opened = await openBrowserMachineSessionToken(sealed, client.priv, client.pub, associatedData);
  assert.equal(opened?.sessionId, "session-1");
  assert.deepEqual(opened?.sessionToken, new Uint8Array(32).fill(9));
  assert.equal(await openBrowserMachineSessionToken(
    sealed,
    client.priv,
    client.pub,
    associatedData.replace("machine-1", "machine-2"),
  ), null);
  client.priv.fill(0);
  ephemeralPrivate.fill(0);
  shared.fill(0);
  wrapKey.fill(0);
});

test("machine stream replay accepts only the next cursor and resnapshots gaps or epoch changes", () => {
  const cursor = { epoch: "epoch-1", sequence: 6 };
  assert.deepEqual(decideBrowserMachineCursor(cursor, { epoch: "epoch-1", sequence: 6 }), { kind: "duplicate" });
  assert.deepEqual(decideBrowserMachineCursor(cursor, { epoch: "epoch-1", sequence: 7 }), {
    kind: "accept",
    cursor: { epoch: "epoch-1", sequence: 7 },
  });
  assert.deepEqual(decideBrowserMachineCursor(cursor, { epoch: "epoch-1", sequence: 9 }), {
    kind: "resnapshot",
    reason: "sequence-gap",
  });
  assert.deepEqual(decideBrowserMachineCursor(cursor, { epoch: "epoch-2", sequence: 1 }), {
    kind: "resnapshot",
    reason: "epoch-changed",
  });
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
