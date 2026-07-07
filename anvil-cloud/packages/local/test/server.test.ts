import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  app,
  defineAgent,
  job,
  mutation,
  query,
  table,
  text,
} from "@anvil-cloud/runtime";

import { startLocalRuntimeServer } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("startLocalRuntimeServer", () => {
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
      await expect(
        fetchJson(`${server.runtimeUrl}/_anvil/usage`),
      ).resolves.toMatchObject({
        ok: true,
        usage: {
          totals: {
            invocations: 2,
            totalTokens: 0,
            estimatedCostUsd: 0,
          },
          byCell: {
            notes: {
              invocations: 2,
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

  it("serves schedule routes and Lens schedule UI", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-local-"));
    tempDirs.push(rootDir);
    let runs = 0;
    const cell = app({
      capabilities: { scheduledJobs: true },
      jobs: {
        refresh: job({
          schedule: "rate(1 day)",
          handler: async () => {
            runs += 1;

            return { runs };
          },
        }),
      },
    });
    const server = await startLocalRuntimeServer({
      app: cell,
      manifest: {
        jobs: [{ name: "refresh", schedule: "rate(1 day)" }],
      },
      rootDir,
      cellName: "scheduled-cell",
      port: 0,
      clientPort: 0,
      clientMode: "none",
    });

    try {
      await expect(
        fetchText(`${server.runtimeUrl}/_anvil/lens`),
      ).resolves.toContain("Schedules");
      await expect(
        fetchJson(`${server.runtimeUrl}/_anvil/schedules`),
      ).resolves.toMatchObject({
        ok: true,
        schedules: [
          {
            name: "refresh",
            schedule: "rate(1 day)",
            overlap: "skip",
          },
        ],
      });
      await expect(
        postJson(`${server.runtimeUrl}/_anvil/schedules/refresh/run`, {
          payload: {},
        }),
      ).resolves.toMatchObject({
        ok: true,
        run: {
          job: "refresh",
          status: "completed",
          result: { runs: 1 },
        },
      });
      await expect(
        fetchJson(`${server.runtimeUrl}/_anvil/schedules`),
      ).resolves.toMatchObject({
        ok: true,
        schedules: [
          {
            name: "refresh",
            lastStatus: "completed",
            runs: [
              {
                job: "refresh",
                status: "completed",
              },
            ],
          },
        ],
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
          context: { sessionId: "session_1" },
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
      await expect(
        fetchJson(`${server.runtimeUrl}/_anvil/usage`),
      ).resolves.toMatchObject({
        ok: true,
        usage: {
          totals: {
            invocations: 1,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          },
          byAgent: {
            support: {
              invocations: 1,
            },
          },
          topConsumers: [
            {
              scope: "agent",
              name: "support",
            },
          ],
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
