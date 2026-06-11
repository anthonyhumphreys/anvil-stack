import { describe, expect, it } from "vitest";
import {
  app,
  boolean,
  createInMemoryRuntimeHost,
  endpoint,
  handleRuntimeRequest,
  inspectAppDefinition,
  job,
  mutation,
  query,
  table,
  text,
  userId,
} from "../src/index.js";

const auth = {
  userId: "user_1",
  email: "user@example.local",
  roles: ["admin"],
};

describe("handleRuntimeRequest", () => {
  it("runs query handlers against the in-memory test host", async () => {
    const cell = app({
      schema: {
        notes: table({
          title: "text",
          ownerId: "userId",
        }),
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
    });
    const host = createInMemoryRuntimeHost({
      database: {
        notes: [
          { id: "note_1", ownerId: "user_1", title: "Runtime slice" },
          { id: "note_2", ownerId: "user_2", title: "Other user" },
        ],
      },
    });

    const response = await handleRuntimeRequest(cell, host, {
      kind: "query",
      name: "listNotes",
      input: {},
      auth,
      requestId: "req_query_1",
    });

    expect(response).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(response.body).toEqual([
      { id: "note_1", ownerId: "user_1", title: "Runtime slice" },
    ]);
  });

  it("runs mutation handlers against the in-memory test host", async () => {
    const cell = app({
      schema: {
        notes: table({
          title: "text",
          ownerId: "userId",
        }),
      },
      mutations: {
        createNote: mutation<{ title: string }>({
          handler: async (ctx, input) => {
            return ctx.db.notes.insert({
              title: input.title,
              ownerId: ctx.auth.requireUser(),
            });
          },
        }),
      },
    });
    const host = createInMemoryRuntimeHost();

    const response = await handleRuntimeRequest(cell, host, {
      kind: "mutation",
      name: "createNote",
      input: { title: "Mutation works" },
      auth,
      requestId: "req_mutation_1",
    });

    expect(response).toMatchObject({
      ok: true,
      status: 200,
      body: {
        id: "notes_1",
        ownerId: "user_1",
        title: "Mutation works",
      },
    });
    await expect(host.db.table("notes").all()).resolves.toEqual([
      { id: "notes_1", ownerId: "user_1", title: "Mutation works" },
    ]);
  });

  it("returns a stable HANDLER_NOT_FOUND error payload for missing handlers", async () => {
    const cell = app({
      queries: {},
    });
    const host = createInMemoryRuntimeHost();

    const response = await handleRuntimeRequest(cell, host, {
      kind: "query",
      name: "missing",
      input: {},
      auth,
      requestId: "req_missing_1",
    });

    expect(response).toMatchObject({
      ok: false,
      status: 404,
      body: {
        error: {
          code: "HANDLER_NOT_FOUND",
          message: "No query handler named 'missing' is defined.",
          details: {
            kind: "query",
            name: "missing",
          },
        },
      },
      error: {
        code: "HANDLER_NOT_FOUND",
        message: "No query handler named 'missing' is defined.",
        details: {
          kind: "query",
          name: "missing",
        },
      },
    });
  });

  it("normalises thrown handler errors into a stable runtime error payload", async () => {
    const cell = app({
      queries: {
        explode: query({
          handler: () => {
            throw new Error("the exciting implementation detail");
          },
        }),
      },
    });
    const host = createInMemoryRuntimeHost();

    const response = await handleRuntimeRequest(cell, host, {
      kind: "query",
      name: "explode",
      input: {},
      auth,
      requestId: "req_error_1",
    });

    expect(response).toMatchObject({
      ok: false,
      status: 500,
      body: {
        error: {
          code: "INTERNAL_ERROR",
          message: "Handler failed during runtime execution.",
        },
      },
      error: {
        code: "INTERNAL_ERROR",
        message: "Handler failed during runtime execution.",
      },
    });
    expect(host.logs.entries).toHaveLength(1);
    expect(host.logs.entries[0]).toMatchObject({
      level: "error",
      requestId: "req_error_1",
      kind: "query",
      handler: "explode",
      meta: {
        code: "INTERNAL_ERROR",
      },
    });
  });
});

describe("inspectAppDefinition", () => {
  it("inspects app definitions without executing handlers", () => {
    let handlerExecutions = 0;
    const cell = app({
      schema: {
        notes: table({
          title: text().min(1).max(100),
          archived: boolean().default(false),
          ownerId: userId(),
        }),
      },
      capabilities: {
        database: true,
      },
      queries: {
        listNotes: query({
          handler: () => {
            handlerExecutions += 1;
            return [];
          },
        }),
      },
      mutations: {
        createNote: mutation({
          handler: () => {
            handlerExecutions += 1;
            return {};
          },
        }),
      },
      endpoints: {
        webhook: endpoint({
          method: "post",
          path: "/api/webhook",
          auth: "none",
          handler: () => {
            handlerExecutions += 1;
            return { ok: true };
          },
        }),
      },
      jobs: {
        refresh: job({
          schedule: "rate(1 hour)",
          handler: () => {
            handlerExecutions += 1;
          },
        }),
      },
    });

    expect(inspectAppDefinition(cell)).toEqual({
      schemaVersion: "0.1",
      schema: {
        tables: [
          {
            name: "notes",
            fields: {
              title: {
                type: "text",
                constraints: {
                  min: 1,
                  max: 100,
                },
              },
              archived: {
                type: "boolean",
                constraints: {
                  default: false,
                },
              },
              ownerId: {
                type: "userId",
                constraints: {},
              },
            },
          },
        ],
      },
      capabilities: {
        database: true,
      },
      queries: ["listNotes"],
      mutations: ["createNote"],
      endpoints: [
        {
          name: "webhook",
          method: "POST",
          path: "/api/webhook",
          auth: "none",
        },
      ],
      jobs: [
        {
          name: "refresh",
          schedule: "rate(1 hour)",
        },
      ],
    });
    expect(handlerExecutions).toBe(0);
  });
});
