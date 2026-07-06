import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  oidcProviderFixtures,
  runAuthConformanceSuite,
} from "../src/conformance.js";
import { identityFromClaims } from "../src/claims.js";
import { LocalIdentityProvider } from "../src/local-provider.js";
import { OidcTokenVerifier } from "../src/oidc.js";
import { AuthError } from "../src/types.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function createStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "anvil-auth-"));

  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  return dir;
}

describe("LocalIdentityProvider", () => {
  it("issues and verifies tokens for created users", async () => {
    const provider = new LocalIdentityProvider({
      stateDir: await createStateDir(),
    });

    await provider.createUser({
      userId: "user_1",
      email: "dev@example.test",
      roles: ["admin"],
    });

    const issued = await provider.issueToken("user_1");
    const verified = await provider.verifyToken(issued.token);

    expect(verified.identity).toMatchObject({
      userId: "user_1",
      email: "dev@example.test",
      roles: ["admin"],
    });
    expect(verified.subject).toBe("user_1");
    expect(new Date(verified.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects expired tokens", async () => {
    const provider = new LocalIdentityProvider({
      stateDir: await createStateDir(),
    });

    await provider.createUser({ userId: "user_1" });

    const issued = await provider.issueToken("user_1", { ttlSeconds: -60 });

    await expect(provider.verifyToken(issued.token)).rejects.toMatchObject({
      code: "TOKEN_EXPIRED",
    });
  });

  it("rejects tokens for unknown users at issue time", async () => {
    const provider = new LocalIdentityProvider({
      stateDir: await createStateDir(),
    });

    await expect(provider.issueToken("ghost")).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
    });
  });

  it("rejects duplicate users", async () => {
    const provider = new LocalIdentityProvider({
      stateDir: await createStateDir(),
    });

    await provider.createUser({ userId: "user_1" });

    await expect(
      provider.createUser({ userId: "user_1" }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("persists keys and users across instances", async () => {
    const stateDir = await createStateDir();
    const first = new LocalIdentityProvider({ stateDir });

    await first.createUser({ userId: "user_1" });

    const issued = await first.issueToken("user_1");
    const second = new LocalIdentityProvider({ stateDir });
    const verified = await second.verifyToken(issued.token);

    expect(verified.identity.userId).toBe("user_1");
    expect(await second.listUsers()).toHaveLength(1);
  });

  it("rejects tokens signed by a different keypair", async () => {
    const provider = new LocalIdentityProvider({
      stateDir: await createStateDir(),
    });
    const imposter = new LocalIdentityProvider({
      stateDir: await createStateDir(),
    });

    await imposter.createUser({ userId: "user_1" });

    const issued = await imposter.issueToken("user_1");

    await expect(provider.verifyToken(issued.token)).rejects.toMatchObject({
      code: "TOKEN_INVALID",
    });
  });
});

describe("identityFromClaims", () => {
  it("maps default claims", () => {
    const identity = identityFromClaims({
      sub: "user_1",
      email: "dev@example.test",
      roles: ["admin", "editor"],
    });

    expect(identity).toMatchObject({
      userId: "user_1",
      email: "dev@example.test",
      roles: ["admin", "editor"],
    });
  });

  it("supports cognito group claims", () => {
    const identity = identityFromClaims({
      sub: "user_1",
      "cognito:groups": ["team-a"],
    });

    expect(identity.roles).toEqual(["team-a"]);
  });

  it("supports custom claim mapping and space-separated roles", () => {
    const identity = identityFromClaims(
      { uid: "user_1", scp: "read write" },
      { userId: "uid", roles: "scp" },
    );

    expect(identity.userId).toBe("user_1");
    expect(identity.roles).toEqual(["read", "write"]);
  });

  it("throws when the user id claim is missing", () => {
    expect(() => identityFromClaims({ email: "x@y.test" })).toThrow(
      /missing the 'sub' claim/,
    );
  });
});

describe("OidcTokenVerifier", () => {
  it("verifies tokens against a discovered JWKS endpoint", async () => {
    const stateDir = await createStateDir();
    const { issuer, server } = await startIssuerServer(stateDir);

    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );

    const provider = new LocalIdentityProvider({ stateDir, issuer });

    await provider.createUser({ userId: "user_1", roles: ["admin"] });

    const issued = await provider.issueToken("user_1");
    const verifier = new OidcTokenVerifier({ issuer });
    const verified = await verifier.verifyToken(issued.token);

    expect(verified.identity).toMatchObject({
      userId: "user_1",
      roles: ["admin"],
    });
  });

  it("rejects tokens from a different issuer", async () => {
    const stateDir = await createStateDir();
    const { issuer, server } = await startIssuerServer(stateDir);

    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );

    const provider = new LocalIdentityProvider({
      stateDir,
      issuer: "https://elsewhere.invalid",
    });

    await provider.createUser({ userId: "user_1" });

    const issued = await provider.issueToken("user_1");
    const verifier = new OidcTokenVerifier({ issuer });

    await expect(verifier.verifyToken(issued.token)).rejects.toMatchObject({
      code: "ISSUER_MISMATCH",
    });
  });

  it("rejects tokens with the wrong audience", async () => {
    const stateDir = await createStateDir();
    const { issuer, server } = await startIssuerServer(stateDir);

    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );

    const provider = new LocalIdentityProvider({
      stateDir,
      issuer,
      audience: "preview-smoke",
    });

    await provider.createUser({ userId: "user_1" });

    const issued = await provider.issueToken("user_1");
    const verifier = new OidcTokenVerifier({
      issuer,
      audience: "production",
    });

    await expect(verifier.verifyToken(issued.token)).rejects.toMatchObject({
      code: "AUDIENCE_MISMATCH",
    });
  });

  it("rejects expired OIDC tokens", async () => {
    const stateDir = await createStateDir();
    const { issuer, server } = await startIssuerServer(stateDir);

    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );

    const provider = new LocalIdentityProvider({ stateDir, issuer });

    await provider.createUser({ userId: "user_1" });

    const issued = await provider.issueToken("user_1", { ttlSeconds: -60 });
    const verifier = new OidcTokenVerifier({ issuer });

    await expect(verifier.verifyToken(issued.token)).rejects.toMatchObject({
      code: "TOKEN_EXPIRED",
    });
  });

  it("rejects OIDC tokens that do not map to an Anvil identity", async () => {
    const stateDir = await createStateDir();
    const { issuer, server } = await startIssuerServer(stateDir);

    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );

    const provider = new LocalIdentityProvider({ stateDir, issuer });

    await provider.createUser({ userId: "user_1" });

    const issued = await provider.issueToken("user_1");
    const verifier = new OidcTokenVerifier({
      issuer,
      claims: {
        userId: "uid",
      },
    });

    await expect(verifier.verifyToken(issued.token)).rejects.toMatchObject({
      code: "TOKEN_INVALID",
      message: "Token is missing the 'uid' claim.",
    });
  });
});

