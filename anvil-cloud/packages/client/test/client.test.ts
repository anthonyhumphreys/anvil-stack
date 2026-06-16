import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { app, mutation, query, table, text } from "@anvil-cloud/runtime";
import { startLocalRuntimeServer } from "@anvil-cloud/local";

import {
  AnvilClientError,
  createAnvilHooks,
  createClient,
  isAnvilClientError,
  type HookRuntime,
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
      details: {
        auth: "required",
      },
    });
  });

  it("detects structured client errors", () => {
    expect(
      isAnvilClientError(
        new AnvilClientError({
          status: 401,
          code: "AUTH_REQUIRED",
          message: "A signed-in user is required.",
        }),
      ),
    ).toBe(true);
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
        listNotes: { kind: "query", name: "listNotes" },
      },
      mutations: {
        addNote: { kind: "mutation", name: "addNote" },
      },
    } as const;

    try {
      await postJson(`${server.runtimeUrl}/_anvil/auth/as/hook_user`, {});

      const client = createClient({ runtimeUrl: server.runtimeUrl });
      const mutationRuntime = new TestHookRuntime();
      const mutationHooks = createAnvilHooks(client, mutationRuntime);
      const mutation = mutationRuntime.render(() =>
        mutationHooks.useMutation<{ text: string }>(api.mutations.addNote),
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
  private readonly states: unknown[] = [];

  render<TResult>(render: () => TResult): TResult {
    this.index = 0;

    return render();
  }

  stateAt(index: number): unknown {
    return this.states[index];
  }

  useCallback<T extends (...args: any[]) => unknown>(callback: T): T {
    return callback;
  }

  useEffect(effect: () => void | (() => void)): void {
    effect();
  }

  useMemo<T>(factory: () => T): T {
    return factory();
  }

  useState<T>(
    initial: T | (() => T),
  ): [T, (value: T | ((previous: T) => T)) => void] {
    const stateIndex = this.index;
    this.index += 1;

    if (this.states[stateIndex] === undefined) {
      this.states[stateIndex] =
        typeof initial === "function" ? (initial as () => T)() : initial;
    }

    const setState = (value: T | ((previous: T) => T)) => {
      const previous = this.states[stateIndex] as T;
      this.states[stateIndex] =
        typeof value === "function"
          ? (value as (previous: T) => T)(previous)
          : value;
    };

    return [this.states[stateIndex] as T, setState];
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
