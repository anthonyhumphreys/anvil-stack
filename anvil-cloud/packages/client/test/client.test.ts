import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import { app, mutation, query, table, text } from "@anvil-cloud/runtime";
import { startLocalRuntimeServer } from "@anvil-cloud/local";

import {
  AnvilClientError,
  createAnvilHooks,
  createApiClient,
  createClient,
  isAnvilClientError,
  type HookRuntime,
  type ApiMutation,
  type ApiQuery,
  type GeneratedAnvilApi,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("AnvilClient", () => {
  it("calls query and mutation runtime routes", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = createClient({
      runtimeUrl: "http://runtime.local/",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          body:
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as unknown)
              : null,
        });

        return Response.json({
          ok: true,
          result: {
            called: String(url),
          },
        });
      },
    });

    await expect(
      client.query({ kind: "query", name: "listNotes" }, { limit: 10 }),
    ).resolves.toEqual({
      called: "http://runtime.local/_anvil/query/listNotes",
    });
    await expect(
      client.mutation({ kind: "mutation", name: "createNote" }, { title: "A" }),
    ).resolves.toEqual({
      called: "http://runtime.local/_anvil/mutation/createNote",
    });
    expect(calls).toEqual([
      {
        url: "http://runtime.local/_anvil/query/listNotes",
        body: {
          input: {
            limit: 10,
          },
        },
      },
      {
        url: "http://runtime.local/_anvil/mutation/createNote",
        body: {
          input: {
            title: "A",
          },
        },
      },
    ]);
  });

  it("binds generated API metadata to direct query and mutation functions", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          body:
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as unknown)
              : null,
        });

        return Response.json({
          ok: true,
          result: {
            url: String(url),
          },
        });
      },
    });
    const generated = {
      queries: {
        listNotes: { kind: "query", name: "listNotes" },
      },
      mutations: {
        createNote: { kind: "mutation", name: "createNote" },
      },
      meta: {
        schemaVersion: "0.1",
        queries: ["listNotes"],
        mutations: ["createNote"],
      },
    } as const;
    const apiClient = createApiClient(client, generated);

    expect(apiClient.meta).toEqual({
      schemaVersion: "0.1",
      queries: ["listNotes"],
      mutations: ["createNote"],
    });
    await expect(apiClient.queries.listNotes({ limit: 10 })).resolves.toEqual({
      url: "http://runtime.local/_anvil/query/listNotes",
    });
    await expect(
      apiClient.mutations.createNote({ title: "Bound" }),
    ).resolves.toEqual({
      url: "http://runtime.local/_anvil/mutation/createNote",
    });
    expect(calls).toEqual([
      {
        url: "http://runtime.local/_anvil/query/listNotes",
        body: {
          input: {
            limit: 10,
          },
        },
      },
      {
        url: "http://runtime.local/_anvil/mutation/createNote",
        body: {
          input: {
            title: "Bound",
          },
        },
      },
    ]);
  });

  it("creates agent sessions, sends messages, and reads resumed stream events", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          ...(typeof init?.body === "string"
            ? { body: JSON.parse(init.body) as unknown }
            : {}),
        });

        if (String(url).endsWith("/_anvil/agents/support/sessions")) {
          return Response.json(
            {
              ok: true,
              result: {
                session: {
                  sessionId: "session_1",
                  agent: "support",
                  status: "idle",
                  createdAt: "2026-07-06T12:00:00.000Z",
                  updatedAt: "2026-07-06T12:00:00.000Z",
                  continuationToken: "1",
                },
              },
            },
            { status: 201 },
          );
        }

        if (
          String(url).endsWith("/_anvil/agents/sessions/session_1/messages")
        ) {
          return Response.json({
            ok: true,
            result: {
              session: {
                sessionId: "session_1",
                agent: "support",
                status: "idle",
                createdAt: "2026-07-06T12:00:00.000Z",
                updatedAt: "2026-07-06T12:00:01.000Z",
                continuationToken: "3",
              },
              events: [
                {
                  id: 2,
                  sessionId: "session_1",
                  type: "message.user",
                  timestamp: "2026-07-06T12:00:01.000Z",
                  data: { input: "hello" },
                },
              ],
              continuationToken: "3",
            },
          });
        }

        return new Response(
          [
            "id: 3",
            "event: message.assistant",
            'data: {"id":3,"sessionId":"session_1","type":"message.assistant","timestamp":"2026-07-06T12:00:02.000Z","data":{"message":{"role":"assistant","content":"hi"}}}',
            "",
            "",
          ].join("\n"),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });

    await expect(client.createAgentSession("support")).resolves.toMatchObject({
      sessionId: "session_1",
      continuationToken: "1",
    });
    await expect(
      client.sendAgentSessionMessage("session_1", "hello"),
    ).resolves.toMatchObject({
      continuationToken: "3",
      events: [{ type: "message.user" }],
    });
    await expect(
      client.streamAgentSessionEvents("session_1", { after: "2" }),
    ).resolves.toMatchObject([
      {
        id: 3,
        type: "message.assistant",
      },
    ]);
    expect(calls).toMatchObject([
      {
        method: "POST",
        url: "http://runtime.local/_anvil/agents/support/sessions",
      },
      {
        method: "POST",
        url: "http://runtime.local/_anvil/agents/sessions/session_1/messages",
        body: { input: "hello" },
      },
      {
        method: "GET",
        url: "http://runtime.local/_anvil/agents/sessions/session_1/stream?after=2",
      },
    ]);
  });

  it("synthesizes generated API client meta when legacy metadata is absent", () => {
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async () => Response.json({ ok: true, result: null }),
    });
    const generated = {
      queries: {
        zeta: { kind: "query", name: "zeta" },
        alpha: { kind: "query", name: "alpha" },
      },
      mutations: {
        createNote: { kind: "mutation", name: "createNote" },
      },
    } as const;
    const apiClient = createApiClient(client, generated);

    expect(apiClient.meta).toEqual({
      schemaVersion: "0.1",
      queries: ["alpha", "zeta"],
      mutations: ["createNote"],
      agents: [],
    });
  });

  it("rejects invalid generated route metadata before calling the runtime", async () => {
    let calls = 0;
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async () => {
        calls += 1;

        return Response.json({ ok: true, result: null });
      },
    });

    await expect(
      client.query({ kind: "mutation", name: "listNotes" } as ApiQuery, {}),
    ).rejects.toMatchObject({
      name: "AnvilClientError",
      status: 0,
      code: "INVALID_API_DEFINITION",
      message: "Generated Anvil query metadata is invalid.",
      details: {
        expectedKind: "query",
      },
    });
    await expect(
      client.mutation({ kind: "mutation", name: "" }, {}),
    ).rejects.toMatchObject({
      name: "AnvilClientError",
      status: 0,
      code: "INVALID_API_DEFINITION",
      message: "Generated Anvil mutation metadata is invalid.",
      details: {
        expectedKind: "mutation",
      },
    });
    expect(calls).toBe(0);
  });

  it("rejects invalid generated API metadata before binding routes", () => {
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async () => Response.json({ ok: true, result: null }),
    });

    expect(() =>
      createApiClient(client, { queries: {} } as GeneratedAnvilApi),
    ).toThrow(AnvilClientError);
    expect(() =>
      createApiClient(client, { queries: {} } as GeneratedAnvilApi),
    ).toThrow(
      expect.objectContaining({
        name: "AnvilClientError",
        status: 0,
        code: "INVALID_API_DEFINITION",
        message: "Generated Anvil API metadata is invalid.",
      }),
    );
  });

  it("rejects invalid generated API meta before binding routes", () => {
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async () => Response.json({ ok: true, result: null }),
    });
    const generated = {
      queries: {},
      mutations: {},
      meta: {
        schemaVersion: "999",
        queries: [],
        mutations: [],
      },
    } as unknown as GeneratedAnvilApi;

    expect(() => createApiClient(client, generated)).toThrow(
      expect.objectContaining({
        name: "AnvilClientError",
        status: 0,
        code: "INVALID_API_DEFINITION",
        message: "Generated Anvil API metadata is invalid.",
        details: expect.objectContaining({
          reason: "invalid-meta",
        }),
      }),
    );
  });

  it("rejects generated API meta that does not match route records", () => {
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async () => Response.json({ ok: true, result: null }),
    });
    const generated = {
      queries: {
        listNotes: { kind: "query", name: "listNotes" },
      },
      mutations: {
        createNote: { kind: "mutation", name: "createNote" },
      },
      meta: {
        schemaVersion: "0.1",
        queries: ["staleQuery"],
        mutations: [],
      },
    } satisfies GeneratedAnvilApi;

    expect(() => createApiClient(client, generated)).toThrow(
      expect.objectContaining({
        name: "AnvilClientError",
        status: 0,
        code: "INVALID_API_DEFINITION",
        message: "Generated Anvil API metadata is invalid.",
        details: {
          reason: "meta-route-mismatch",
          expected: {
            queries: ["listNotes"],
            mutations: ["createNote"],
          },
          actual: {
            queries: ["staleQuery"],
            mutations: [],
          },
        },
      }),
    );
  });

  it("URL-encodes generated route names before calling the runtime", async () => {
    const calls: string[] = [];
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async (url) => {
        calls.push(String(url));

        return Response.json({ ok: true, result: null });
      },
    });

    await client.query({ kind: "query", name: "notes/search all" }, {});
    await client.mutation({ kind: "mutation", name: "notes/archive all" }, {});

    expect(calls).toEqual([
      "http://runtime.local/_anvil/query/notes%2Fsearch%20all",
      "http://runtime.local/_anvil/mutation/notes%2Farchive%20all",
    ]);
  });

  it("infers direct API function input and result types from generated metadata", () => {
    type Note = { id: string; title: string };
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async () => Response.json({ ok: true, result: null }),
    });
    const generated = {
      queries: {
        listNotes: {
          kind: "query",
          name: "listNotes",
        } as ApiQuery<"listNotes", { limit?: number }, Note[]>,
      },
      mutations: {
        createNote: {
          kind: "mutation",
          name: "createNote",
        } as ApiMutation<"createNote", { title: string }, Note>,
      },
      meta: {
        schemaVersion: "0.1",
        queries: ["listNotes"],
        mutations: ["createNote"],
      } as const,
    } satisfies GeneratedAnvilApi;
    const apiClient = createApiClient(client, generated);

    expectTypeOf(apiClient.meta).toEqualTypeOf<{
      readonly schemaVersion: "0.1";
      readonly queries: readonly ["listNotes"];
      readonly mutations: readonly ["createNote"];
    }>();
    expectTypeOf(apiClient.queries.listNotes).parameters.toEqualTypeOf<
      [{ limit?: number }]
    >();
    expectTypeOf(apiClient.queries.listNotes).returns.toEqualTypeOf<
      Promise<Note[]>
    >();
    expectTypeOf(apiClient.mutations.createNote).parameters.toEqualTypeOf<
      [{ title: string }]
    >();
    expectTypeOf(apiClient.mutations.createNote).returns.toEqualTypeOf<
      Promise<Note>
    >();
  });

  it("infers hook input and result types from generated metadata", () => {
    type Note = { id: string; title: string };
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async () => Response.json({ ok: true, result: null }),
    });
    const runtime = new TestHookRuntime();
    const hooks = createAnvilHooks(client, runtime);
    const listNotes = { kind: "query", name: "listNotes" } as ApiQuery<
      "listNotes",
      { limit?: number },
      Note[]
    >;
    const createNote = { kind: "mutation", name: "createNote" } as ApiMutation<
      "createNote",
      { title: string },
      Note
    >;
    const queryResult = runtime.render(() =>
      hooks.useQuery(listNotes, { limit: 5 }),
    );
    const mutationResult = runtime.render(() => hooks.useMutation(createNote));

    expectTypeOf(queryResult.data).toEqualTypeOf<Note[] | null>();
    expectTypeOf(queryResult.refetch).returns.toEqualTypeOf<Promise<Note[]>>();
    expectTypeOf(mutationResult.data).toEqualTypeOf<Note | null>();
    expectTypeOf(mutationResult.mutate).parameters.toEqualTypeOf<
      [{ title: string }]
    >();
    expectTypeOf(mutationResult.mutate).returns.toEqualTypeOf<Promise<Note>>();
    runtime.render(() =>
      hooks.useMutation(createNote, {
        onSuccess: (note) => {
          expectTypeOf(note).toEqualTypeOf<Note>();
        },
        refetch: queryResult,
      }),
    );
  });

  it("supports manually refetched queries without auto-loading on render", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          body:
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as unknown)
              : null,
        });

        return Response.json({
          ok: true,
          result: [{ id: "note_1", title: "Manual note" }],
        });
      },
    });
    const runtime = new TestHookRuntime();
    const hooks = createAnvilHooks(client, runtime);
    const listNotes = { kind: "query", name: "listNotes" } as ApiQuery<
      "listNotes",
      { archived?: boolean },
      Array<{ id: string; title: string }>
    >;
    const query = runtime.render(() =>
      hooks.useQuery(listNotes, { archived: false }, { enabled: false }),
    );

    expect(query.status).toBe("idle");
    expect(calls).toEqual([]);
    await expect(query.refetch()).resolves.toEqual([
      { id: "note_1", title: "Manual note" },
    ]);
    expect(calls).toEqual([
      {
        url: "http://runtime.local/_anvil/query/listNotes",
        body: { input: { archived: false } },
      },
    ]);
    expect(runtime.stateAt(0)).toMatchObject({
      status: "success",
      data: [{ id: "note_1", title: "Manual note" }],
    });
  });

  it("refreshes query results after successful mutations", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const notes = [{ id: "note_1", title: "Original" }];
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async (input, init) => {
        const url = String(input);
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as { input?: unknown })
            : {};
        calls.push({ url, body });

        if (url.endsWith("/_anvil/mutation/createNote")) {
          const inputBody = body.input as { title: string };
          const note = {
            id: `note_${notes.length + 1}`,
            title: inputBody.title,
          };
          notes.push(note);

          return Response.json({
            ok: true,
            result: note,
          });
        }

        return Response.json({
          ok: true,
          result: notes,
        });
      },
    });
    const runtime = new TestHookRuntime();
    const hooks = createAnvilHooks(client, runtime);
    const listNotes = { kind: "query", name: "listNotes" } as ApiQuery<
      "listNotes",
      { archived?: boolean },
      Array<{ id: string; title: string }>
    >;
    const createNote = { kind: "mutation", name: "createNote" } as ApiMutation<
      "createNote",
      { title: string },
      { id: string; title: string }
    >;
    const successes: string[] = [];
    const [_query, mutation] = runtime.render(() => {
      const queryResult = hooks.useQuery(
        listNotes,
        { archived: false },
        { enabled: false },
      );
      const mutationResult = hooks.useMutation(createNote, {
        onSuccess: (note) => {
          successes.push(note.title);
        },
        refetch: queryResult,
      });

      return [queryResult, mutationResult] as const;
    });

    await expect(mutation.mutate({ title: "Refetched" })).resolves.toEqual({
      id: "note_2",
      title: "Refetched",
    });
    expect(successes).toEqual(["Refetched"]);
    expect(calls.map((call) => call.url)).toEqual([
      "http://runtime.local/_anvil/mutation/createNote",
      "http://runtime.local/_anvil/query/listNotes",
    ]);
    expect(runtime.stateAt(0)).toMatchObject({
      status: "success",
      data: [
        { id: "note_1", title: "Original" },
        { id: "note_2", title: "Refetched" },
      ],
    });
    expect(runtime.stateAt(1)).toMatchObject({
      status: "success",
      data: { id: "note_2", title: "Refetched" },
    });
  });

  it("uses the latest mutation options after rerendering hooks", async () => {
    const refetches: string[] = [];
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async (_input, init) => {
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as { input?: { title?: string } })
            : {};

        return Response.json({
          ok: true,
          result: {
            id: "note_1",
            title: body.input?.title ?? "Untitled",
          },
        });
      },
    });
    const runtime = new TestHookRuntime();
    const hooks = createAnvilHooks(client, runtime);
    const createNote = { kind: "mutation", name: "createNote" } as ApiMutation<
      "createNote",
      { title: string },
      { id: string; title: string }
    >;
    const successes: string[] = [];

    const first = runtime.render(() =>
      hooks.useMutation(createNote, {
        onSuccess: (note) => {
          successes.push(`first:${note.title}`);
        },
        refetch: async () => {
          refetches.push("first");
        },
      }),
    );
    const second = runtime.render(() =>
      hooks.useMutation(createNote, {
        onSuccess: (note) => {
          successes.push(`second:${note.title}`);
        },
        refetch: async () => {
          refetches.push("second");
        },
      }),
    );

    expect(second.mutate).toBe(first.mutate);
    await expect(first.mutate({ title: "Latest" })).resolves.toEqual({
      id: "note_1",
      title: "Latest",
    });
    expect(successes).toEqual(["second:Latest"]);
    expect(refetches).toEqual(["second"]);
  });

  it("throws structured runtime errors", async () => {
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async () =>
        Response.json(
          {
            ok: false,
            error: {
              code: "AUTH_REQUIRED",
              message: "A signed-in user is required.",
              details: {
                auth: "required",
              },
            },
          },
          { status: 401 },
        ),
    });

    await expect(
      client.query({ kind: "query", name: "listNotes" }, {}),
    ).rejects.toMatchObject({
      name: "AnvilClientError",
      status: 401,
      code: "AUTH_REQUIRED",
      message: "A signed-in user is required.",
      request: {
        kind: "query",
        name: "listNotes",
        path: "/_anvil/query/listNotes",
      },
      details: {
        auth: "required",
      },
    });
  });

  it("detects structured client errors", () => {
    const error = new AnvilClientError({
      status: 401,
      code: "AUTH_REQUIRED",
      message: "A signed-in user is required.",
      request: {
        kind: "mutation",
        name: "createNote",
        path: "/_anvil/mutation/createNote",
      },
    });

    if (isAnvilClientError(error)) {
      expect(error.request).toEqual({
        kind: "mutation",
        name: "createNote",
        path: "/_anvil/mutation/createNote",
      });
    } else {
      throw new Error("Expected AnvilClientError to be detected.");
    }

    expect(isAnvilClientError(new Error("plain"))).toBe(false);
    expect(isAnvilClientError(null)).toBe(false);
  });

  it("normalizes non-runtime HTTP failures", async () => {
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async () =>
        Response.json(
          {
            ok: true,
            result: null,
          },
          { status: 502 },
        ),
    });

    await expect(
      client.query({ kind: "query", name: "listNotes" }, {}),
    ).rejects.toBeInstanceOf(AnvilClientError);
    await expect(
      client.query({ kind: "query", name: "listNotes" }, {}),
    ).rejects.toMatchObject({
      status: 502,
      code: "HTTP_ERROR",
      message: "Runtime request failed with 502.",
      request: {
        kind: "query",
        name: "listNotes",
        path: "/_anvil/query/listNotes",
      },
    });
  });

  it("normalizes network failures", async () => {
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    await expect(
      client.query({ kind: "query", name: "listNotes" }, {}),
    ).rejects.toMatchObject({
      name: "AnvilClientError",
      status: 0,
      code: "NETWORK_ERROR",
      message: "Runtime request failed before a response was received.",
      request: {
        kind: "query",
        name: "listNotes",
        path: "/_anvil/query/listNotes",
      },
      details: {
        name: "TypeError",
        message: "fetch failed",
      },
    });
  });

  it("normalizes invalid runtime JSON responses", async () => {
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async () =>
        new Response("<html>not the runtime</html>", {
          status: 502,
          headers: {
            "content-type": "text/html",
          },
        }),
    });

    await expect(
      client.query({ kind: "query", name: "listNotes" }, {}),
    ).rejects.toMatchObject({
      name: "AnvilClientError",
      status: 502,
      code: "INVALID_RUNTIME_RESPONSE",
      message: "Runtime response was not valid JSON.",
      request: {
        kind: "query",
        name: "listNotes",
        path: "/_anvil/query/listNotes",
      },
    });
  });

  it("normalizes invalid runtime payload shapes", async () => {
    const client = createClient({
      runtimeUrl: "http://runtime.local",
      fetch: async () =>
        Response.json({
          result: [],
        }),
    });

    await expect(
      client.query({ kind: "query", name: "listNotes" }, {}),
    ).rejects.toMatchObject({
      name: "AnvilClientError",
      status: 200,
      code: "INVALID_RUNTIME_RESPONSE",
      message:
        "Runtime response did not match the Anvil runtime payload shape.",
      request: {
        kind: "query",
        name: "listNotes",
        path: "/_anvil/query/listNotes",
      },
      details: {
        payload: {
          result: [],
        },
      },
    });
  });

  it("runs generated-style useQuery and useMutation hooks against local runtime", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-client-"));
    tempDirs.push(rootDir);
    const cell = app({
      schema: {
        notes: table({
          text: text().min(1),
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
        addNote: mutation<{ text: string }>({
          handler: async (ctx, input) => {
            return ctx.db.notes.insert({
              text: input.text,
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
        mutations: ["addNote"],
      },
      rootDir,
      cellName: "notes",
      port: 0,
      clientPort: 0,
    });
    const api = {
      queries: {
        listNotes: { kind: "query", name: "listNotes" } as ApiQuery<
          "listNotes",
          unknown,
          Array<{ text: string; ownerId: string }>
        >,
      },
      mutations: {
        addNote: { kind: "mutation", name: "addNote" } as ApiMutation<
          "addNote",
          { text: string },
          { text: string; ownerId: string }
        >,
      },
    } as const;

    try {
      await postJson(`${server.runtimeUrl}/_anvil/auth/as/hook_user`, {});

      const client = createClient({ runtimeUrl: server.runtimeUrl });
      const mutationRuntime = new TestHookRuntime();
      const mutationHooks = createAnvilHooks(client, mutationRuntime);
      const mutation = mutationRuntime.render(() =>
        mutationHooks.useMutation(api.mutations.addNote),
      );

      await expect(
        mutation.mutate({ text: "Hook note" }),
      ).resolves.toMatchObject({
        text: "Hook note",
        ownerId: "hook_user",
      });
      expect(mutationRuntime.stateAt(0)).toMatchObject({
        status: "success",
        data: {
          text: "Hook note",
          ownerId: "hook_user",
        },
      });

      const queryRuntime = new TestHookRuntime();
      const queryHooks = createAnvilHooks(client, queryRuntime);
      const query = queryRuntime.render(() =>
        queryHooks.useQuery(api.queries.listNotes, {}),
      );

      await waitFor(() => {
        expect(queryRuntime.stateAt(0)).toMatchObject({
          status: "success",
          data: [
            {
              text: "Hook note",
              ownerId: "hook_user",
            },
          ],
        });
      });

      await mutation.mutate({ text: "Refetched note" });

      await expect(query.refetch()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "Hook note" }),
          expect.objectContaining({ text: "Refetched note" }),
        ]),
      );
      expect(queryRuntime.stateAt(0)).toMatchObject({
        status: "success",
        data: expect.arrayContaining([
          expect.objectContaining({ text: "Refetched note" }),
        ]),
      });
    } finally {
      await server.close();
    }
  });
});

