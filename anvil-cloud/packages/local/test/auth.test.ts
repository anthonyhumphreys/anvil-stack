import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { app, mutation, query } from "@anvil-cloud/runtime";

import { startLocalRuntimeServer } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function startTestServer() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-local-auth-"));
  const clientDistDir = path.join(rootDir, ".anvil/dist/client");

  tempDirs.push(rootDir);
  await mkdir(clientDistDir, { recursive: true });
  await writeFile(
    path.join(clientDistDir, "index.html"),
    "<h1>ok</h1>",
    "utf8",
  );

  const cell = app({
    queries: {
      whoAmI: query({
        auth: "required",
        handler: async (ctx) => ({ userId: ctx.auth.requireUser() }),
      }),
    },
    mutations: {
      adminOnly: mutation({
        auth: { roles: ["admin"] },
        handler: async () => ({ done: true }),
      }),
    },
  });

  const server = await startLocalRuntimeServer({
    app: cell,
    manifest: { cell: "auth-test" },
    rootDir,
    cellName: "auth-test",
    port: 0,
    clientPort: 0,
  });

  return server;
}

describe("local auth flow", () => {
  it("creates users, issues tokens, and authorizes runtime calls", async () => {
    const server = await startTestServer();

    try {
      const createUser = await fetch(`${server.runtimeUrl}/_anvil/auth/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "dev_1",
          email: "dev@example.test",
          roles: ["admin"],
        }),
      });

      expect(createUser.status).toBe(201);

      const tokenResponse = await fetch(
        `${server.runtimeUrl}/_anvil/auth/token`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: "dev_1" }),
        },
      );
      const issued = (await tokenResponse.json()) as {
        ok: boolean;
        token: string;
      };

      expect(issued.ok).toBe(true);

      const queryResponse = await fetch(
        `${server.runtimeUrl}/_anvil/query/whoAmI`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${issued.token}`,
          },
          body: JSON.stringify({ input: {} }),
        },
      );
      const queryPayload = (await queryResponse.json()) as {
        ok: boolean;
        result: { userId: string };
      };

      expect(queryPayload).toMatchObject({
        ok: true,
        result: { userId: "dev_1" },
      });

      const mutationResponse = await fetch(
        `${server.runtimeUrl}/_anvil/mutation/adminOnly`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${issued.token}`,
          },
          body: JSON.stringify({ input: {} }),
        },
      );

      expect(mutationResponse.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("rejects forged and missing tokens for protected handlers", async () => {
    const server = await startTestServer();

    try {
      const forged = await fetch(`${server.runtimeUrl}/_anvil/query/whoAmI`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer not-a-real-token",
        },
        body: JSON.stringify({ input: {} }),
      });

      expect(forged.status).toBe(401);

      const anonymous = await fetch(
        `${server.runtimeUrl}/_anvil/query/whoAmI`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: {}, auth: null }),
        },
      );
      const anonymousPayload = (await anonymous.json()) as {
        ok: boolean;
        error?: { code: string };
      };

      expect(anonymous.status).toBe(401);
      expect(anonymousPayload.error?.code).toBe("AUTH_REQUIRED");
    } finally {
      await server.close();
    }
  });

  it("serves jwks and whoami endpoints", async () => {
    const server = await startTestServer();

    try {
      const jwks = await fetch(`${server.runtimeUrl}/_anvil/auth/jwks`);
      const jwksPayload = (await jwks.json()) as { keys: unknown[] };

      expect(jwksPayload.keys).toHaveLength(1);

      const login = await fetch(`${server.runtimeUrl}/_anvil/auth/as/dev_2`, {
        method: "POST",
      });

      expect(login.status).toBe(200);

      const tokenResponse = await fetch(
        `${server.runtimeUrl}/_anvil/auth/token`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: "dev_2" }),
        },
      );
      const issued = (await tokenResponse.json()) as { token: string };
      const whoami = await fetch(`${server.runtimeUrl}/_anvil/auth/whoami`, {
        headers: { authorization: `Bearer ${issued.token}` },
      });
      const whoamiPayload = (await whoami.json()) as {
        identity: { userId: string };
        source: string;
      };

      expect(whoamiPayload).toMatchObject({
        identity: { userId: "dev_2" },
        source: "token",
      });
    } finally {
      await server.close();
    }
  });
});
