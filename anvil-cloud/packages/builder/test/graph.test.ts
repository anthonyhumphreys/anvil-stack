import { describe, expect, it } from "vitest";
import { createAnvilCellGraph, validateAnvilCellGraph, type CellManifest } from "../src/index.js";

const manifest: CellManifest = {
  schemaVersion: "0.1",
  cell: { name: "todo-api", runtime: "nodejs20", target: "dev" },
  entrypoints: { server: "dist/server/index.mjs", client: "dist/client/index.html" },
  schema: { tables: { todos: { fields: {} } } },
  queries: [],
  mutations: [],
  endpoints: [{ name: "getTodos", method: "GET", path: "/todos", auth: { mode: "required" } }],
  jobs: [],
  workflows: [],
  services: [],
  agents: {},
  capabilities: { secrets: ["API_TOKEN"] },
};

describe("Anvil Cell graph", () => {
  it("compiles manifest intent into a provider-neutral graph", () => {
    const graph = createAnvilCellGraph(manifest);

    expect(graph).toMatchObject({
      appName: "todo-api",
      httpRoutes: [{ method: "GET", path: "/todos", handler: "getTodos" }],
      functions: [{ name: "getTodos", handler: "endpoints.getTodos.handler" }],
      tables: [{ name: "todos", access: "read-write" }],
      secrets: [{ name: "API_TOKEN" }],
      permissions: expect.arrayContaining([
        { from: "getTodos", action: "read-write", to: "todos", targetKind: "table" },
        { from: "getTodos", action: "read", to: "API_TOKEN", targetKind: "secret" },
      ]),
    });
    expect(validateAnvilCellGraph(graph)).toEqual([]);
  });

  it("validates dangling route handlers", () => {
    const graph = createAnvilCellGraph(manifest);
    graph.httpRoutes[0]!.handler = "missing";

    expect(validateAnvilCellGraph(graph)).toEqual([
      expect.objectContaining({ code: "GRAPH_ROUTE_HANDLER_MISSING" }),
    ]);
  });
});
