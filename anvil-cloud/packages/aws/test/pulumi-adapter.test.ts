import { describe, expect, it } from "vitest";
import {
  createAwsPulumiPlan,
  createPulumiMappings,
  deterministicName,
  type DeployInput,
} from "../src/index.js";

const input: DeployInput = {
  appName: "todo-api",
  stage: "dev",
  cellGraph: {
    schemaVersion: "0.1",
    appName: "todo-api",
    cells: [{ name: "todo-api", runtime: "nodejs20" }],
    httpRoutes: [
      {
        cell: "todo-api",
        method: "GET",
        path: "/todos",
        handler: "getTodos",
        auth: { mode: "required" },
      },
    ],
    functions: [
      {
        cell: "todo-api",
        name: "getTodos",
        runtime: "nodejs20",
        handler: "src/getTodos.handler",
      },
    ],
    tables: [{ cell: "todo-api", name: "todos", access: "read-write" }],
    secrets: [{ cell: "todo-api", name: "API_TOKEN" }],
    permissions: [
      {
        from: "getTodos",
        action: "read-write",
        to: "todos",
        targetKind: "table",
      },
      {
        from: "getTodos",
        action: "read",
        to: "API_TOKEN",
        targetKind: "secret",
      },
    ],
  },
};

describe("AWS Pulumi adapter mapping", () => {
  it("keeps deterministic stage-aware names", () => {
    expect(deterministicName("Todo API", "Dev_01")).toBe("todo-api-dev-01");
  });

  it("maps Anvil capabilities to AWS Pulumi resource types", () => {
    expect(createPulumiMappings(input)).toEqual(
      expect.arrayContaining([
        {
          anvil: "HTTP route GET /todos",
          type: "aws:apigatewayv2/api:Api",
          name: "todo-api-dev-http",
        },
        {
          anvil: "Function getTodos",
          type: "aws:lambda/function:Function",
          name: "todo-api-dev-getTodos",
        },
        {
          anvil: "Table todos",
          type: "aws:dynamodb/table:Table",
          name: "todo-api-dev-todos",
        },
        {
          anvil: "Secret API_TOKEN",
          type: "aws:ssm/parameter:Parameter",
          name: "/todo-api-dev/secrets/API_TOKEN",
        },
        {
          anvil: "Permissions for getTodos",
          type: "aws:iam/rolePolicy:RolePolicy",
          name: "todo-api-dev-getTodos-policy",
        },
      ]),
    );
  });

  it("emits Anvil-first plan changes including permissions", () => {
    expect(createAwsPulumiPlan(input).changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ concept: "HTTP route", name: "GET /todos" }),
        expect.objectContaining({
          concept: "Permission",
          name: "getTodos can read/write todos",
        }),
        expect.objectContaining({
          concept: "Permission",
          name: "getTodos can read API_TOKEN",
        }),
      ]),
    );
  });

  it("emits stable review metadata for JSON plan diffs", () => {
    const plan = createAwsPulumiPlan(input);

    expect(plan.review).toMatchObject({
      stableId: "aws:todo-api:dev:deploy",
      operation: "deploy",
      summary: {
        creates: plan.changes.length,
        deletes: 0,
        total: plan.changes.length,
      },
      rollback: {
        supported: false,
        strategy: "redeploy-or-remove",
        commands: [
          "anvil-cloud deploy --stage dev --adapter aws --json",
          "anvil-cloud remove --stage dev --adapter aws --json",
        ],
      },
    });
    expect(plan.review.changeSet.map((change) => change.id)).toEqual([
      "create:cell:todo-api",
      "create:function:gettodos",
      "create:http-route:get-todos",
      "create:permission:gettodos-can-read-api-token",
      "create:permission:gettodos-can-read-write-todos",
      "create:secret:api-token",
      "create:table:todos",
    ]);
    expect(plan.review.capabilityDiffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "table:todos",
          action: "add",
          capability: "table",
        }),
        expect.objectContaining({
          id: "secret:api-token",
          action: "add",
          capability: "secret",
        }),
      ]),
    );
    expect(plan.review.cost.drivers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "api-gateway" }),
        expect.objectContaining({ id: "lambda" }),
        expect.objectContaining({ id: "dynamodb" }),
        expect.objectContaining({ id: "ssm" }),
      ]),
    );
    expect(plan.review.approvalGates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "data-resource-review",
          required: true,
        }),
        expect.objectContaining({
          id: "permission-review",
          required: true,
        }),
      ]),
    );
  });

  it("diffs current graph capabilities against a previous graph", () => {
    const plan = createAwsPulumiPlan({
      ...input,
      previousCellGraph: {
        ...input.cellGraph,
        tables: [],
        secrets: [],
        permissions: [],
      },
    });

    expect(plan.review.capabilityDiffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "function:gettodos",
          action: "unchanged",
        }),
        expect.objectContaining({ id: "table:todos", action: "add" }),
        expect.objectContaining({ id: "secret:api-token", action: "add" }),
      ]),
    );
  });

  it("keeps review change ids stable when Cell graph arrays are reordered", () => {
    const baseline = createAwsPulumiPlan(input);
    const reordered = createAwsPulumiPlan({
      ...input,
      cellGraph: {
        ...input.cellGraph,
        httpRoutes: [...input.cellGraph.httpRoutes].reverse(),
        functions: [...input.cellGraph.functions].reverse(),
        tables: [...input.cellGraph.tables].reverse(),
        secrets: [...input.cellGraph.secrets].reverse(),
        permissions: [...input.cellGraph.permissions].reverse(),
      },
    });

    expect(reordered.changes.map((change) => change.name)).toEqual(
      baseline.changes.map((change) => change.name),
    );
    expect(reordered.review.changeSet.map((change) => change.id)).toEqual(
      baseline.review.changeSet.map((change) => change.id),
    );
    expect(reordered.review.capabilityDiffs.map((diff) => diff.id)).toEqual(
      baseline.review.capabilityDiffs.map((diff) => diff.id),
    );
  });

  it("requires approval for remove plans", () => {
    const plan = createAwsPulumiPlan(input, true);

    expect(plan.review).toMatchObject({
      stableId: "aws:todo-api:dev:remove",
      operation: "remove",
      summary: {
        creates: 0,
        deletes: plan.changes.length,
      },
      rollback: {
        strategy: "manual-cleanup",
      },
      approvalGates: [
        expect.objectContaining({
          id: "destructive-change-review",
          required: true,
          severity: "block",
        }),
      ],
    });
  });
});
