import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  app,
  defineAgent,
  mutation,
  query,
  table,
  text,
} from "@anvil-cloud/runtime";

import {
  JsonDatabaseBranchManager,
  startLocalRuntimeServer,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("startLocalRuntimeServer", () => {
  it("manages local database branches without changing the ctx.db contract", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-local-"));
    tempDirs.push(rootDir);
    const stateDir = path.join(rootDir, ".anvil/local");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "dev.db"),
      JSON.stringify({
        notes: [{ id: "note_1", title: "Main", ownerId: "user" }],
      }),
      "utf8",
    );
    const branches = new JsonDatabaseBranchManager(stateDir);

    await expect(
      branches.createBranch({
        name: "Feature/Branch",
        ttlSeconds: 60,
        now: new Date("2026-07-06T10:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      name: "feature-branch",
      source: "main",
      expiresAt: "2026-07-06T10:01:00.000Z",
      tables: { notes: { rows: 1 } },
    });

    await writeFile(
      path.join(stateDir, "db-branches/feature-branch.db.json"),
      JSON.stringify({
        notes: [
          { id: "note_1", title: "Main", ownerId: "user" },
          { id: "note_2", title: "Branch", ownerId: "user", preview: true },
        ],
      }),
      "utf8",
    );

    await expect(branches.diffBranch("feature-branch")).resolves.toMatchObject({
      branch: "feature-branch",
      against: "main",
      tables: {
        notes: {
          branchRows: 2,
          againstRows: 1,
          rowDelta: 1,
          addedFields: ["preview"],
        },
      },
    });

    await expect(
      branches.setActiveBranch("feature-branch"),
    ).resolves.toMatchObject({
      name: "feature-branch",
      active: true,
    });

    await expect(
      branches.deleteExpiredBranches(new Date("2026-07-06T10:02:00.000Z")),
    ).resolves.toEqual(["feature-branch"]);
    await expect(branches.getActiveBranch()).resolves.toBe("main");
  });

  it("serves query, mutation, auth switching, and inspection routes", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-local-"));
    const clientDistDir = path.join(rootDir, ".anvil/dist/client");
    tempDirs.push(rootDir);
    await mkdir(clientDistDir, { recursive: true });
    await writeFile(
      path.join(clientDistDir, "index.html"),
      "<!doctype html><h1>Anvil Cell</h1>",
      "utf8",
    );

    const cell = app({
      schema: {
        notes: table({
          title: text().min(1),
        }),
      },
      capabilities: {
        database: true,
      },
      queries: {
        listNotes: query({
          handler: async (ctx) => {
            return ctx.db.notes
              .where("ownerId", "=", ctx.auth.requireUser())
              .all();
          },
        }),
      },
      mutations: {
        createNote: mutation<{ title: string }>({
          handler: async (ctx, input) => {
            await ctx.log.info("Creating note", { title: input.title });

            return ctx.db.notes.insert({
              title: input.title,
              ownerId: ctx.auth.requireUser(),
            });
          },
        }),
      },
    });
    const server = await startLocalRuntimeServer({
      app: cell,
      manifest: {
        queries: ["listNotes"],
        mutations: ["createNote"],
      },
      rootDir,
      cellName: "notes",
      port: 0,
      clientPort: 0,
    });

    try {
      await expect(
        postJson(`${server.runtimeUrl}/_anvil/auth/as/local_user`, {}),
      ).resolves.toMatchObject({
        ok: true,
      });
      await expect(
        postJson(`${server.runtimeUrl}/_anvil/mutation/createNote`, {
          input: { title: "Local works" },
        }),
      ).resolves.toMatchObject({
        ok: true,
        result: {
          title: "Local works",
          ownerId: "local_user",
        },
      });
      await expect(
        postJson(`${server.runtimeUrl}/_anvil/query/listNotes`, { input: {} }),
      ).resolves.toMatchObject({
        ok: true,
        result: [
          {
            title: "Local works",
            ownerId: "local_user",
          },
        ],
      });
      await expect(
        fetchJson(`${server.runtimeUrl}/_anvil/inspect`),
      ).resolves.toMatchObject({
        ok: true,
        status: "running",
        auth: {
          currentUser: "local_user",
        },
        database: {
          tables: {
            notes: {
              rows: 1,
            },
          },
        },
      });
      await expect(fetchText(server.clientUrl)).resolves.toContain(
        "Anvil Cell",
      );

      const lensResponse = await fetch(`${server.runtimeUrl}/_anvil/lens`);

      expect(lensResponse.status).toBe(200);
      expect(lensResponse.headers.get("content-type")).toContain("text/html");
      await expect(lensResponse.text()).resolves.toContain("Anvil Lens");
      await expect(
        fetchText(`${server.runtimeUrl}/_anvil/lens`),
      ).resolves.toContain("Diagnostics");

      await expect(
        postJson(`${server.clientUrl}/_anvil/mutation/createNote`, {
          input: { title: "Proxy works" },
        }),
      ).resolves.toMatchObject({
        ok: true,
        result: {
          title: "Proxy works",
          ownerId: "local_user",
        },
      });
      await expect(
        postJson(`${server.clientUrl}/_anvil/query/listNotes`, { input: {} }),
      ).resolves.toMatchObject({
        ok: true,
        result: expect.arrayContaining([
          expect.objectContaining({
            title: "Proxy works",
            ownerId: "local_user",
          }),
        ]),
      });
    } finally {
      await server.close();
    }
  });

  it("binds the local runtime to a selected database branch", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-local-"));
    tempDirs.push(rootDir);
    const stateDir = path.join(rootDir, ".anvil/local");
    await mkdir(path.join(rootDir, ".anvil/dist/client"), { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(rootDir, ".anvil/dist/client/index.html"),
      "<!doctype html><h1>Anvil Cell</h1>",
      "utf8",
    );
    await writeFile(
      path.join(stateDir, "dev.db"),
      JSON.stringify({ notes: [{ id: "note_1", title: "Main" }] }),
      "utf8",
    );
    await new JsonDatabaseBranchManager(stateDir).createBranch({
      name: "preview",
    });
    await writeFile(
      path.join(stateDir, "db-branches/preview.db.json"),
      JSON.stringify({ notes: [{ id: "note_2", title: "Preview" }] }),
      "utf8",
    );
    const cell = app({
      schema: {
        notes: table({
          title: text().min(1),
        }),
      },
      capabilities: {
        database: true,
      },
      queries: {
        listNotes: query({
          handler: async (ctx) => ctx.db.notes.all(),
        }),
      },
    });
    const server = await startLocalRuntimeServer({
      app: cell,
      manifest: { queries: ["listNotes"], mutations: [] },
      rootDir,
      cellName: "notes",
      databaseBranch: "preview",
      port: 0,
      clientPort: 0,
    });

    try {
      await expect(
        postJson(`${server.runtimeUrl}/_anvil/query/listNotes`, { input: {} }),
      ).resolves.toMatchObject({
        ok: true,
        result: [{ id: "note_2", title: "Preview" }],
      });
      await expect(
        fetchJson(`${server.runtimeUrl}/_anvil/inspect`),
      ).resolves.toMatchObject({
        ok: true,
        database: {
          activeBranch: "preview",
          tables: {
            notes: { rows: 1 },
          },
        },
      });
    } finally {
      await server.close();
    }
  });

  it("serves a Vite client with runtime proxying", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-local-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(
      path.join(rootDir, "index.html"),
      [
        "<!doctype html>",
        '<div id="root">Vite Cell</div>',
        '<script type="module" src="/src/main.ts"></script>',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "src/main.ts"),
      "document.body.dataset.loaded = 'true';\n",
      "utf8",
    );

    const cell = app({
      queries: {
        ping: query({
          auth: "public",
          handler: async () => ({ ok: true }),
        }),
      },
    });
    const server = await startLocalRuntimeServer({
      app: cell,
      manifest: {
        queries: ["ping"],
        mutations: [],
      },
      rootDir,
      cellName: "vite-cell",
      port: 0,
      clientPort: 0,
      clientMode: "vite",
    });

    try {
      await expect(fetchText(server.clientUrl)).resolves.toContain("Vite Cell");
      await expect(
        postJson(`${server.clientUrl}/_anvil/query/ping`, { input: {} }),
      ).resolves.toMatchObject({
        ok: true,
        result: {
          ok: true,
        },
      });
    } finally {
      await server.close();
    }
  });

  it("runs mounted agents through the local stub provider", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-local-"));
    const clientDistDir = path.join(rootDir, ".anvil/dist/client");
    tempDirs.push(rootDir);
    await mkdir(clientDistDir, { recursive: true });
    await writeFile(
      path.join(clientDistDir, "index.html"),
      "<!doctype html><h1>Anvil Cell</h1>",
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "instructions.md"),
      "Stay inside the support Cell contract.",
      "utf8",
    );

    const cell = app({
      agents: {
        support: defineAgent({
          name: "support",
          instructions: "./instructions.md",
          model: { provider: "local", model: "stub" },
          capabilities: {
            cells: ["read"],
            filesystem: "none",
            secrets: "none",
          },
        }),
      },
    });
    const server = await startLocalRuntimeServer({
      app: cell,
      manifest: {
        agents: {
          support: { kind: "anvil.agent", name: "support" },
        },
      },
      rootDir,
      cellName: "support",
      port: 0,
      clientPort: 0,
    });

    try {
      await expect(
        fetchJson(`${server.runtimeUrl}/_anvil/agents`),
      ).resolves.toMatchObject({
        ok: true,
        agents: ["support"],
        providers: ["local"],
      });
      await expect(
        postJson(`${server.runtimeUrl}/_anvil/agents/support`, {
          input: "Triage ticket A-123",
        }),
      ).resolves.toMatchObject({
        ok: true,
        result: {
          agentName: "support",
          response: {
            role: "assistant",
            content: "Local stub response from Anvil Agent.",
          },
        },
      });
    } finally {
      await server.close();
    }
  });
});

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return response.json();
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);

  return response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);

  return response.text();
}
