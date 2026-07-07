import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  app,
  channel,
  defineAgent,
  job,
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
        fetchText(`${server.runtimeUrl}/_anvil/lens`),
      ).resolves.toContain("Approvals");

      await expect(
        server.host.approvals.requestApproval({
          action: "deploy.preview",
          reason: "Manual preview gate",
          metadata: { agentName: "shipmate" },
        }),
      ).resolves.toMatchObject({ status: "pending" });
      const approvalsPayload = (await fetchJson(
        `${server.runtimeUrl}/_anvil/approvals?status=pending`,
      )) as {
        approvals: Array<{
          id: string;
          status: string;
          action: string;
          metadata: Record<string, unknown>;
        }>;
      };
      const approval = approvalsPayload.approvals[0];

      expect(approval).toMatchObject({
        status: "pending",
        action: "deploy.preview",
        metadata: { agentName: "shipmate" },
      });
      await expect(
        postJson(
          `${server.runtimeUrl}/_anvil/approvals/${approval.id}/approve`,
          { actor: "test", reason: "Checked" },
        ),
      ).resolves.toMatchObject({
        ok: true,
        approval: {
          id: approval.id,
          status: "approved",
          decidedBy: "test",
        },
      });
      await expect(
        fetchJson(`${server.runtimeUrl}/_anvil/approvals/audit`),
      ).resolves.toMatchObject({
        ok: true,
        events: expect.arrayContaining([
          expect.objectContaining({
            type: "approval.approved",
            approvalId: approval.id,
          }),
        ]),
      });

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

  it("enforces outbound fetch allow lists during local runtime requests", async () => {
    const originalFetch = globalThis.fetch;
    const externalFetches: string[] = [];
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-local-"));
    tempDirs.push(rootDir);

    const cell = app({
      capabilities: {
        outboundFetch: { allow: ["api.example.test"] },
      },
      queries: {
        allowedFetch: query({
          handler: async () => {
            const response = await fetch("https://api.example.test/v1");

            return { status: response.status };
          },
        }),
        blockedFetch: query({
          handler: async () => {
            await fetch("https://billing.example.test/v1");

            return { ok: true };
          },
        }),
      },
    });
    const server = await startLocalRuntimeServer({
      app: cell,
      manifest: {
        capabilities: {
          outboundFetch: { allow: ["api.example.test"] },
        },
        queries: ["allowedFetch", "blockedFetch"],
        mutations: [],
      },
      rootDir,
      cellName: "notes",
      port: 0,
      clientPort: 0,
      clientMode: "none",
    });

    try {
      globalThis.fetch = (async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);

        if (url.startsWith(server.runtimeUrl)) {
          return originalFetch(input, init);
        }

        externalFetches.push(url);
        return new Response("ok", { status: 202 });
      }) as typeof fetch;

      await expect(
        postJson(`${server.runtimeUrl}/_anvil/query/allowedFetch`, {
          input: {},
        }),
      ).resolves.toMatchObject({
        ok: true,
        result: { status: 202 },
      });
      await expect(
        postJson(`${server.runtimeUrl}/_anvil/query/blockedFetch`, {
          input: {},
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: "OUTBOUND_FETCH_NOT_ALLOWED",
          details: {
            host: "billing.example.test",
            allowedHosts: ["api.example.test"],
          },
        },
      });
      expect(externalFetches).toEqual(["https://api.example.test/v1"]);
    } finally {
      globalThis.fetch = originalFetch;
      await server.close();
    }
  });

  it("creates agent sessions, sends messages, and resumes event streams", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-local-"));
    tempDirs.push(rootDir);

    const cell = app({
      agents: {
        support: defineAgent({
          name: "support",
          model: { provider: "local", model: "stub" },
        }),
      },
    });
    const server = await startLocalRuntimeServer({
      app: cell,
      manifest: {
        agents: { support: { name: "support" } },
      },
      rootDir,
      cellName: "agent-cell",
      port: 0,
      clientPort: 0,
    });

    try {
      const created = (await postJson(
        `${server.runtimeUrl}/_anvil/agents/support/sessions`,
        {},
      )) as {
        ok: boolean;
        result: { session: { sessionId: string; continuationToken: string } };
      };

      expect(created.ok).toBe(true);
      expect(created.result.session.sessionId).toMatch(/^session_/);
      expect(created.result.session.continuationToken).toBe("1");

      const sent = (await postJson(
        `${server.runtimeUrl}/_anvil/agents/sessions/${created.result.session.sessionId}/messages`,
        { input: "hello" },
      )) as {
        ok: boolean;
        result: {
          continuationToken: string;
          events: Array<{ id: number; type: string }>;
        };
      };

      expect(sent).toMatchObject({
        ok: true,
        result: {
          events: expect.arrayContaining([
            expect.objectContaining({ type: "message.user" }),
            expect.objectContaining({ type: "message.assistant" }),
          ]),
        },
      });

      const stream = await fetchText(
        `${server.runtimeUrl}/_anvil/agents/sessions/${created.result.session.sessionId}/stream?after=1`,
      );

      expect(stream).toContain("event: message.user");
      expect(stream).toContain("event: message.assistant");
      expect(stream).not.toContain("event: session.created");
      expect(sent.result.continuationToken).toBe("3");
    } finally {
      await server.close();
    }
  });

  it("simulates channel messages through mounted agent sessions", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-local-"));
    tempDirs.push(rootDir);

    const cell = app({
      agents: {
        support: defineAgent({
          name: "support",
          model: { provider: "local", model: "stub" },
        }),
      },
      channels: {
        supportSlack: channel({
          provider: "slack",
          agent: "support",
          sessionKey: "sender-thread",
          events: ["app_mention"],
        }),
      },
    });
    const server = await startLocalRuntimeServer({
      app: cell,
      manifest: {
        agents: { support: { name: "support" } },
        channels: [{ name: "supportSlack", provider: "slack" }],
      },
      rootDir,
      cellName: "channel-cell",
      port: 0,
      clientPort: 0,
    });

    try {
      const first = (await postJson(
        `${server.runtimeUrl}/_anvil/channels/simulate`,
        {
          channel: "supportSlack",
          sender: "U123",
          thread: "T456",
          input: "hello",
        },
      )) as {
        ok: boolean;
        result: {
          session: { sessionId: string; channel: { key: string } };
          events: Array<{ type: string }>;
          reply: unknown[];
        };
      };
      const second = (await postJson(
        `${server.runtimeUrl}/_anvil/channels/simulate`,
        {
          channel: "supportSlack",
          sender: "U123",
          thread: "T456",
          input: "still there?",
        },
      )) as {
        result: {
          session: { sessionId: string; continuationToken: string };
        };
      };

      expect(first).toMatchObject({
        ok: true,
        result: {
          session: {
            channel: {
              key: "supportSlack:U123:T456",
            },
          },
          events: expect.arrayContaining([
            expect.objectContaining({ type: "channel.message" }),
            expect.objectContaining({ type: "channel.reply" }),
          ]),
        },
      });
      expect(first.result.reply).toHaveLength(1);
      expect(second.result.session.sessionId).toBe(
        first.result.session.sessionId,
      );
      expect(second.result.session.continuationToken).toBe("5");
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
