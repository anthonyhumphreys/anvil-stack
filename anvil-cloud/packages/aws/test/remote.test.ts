import { describe, expect, it } from "vitest";

import { AwsRemoteReader } from "../src/index.js";

describe("AwsRemoteReader", () => {
  it("reads deployment metadata for remote inspect", async () => {
    const dynamodb = new FakeAwsClient({
      GetItemCommand: {
        Item: deploymentItem(),
      },
    });
    const reader = new AwsRemoteReader({
      deploymentMetadataTable: "deployments",
      dynamodb,
      logs: new FakeAwsClient(),
    });

    await expect(
      reader.inspect({ cell: "notes", environment: "preview" }),
    ).resolves.toMatchObject({
      ok: true,
      adapter: "aws",
      cell: "notes",
      environment: "preview",
      deploymentId: "dep_123",
      runtimeUrl: "https://runtime.example.test",
      manifest: {
        cell: {
          name: "notes",
        },
      },
      resources: {
        stack: "anvil-notes-preview",
        runtimeUrl: "https://runtime.example.test",
        assetsBucket: "assets-bucket",
        logs: "/aws/lambda/anvil-notes-preview",
        deploymentMetadataTable: "deployments",
      },
    });
    expect(dynamodb.commands[0]?.input).toMatchObject({
      TableName: "deployments",
      Key: {
        pk: {
          S: "deployment#notes#preview",
        },
      },
    });
  });

  it("reads CloudWatch logs using the deployment log group", async () => {
    const logs = new FakeAwsClient({
      FilterLogEventsCommand: {
        events: [
          {
            timestamp: Date.UTC(2026, 0, 1),
            message: JSON.stringify({
              level: "info",
              message: "Hello from Lambda",
            }),
          },
        ],
      },
    });
    const reader = new AwsRemoteReader({
      deploymentMetadataTable: "deployments",
      dynamodb: new FakeAwsClient({
        GetItemCommand: {
          Item: deploymentItem(),
        },
      }),
      logs,
    });

    await expect(
      reader.readLogs({ cell: "notes", environment: "preview", limit: 10 }),
    ).resolves.toMatchObject({
      ok: true,
      logs: [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          level: "info",
          message: "Hello from Lambda",
        },
      ],
    });
    expect(logs.commands[0]?.input).toMatchObject({
      logGroupName: "/aws/lambda/anvil-notes-preview",
      limit: 10,
    });
  });
});

class FakeAwsClient {
  readonly commands: Array<{ name: string; input: unknown }> = [];

  constructor(private readonly responses: Record<string, unknown> = {}) {}

  async send(command: { input: unknown; constructor: { name: string } }) {
    this.commands.push({
      name: command.constructor.name,
      input: command.input,
    });

    return this.responses[command.constructor.name] ?? {};
  }
}

function deploymentItem() {
  return {
    pk: { S: "deployment#notes#preview" },
    deploymentId: { S: "dep_123" },
    cell: { S: "notes" },
    environment: { S: "preview" },
    stackName: { S: "anvil-notes-preview" },
    runtimeUrl: { S: "https://runtime.example.test" },
    manifest: {
      S: JSON.stringify({
        schemaVersion: "0.1",
        cell: {
          name: "notes",
          runtime: "nodejs20",
          target: "preview",
        },
        entrypoints: {
          server: "dist/server/index.mjs",
          client: "dist/client/index.html",
        },
        schema: {
          tables: {},
        },
        queries: [],
        mutations: [],
        endpoints: [],
        jobs: [],
        capabilities: {},
      }),
    },
    outputs: {
      S: JSON.stringify({
        RuntimeUrl: "https://runtime.example.test",
        ClientAssetsBucketName: "assets-bucket",
        RuntimeLogGroupName: "/aws/lambda/anvil-notes-preview",
      }),
    },
  };
}
