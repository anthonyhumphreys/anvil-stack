import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  enforceAuthRequirement,
  type AuthIdentity,
} from "@anvil-cloud/runtime";
import { LocalIdentityProvider } from "./local-provider.js";
import { OidcTokenVerifier } from "./oidc.js";
import { AuthError, type ClaimsMapping } from "./types.js";

export type AuthConformanceStatus = "pass" | "fail";

export type AuthConformanceCheck = {
  id: string;
  status: AuthConformanceStatus;
  provider: "local" | "oidc" | "policy" | "fixture";
  message: string;
  details?: Record<string, unknown>;
};

export type AuthProviderFixture = {
  provider: "auth0" | "entra" | "cognito" | "keycloak";
  issuer: string;
  audience: string;
  claims: Required<ClaimsMapping>;
  env: Record<string, string>;
};

export type AuthConformanceResult = {
  ok: boolean;
  summary: {
    passed: number;
    failed: number;
  };
  checks: AuthConformanceCheck[];
  fixtures: AuthProviderFixture[];
};

export type AuthConformanceOptions = {
  stateDir?: string;
};

const testAudience = "anvil-cloud-conformance";
const conformanceUser: AuthIdentity = {
  userId: "user_1",
  email: "dev@example.test",
  roles: ["admin"],
  claims: {
    tenantId: "tenant_1",
  },
};

export const oidcProviderFixtures: AuthProviderFixture[] = [
  createFixture(
    "auth0",
    "https://tenant.us.auth0.com/",
    "https://api.example.test",
    {
      userId: "sub",
      email: "email",
      roles: "https://anvil.dev/roles",
    },
  ),
  createFixture(
    "entra",
    "https://login.microsoftonline.com/<tenant-id>/v2.0",
    "api://anvil-cell",
    {
      userId: "oid",
      email: "preferred_username",
      roles: "roles",
    },
  ),
  createFixture(
    "cognito",
    "https://cognito-idp.<region>.amazonaws.com/<user-pool-id>",
    "anvil-cell-client-id",
    {
      userId: "sub",
      email: "email",
      roles: "cognito:groups",
    },
  ),
  createFixture(
    "keycloak",
    "https://sso.example.test/realms/anvil",
    "anvil-cell",
    {
      userId: "sub",
      email: "email",
      roles: "roles",
    },
  ),
];

export async function runAuthConformanceSuite(
  options: AuthConformanceOptions = {},
): Promise<AuthConformanceResult> {
  const ownedStateDir =
    options.stateDir ?? (await mkdtemp(path.join(tmpdir(), "anvil-auth-kit-")));
  const shouldCleanup = options.stateDir === undefined;
  const checks: AuthConformanceCheck[] = [];

  try {
    const local = new LocalIdentityProvider({
      stateDir: path.join(ownedStateDir, "local"),
      audience: testAudience,
    });

    await runCheck(checks, {
      id: "local.issueAndVerify",
      provider: "local",
      success: "Local IdP issued and verified an ES256 JWT.",
      failure: "Local IdP failed to issue or verify a JWT.",
      run: async () => {
        await local.createUser({
          userId: conformanceUser.userId,
          email: "dev@example.test",
          roles: ["admin"],
          claims: {
            tenantId: "tenant_1",
          },
        });

        const issued = await local.issueToken(conformanceUser.userId);
        const verified = await local.verifyToken(issued.token);

        expectIdentity(verified.identity, conformanceUser);
      },
    });

    await runPolicyChecks(checks);
    await runOidcChecks(checks, ownedStateDir);
    addFixtureChecks(checks);
  } finally {
    if (shouldCleanup) {
      await rm(ownedStateDir, { recursive: true, force: true });
    }
  }

  const failed = checks.filter((check) => check.status === "fail").length;

  return {
    ok: failed === 0,
    summary: {
      passed: checks.length - failed,
      failed,
    },
    checks,
    fixtures: oidcProviderFixtures,
  };
}

