import { describe, expect, it } from "vitest";

import { ControlPlaneError, createHttpControlPlane } from "../src/index.js";

type StubbedRequest = {
  url: string;
  method: string;
  body?: string;
};

function createStubFetch(
  routes: Record<
    string,
    { status?: number; payload: unknown } | ((request: StubbedRequest) => never)
  >,
) {
  const requests: StubbedRequest[] = [];
  const fetchImpl = async (
    input: string,
    init?: { method?: string; body?: string },
  ) => {
    const url = new URL(input);
    const request: StubbedRequest = {
      url: input,
      method: init?.method ?? "GET",
      ...(init?.body === undefined ? {} : { body: init.body }),
    };

    requests.push(request);

    const route = routes[`${request.method} ${url.pathname}`];

    if (!route) {
      return {
        ok: false,
        status: 404,
        json: async () => ({
          ok: false,
          error: { code: "LOCAL_ROUTE_NOT_FOUND", message: "No route." },
        }),
      };
    }

    if (typeof route === "function") {
      return route(request);
    }

    const status = route.status ?? 200;

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.payload,
    };
  };

  return { fetchImpl, requests };
}

describe("createHttpControlPlane", () => {
  it("describes the local target from /_anvil/inspect", async () => {
    const { fetchImpl } = createStubFetch({
      "GET /_anvil/inspect": {
        payload: {
          ok: true,
          runtimeUrl: "http://localhost:8787",
          manifest: { cell: { name: "notes" } },
        },
      },
    });
    const plane = createHttpControlPlane("http://localhost:8787/", fetchImpl);

    await expect(plane.describe()).resolves.toEqual({
      cell: "notes",
      target: "local",
      runtimeUrl: "http://localhost:8787",
    });
  });

  it("filters and limits logs client-side", async () => {
    const logs = [
      { level: "info", message: "one" },
      { level: "error", message: "two" },
      { level: "error", message: "three" },
      { level: "debug", message: "four" },
    ];
    const { fetchImpl } = createStubFetch({
      "GET /_anvil/logs": { payload: { ok: true, logs } },
    });
    const plane = createHttpControlPlane("http://localhost:8787", fetchImpl);

    await expect(plane.logs()).resolves.toHaveLength(4);
    await expect(plane.logs({ level: "error" })).resolves.toEqual([
      { level: "error", message: "two" },
      { level: "error", message: "three" },
    ]);
    await expect(plane.logs({ level: "error", limit: 1 })).resolves.toEqual([
      { level: "error", message: "three" },
    ]);
  });

  it("lists traces and returns null for missing trace detail", async () => {
    const traces = [{ traceId: "run_1", status: "completed" }];
    const { fetchImpl } = createStubFetch({
      "GET /_anvil/traces": { payload: { ok: true, traces } },
      "GET /_anvil/traces/run_1": {
        payload: { ok: true, trace: traces[0] },
      },
      "GET /_anvil/traces/missing": {
        status: 404,
        payload: {
          ok: false,
          error: { code: "NOT_FOUND", message: "No trace." },
        },
      },
    });
    const plane = createHttpControlPlane("http://localhost:8787", fetchImpl);

    await expect(plane.traces()).resolves.toEqual(traces);
    await expect(plane.trace("run_1")).resolves.toEqual(traces[0]);
    await expect(plane.trace("missing")).resolves.toBeNull();
  });

  it("reads table inspection and dumps rows", async () => {
    const { fetchImpl, requests } = createStubFetch({
      "GET /_anvil/db/tables": {
        payload: {
          ok: true,
          database: { tables: { todos: { rows: 2 } } },
        },
      },
      "GET /_anvil/db/todos": {
        payload: {
          ok: true,
          table: "todos",
          rows: [{ id: "todos_1" }, { id: "todos_2" }],
        },
      },
    });
    const plane = createHttpControlPlane("http://localhost:8787", fetchImpl);

    await expect(plane.dbTables()).resolves.toEqual({ todos: { rows: 2 } });
    await expect(plane.dbDump("todos")).resolves.toEqual([
      { id: "todos_1" },
      { id: "todos_2" },
    ]);
    expect(requests.map((request) => request.url)).toEqual([
      "http://localhost:8787/_anvil/db/tables",
      "http://localhost:8787/_anvil/db/todos",
    ]);
  });

  it("posts service actions and returns the service state", async () => {
    const { fetchImpl, requests } = createStubFetch({
      "POST /_anvil/services/worker/stop": {
        payload: { ok: true, service: { name: "worker", state: "stopped" } },
      },
    });
    const plane = createHttpControlPlane("http://localhost:8787", fetchImpl);

    await expect(plane.serviceAction("worker", "stop")).resolves.toEqual({
      name: "worker",
      state: "stopped",
    });
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "http://localhost:8787/_anvil/services/worker/stop",
    });
  });

  it("returns null for unknown workflow runs and throws typed errors otherwise", async () => {
    const { fetchImpl } = createStubFetch({
      "GET /_anvil/workflows/run_missing": {
        status: 404,
        payload: {
          ok: false,
          error: { code: "NOT_FOUND", message: "No run." },
        },
      },
      "GET /_anvil/services": {
        status: 500,
        payload: {
          ok: false,
          error: { code: "LOCAL_RUNTIME_ERROR", message: "Boom." },
        },
      },
    });
    const plane = createHttpControlPlane("http://localhost:8787", fetchImpl);

    await expect(plane.workflowRun("run_missing")).resolves.toBeNull();
    await expect(plane.services()).rejects.toMatchObject({
      code: "LOCAL_RUNTIME_ERROR",
      status: 500,
    });
  });

  it("wraps network failures in CONTROL_PLANE_UNREACHABLE", async () => {
    const plane = createHttpControlPlane("http://localhost:1", async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const error = await plane.manifest().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ControlPlaneError);
    expect((error as ControlPlaneError).code).toBe("CONTROL_PLANE_UNREACHABLE");
  });
});