describe("auth conformance kit", () => {
  it("runs the local IdP, OIDC, policy, and fixture scenarios", async () => {
    const result = await runAuthConformanceSuite({
      stateDir: await createStateDir(),
    });

    expect(result.ok).toBe(true);
    expect(result.summary.failed).toBe(0);
    expect(result.checks.map((check) => check.id)).toEqual([
      "local.issueAndVerify",
      "policy.required",
      "policy.roles",
      "policy.public",
      "oidc.discoveryAndVerify",
      "oidc.expiry",
      "oidc.issuer",
      "oidc.audience",
      "oidc.claimMapping",
      "fixture.auth0",
      "fixture.entra",
      "fixture.cognito",
      "fixture.keycloak",
    ]);
    expect(result.fixtures).toEqual(oidcProviderFixtures);
  });
});

async function startIssuerServer(
  stateDir: string,
): Promise<{ issuer: string; server: Server }> {
  const provider = new LocalIdentityProvider({ stateDir });
  const server = createServer(async (request, response) => {
    if (request.url?.includes("openid-configuration")) {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ jwks_uri: `http://127.0.0.1:${port}/jwks` }),
      );
      return;
    }

    if (request.url?.includes("jwks")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(await provider.publicJwks()));
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return { issuer: `http://127.0.0.1:${port}`, server };
}
