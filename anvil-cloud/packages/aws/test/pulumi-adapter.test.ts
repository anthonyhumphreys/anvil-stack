import { describe, expect, it } from "vitest";
import { createAwsPulumiPlan, createPulumiMappings, deterministicName, type DeployInput } from "../src/index.js";

const input: DeployInput = {
  appName: "todo-api",
  stage: "dev",
  cellGraph: {
    schemaVersion: "0.1",
    appName: "todo-api",
    cells: [{ name: "todo-api", runtime: "nodejs20" }],
    httpRoutes: [{ cell: "todo-api", method: "GET", path: "/todos", handler: "getTodos", auth: { mode: "required" } }],
    functions: [{ cell: "todo-api", name: "getTodos", runtime: "nodejs20", handler: "src/getTodos.handler" }],
    tables: [{ cell: "todo-api", name: "todos", access: "read-write" }],
    secrets: [{ cell: "todo-api", name: "API_TOKEN" }],
    permissions: [
      { from: "getTodos", action: "read-write", to: "todos", targetKind: "table" },
      { from: "getTodos", action: "read", to: "API_TOKEN", targetKind: "secret" },
    ],
  },
};

describe("AWS Pulumi adapter mapping", () => {
  it("keeps deterministic stage-aware names", () => {
    expect(deterministicName("Todo API", "Dev_01")).toBe("todo-api-dev-01");
  });

  it("maps Anvil capabilities to AWS Pulumi resource types", () => {
    expect(createPulumiMappings(input)).toEqual(expect.arrayContaining([
      { anvil: "HTTP route GET /todos", type: "aws:apigatewayv2/api:Api", name: "todo-api-dev-http" },
      { anvil: "Function getTodos", type: "aws:lambda/function:Function", name: "todo-api-dev-getTodos" },
      { anvil: "Table todos", type: "aws:dynamodb/table:Table", name: "todo-api-dev-todos" },
      { anvil: "Secret API_TOKEN", type: "aws:ssm/parameter:Parameter", name: "/todo-api-dev/secrets/API_TOKEN" },
      { anvil: "Permissions for getTodos", type: "aws:iam/rolePolicy:RolePolicy", name: "todo-api-dev-getTodos-policy" },
    ]));
  });

  it("emits Anvil-first plan changes including permissions", () => {
    expect(createAwsPulumiPlan(input).changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ concept: "HTTP route", name: "GET /todos" }),
      expect.objectContaining({ concept: "Permission", name: "getTodos can read/write todos" }),
      expect.objectContaining({ concept: "Permission", name: "getTodos can read API_TOKEN" }),
    ]));
  });
});