class TestHookRuntime implements HookRuntime {
  private index = 0;
  private readonly slots: unknown[] = [];
  private readonly states: unknown[] = [];
  private readonly stateIndexes = new Map<number, number>();

  render<TResult>(render: () => TResult): TResult {
    this.index = 0;

    return render();
  }

  stateAt(index: number): unknown {
    return this.states[index];
  }

  useCallback<T extends (...args: any[]) => unknown>(
    callback: T,
    deps: unknown[],
  ): T {
    const callbackIndex = this.index;
    this.index += 1;
    const previous = this.slots[callbackIndex] as
      | { deps: unknown[]; callback: T }
      | undefined;

    if (previous && sameDeps(previous.deps, deps)) {
      return previous.callback;
    }

    this.slots[callbackIndex] = { deps, callback };
    return callback;
  }

  useEffect(effect: () => void | (() => void)): void {
    effect();
  }

  useMemo<T>(factory: () => T): T {
    return factory();
  }

  useRef<T>(initial: T): { current: T } {
    const refIndex = this.index;
    this.index += 1;

    if (this.slots[refIndex] === undefined) {
      this.slots[refIndex] = { current: initial };
    }

    return this.slots[refIndex] as { current: T };
  }

  useState<T>(
    initial: T | (() => T),
  ): [T, (value: T | ((previous: T) => T)) => void] {
    const slotIndex = this.index;
    this.index += 1;
    let stateIndex = this.stateIndexes.get(slotIndex);

    if (stateIndex === undefined) {
      stateIndex = this.states.length;
      this.stateIndexes.set(slotIndex, stateIndex);
    }

    if (this.slots[slotIndex] === undefined) {
      this.slots[slotIndex] =
        typeof initial === "function" ? (initial as () => T)() : initial;
      this.states[stateIndex] = this.slots[slotIndex];
    }

    const setState = (value: T | ((previous: T) => T)) => {
      const previous = this.slots[slotIndex] as T;
      this.slots[slotIndex] =
        typeof value === "function"
          ? (value as (previous: T) => T)(previous)
          : value;
      this.states[stateIndex] = this.slots[slotIndex];
    };

    return [this.slots[slotIndex] as T, setState];
  }
}

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

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 1000) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}

function sameDeps(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}