async function runPolicyChecks(checks: AuthConformanceCheck[]): Promise<void> {
  await runCheck(checks, {
    id: "policy.required",
    provider: "policy",
    success:
      "Required handlers accept verified identity and reject anonymous requests.",
    failure: "Required handler policy did not match runtime auth rules.",
    run: async () => {
      enforceAuthRequirement({ access: "required" }, conformanceUser);
      expectRuntimeAuthError(() =>
        enforceAuthRequirement({ access: "required" }, null),
      );
    },
  });

  await runCheck(checks, {
    id: "policy.roles",
    provider: "policy",
    success:
      "Role-gated handlers accept matching roles and reject missing roles.",
    failure: "Role-gated handler policy did not match runtime auth rules.",
    run: async () => {
      enforceAuthRequirement(
        { access: "required", roles: ["admin"] },
        conformanceUser,
      );
      expectRuntimeAuthError(() =>
        enforceAuthRequirement(
          { access: "required", roles: ["owner"] },
          conformanceUser,
        ),
      );
    },
  });

  await runCheck(checks, {
    id: "policy.public",
    provider: "policy",
    success: "Public handlers allow anonymous requests.",
    failure: "Public handler policy rejected an anonymous request.",
    run: async () => {
      enforceAuthRequirement({ access: "public" }, null);
    },
  });
}

async function runOidcChecks(
  checks: AuthConformanceCheck[],
  stateDir: string,
): Promise<void> {
  const { issuer, server } = await startIssuerServer(
    path.join(stateDir, "oidc"),
  );

  try {
    const provider = new LocalIdentityProvider({
      stateDir: path.join(stateDir, "oidc"),
      issuer,
      audience: testAudience,
    });

    await provider.createUser({
      userId: conformanceUser.userId,
      email: "dev@example.test",
      roles: ["admin"],
      claims: {
        tenantId: "tenant_1",
      },
    });

    await runCheck(checks, {
      id: "oidc.discoveryAndVerify",
      provider: "oidc",
      success: "OIDC verifier discovered JWKS and verified a conforming token.",
      failure: "OIDC verifier failed discovery or token verification.",
      run: async () => {
        const issued = await provider.issueToken(conformanceUser.userId);
        const verifier = new OidcTokenVerifier({
          issuer,
          audience: testAudience,
        });
        const verified = await verifier.verifyToken(issued.token);

        expectIdentity(verified.identity, conformanceUser);
      },
    });

    await runCheck(checks, {
      id: "oidc.expiry",
      provider: "oidc",
      success: "OIDC verifier rejects expired tokens.",
      failure: "OIDC verifier accepted or misclassified an expired token.",
      run: async () => {
        const issued = await provider.issueToken(conformanceUser.userId, {
          ttlSeconds: -60,
        });
        const verifier = new OidcTokenVerifier({
          issuer,
          audience: testAudience,
        });

        await expectAuthError(
          () => verifier.verifyToken(issued.token),
          "TOKEN_EXPIRED",
        );
      },
    });

    await runCheck(checks, {
      id: "oidc.issuer",
      provider: "oidc",
      success: "OIDC verifier rejects tokens from a different issuer.",
      failure: "OIDC verifier accepted or misclassified a wrong-issuer token.",
      run: async () => {
        const imposter = new LocalIdentityProvider({
          stateDir: path.join(stateDir, "oidc"),
          issuer: "https://elsewhere.invalid",
          audience: testAudience,
        });

        const issued = await imposter.issueToken(conformanceUser.userId);
        const verifier = new OidcTokenVerifier({
          issuer,
          audience: testAudience,
        });

        await expectAuthError(
          () => verifier.verifyToken(issued.token),
          "ISSUER_MISMATCH",
        );
      },
    });

    await runCheck(checks, {
      id: "oidc.audience",
      provider: "oidc",
      success: "OIDC verifier rejects tokens for a different audience.",
      failure:
        "OIDC verifier accepted or misclassified a wrong-audience token.",
      run: async () => {
        const issued = await provider.issueToken(conformanceUser.userId);
        const verifier = new OidcTokenVerifier({
          issuer,
          audience: "different-audience",
        });

        await expectAuthError(
          () => verifier.verifyToken(issued.token),
          "AUDIENCE_MISMATCH",
        );
      },
    });

    await runCheck(checks, {
      id: "oidc.claimMapping",
      provider: "oidc",
      success: "OIDC verifier maps configured user, email, and role claims.",
      failure: "OIDC verifier did not honor configured claims mapping.",
      run: async () => {
        await provider.createUser({
          userId: "ignored-subject",
          claims: {
            uid: "mapped_user",
            mail: "mapped@example.test",
            scp: "admin editor",
          },
        });

        const issued = await provider.issueToken("ignored-subject");
        const verifier = new OidcTokenVerifier({
          issuer,
          audience: testAudience,
          claims: {
            userId: "uid",
            email: "mail",
            roles: "scp",
          },
        });
        const verified = await verifier.verifyToken(issued.token);

        expectIdentity(verified.identity, {
          userId: "mapped_user",
          email: "mapped@example.test",
          roles: ["admin", "editor"],
        });
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function addFixtureChecks(checks: AuthConformanceCheck[]): void {
  for (const fixture of oidcProviderFixtures) {
    checks.push({
      id: `fixture.${fixture.provider}`,
      status: "pass",
      provider: "fixture",
      message: `${fixture.provider} OIDC fixture declares issuer, audience, and claims mapping.`,
      details: {
        issuer: fixture.issuer,
        audience: fixture.audience,
        claims: fixture.claims,
      },
    });
  }
}

async function runCheck(
  checks: AuthConformanceCheck[],
  check: {
    id: string;
    provider: AuthConformanceCheck["provider"];
    success: string;
    failure: string;
    run: () => Promise<void>;
  },
): Promise<void> {
  try {
    await check.run();
    checks.push({
      id: check.id,
      status: "pass",
      provider: check.provider,
      message: check.success,
    });
  } catch (error) {
    checks.push({
      id: check.id,
      status: "fail",
      provider: check.provider,
      message: check.failure,
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function expectIdentity(actual: AuthIdentity, expected: AuthIdentity): void {
  if (actual.userId !== expected.userId) {
    throw new Error(
      `Expected userId '${expected.userId}', got '${actual.userId}'.`,
    );
  }

  if (expected.email !== undefined && actual.email !== expected.email) {
    throw new Error(
      `Expected email '${expected.email}', got '${actual.email}'.`,
    );
  }

  if (expected.roles !== undefined) {
    const actualRoles = actual.roles ?? [];
    const missing = expected.roles.filter(
      (role) => !actualRoles.includes(role),
    );

    if (missing.length > 0) {
      throw new Error(`Missing roles: ${missing.join(", ")}.`);
    }
  }
}

async function expectAuthError(
  run: () => Promise<unknown>,
  code: AuthError["code"],
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AuthError && error.code === code) {
      return;
    }

    throw error;
  }

  throw new Error(`Expected AuthError ${code}.`);
}

function expectRuntimeAuthError(run: () => void): void {
  try {
    run();
  } catch {
    return;
  }

  throw new Error("Expected runtime auth policy to reject the request.");
}

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

function createFixture(
  provider: AuthProviderFixture["provider"],
  issuer: string,
  audience: string,
  claims: Required<ClaimsMapping>,
): AuthProviderFixture {
  return {
    provider,
    issuer,
    audience,
    claims,
    env: {
      ANVIL_AUTH_ISSUER: issuer,
      ANVIL_AUTH_AUDIENCE: audience,
      ANVIL_AUTH_USER_ID_CLAIM: claims.userId,
      ANVIL_AUTH_EMAIL_CLAIM: claims.email,
      ANVIL_AUTH_ROLES_CLAIM: Array.isArray(claims.roles)
        ? claims.roles.join(",")
        : claims.roles,
    },
  };
}
