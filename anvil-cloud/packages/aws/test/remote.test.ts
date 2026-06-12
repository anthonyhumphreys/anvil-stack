import { describe, expect, it } from "vitest";

import { AwsRemoteReader, AwsRemoteReaderError } from "../src/index.js";

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
      updatedAt: "2026-01-01T00:00:00.000Z",
      runtimeUrl: "https://runtime.example.test",
      manifest: {
        cell: {
          name: "notes",
        },
      },
      artifacts: {
        lambda: {
          key: "notes/server-abc123.zip",
          sha256: "abc123",
        },
        clientAssets: [
          {
            key: "notes/client/index.html",
            cacheControl: "no-cache",
          },
        ],
      },
      resources: {
        stack: "anvil-notes-preview",
        runtimeUrl: "https://runtime.example.test",
        assetsBucket: "assets-bucket",
        logs: "/aws/lambda/anvil-notes-preview",
        events: "events-bus",
        jobs: "https://sqs.example.test/jobs",
        jobDeadLetterQueue: "https://sqs.example.test/jobs-dlq",
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

  it("keeps remote inspect backward-compatible with metadata written before artifact summaries", async () => {
    const item = deploymentItem();
    delete item.artifacts;
    const reader = new AwsRemoteReader({
      deploymentMetadataTable: "deployments",
      dynamodb: new FakeAwsClient({
        GetItemCommand: {
          Item: item,
        },
      }),
      logs: new FakeAwsClient(),
    });

    await expect(
      reader.inspect({ cell: "notes", environment: "preview" }),
    ).resolves.not.toHaveProperty("artifacts");
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

  it("paginates CloudWatch logs up to the requested limit", async () => {
    const logs = new SequenceAwsClient({
      FilterLogEventsCommand: [
        {
          events: [
            {
              timestamp: Date.UTC(2026, 0, 1, 0, 0, 1),
              message: JSON.stringify({
                level: "info",
                message: "first",
              }),
            },
          ],
          nextToken: "page-2",
        },
        {
          events: [
            {
              timestamp: Date.UTC(2026, 0, 1, 0, 0, 2),
              message: JSON.stringify({
                level: "warn",
                message: "second",
              }),
            },
          ],
        },
      ],
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
      reader.readLogs({
        cell: "notes",
        environment: "preview",
        sinceMs: 123,
        limit: 2,
      }),
    ).resolves.toMatchObject({
      ok: true,
      logs: [
        {
          level: "info",
          message: "first",
        },
        {
          level: "warn",
          message: "second",
        },
      ],
    });
    expect(logs.commandNames()).toEqual([
      "FilterLogEventsCommand",
      "FilterLogEventsCommand",
    ]);
    expect(logs.commands[0]?.input).toMatchObject({
      logGroupName: "/aws/lambda/anvil-notes-preview",
      startTime: 123,
      limit: 2,
    });
    expect(logs.commands[1]?.input).toMatchObject({
      nextToken: "page-2",
      limit: 1,
    });
  });

  it("does not fetch another CloudWatch page after reaching the requested limit", async () => {
    const logs = new SequenceAwsClient({
      FilterLogEventsCommand: [
        {
          events: [
            {
              timestamp: Date.UTC(2026, 0, 1),
              message: "first",
            },
          ],
          nextToken: "unused-page",
        },
      ],
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
      reader.readLogs({ cell: "notes", environment: "preview", limit: 1 }),
    ).resolves.toMatchObject({
      logs: [
        {
          message: "first",
        },
      ],
    });
    expect(logs.commandNames()).toEqual(["FilterLogEventsCommand"]);
  });

  it("throws a typed error when deployment metadata is missing", async () => {
    const reader = new AwsRemoteReader({
      deploymentMetadataTable: "deployments",
      dynamodb: new FakeAwsClient({
        GetItemCommand: {},
      }),
      logs: new FakeAwsClient(),
    });

    let error: unknown;

    try {
      await reader.inspect({ cell: "notes", environment: "preview" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AwsRemoteReaderError);
    expect(error).toMatchObject({
      code: "AWS_DEPLOYMENT_METADATA_NOT_FOUND",
      details: {
        cell: "notes",
        environment: "preview",
        table: "deployments",
      },
    });
  });

  it("throws a typed error when the deployment metadata read fails", async () => {
    const failure = new Error("not allowed");

    failure.name = "AccessDeniedException";
    const reader = new AwsRemoteReader({
      deploymentMetadataTable: "deployments",
      dynamodb: new FakeAwsClient({
        GetItemCommand: failure,
      }),
      logs: new FakeAwsClient(),
    });

    let error: unknown;

    try {
      await reader.inspect({ cell: "notes", environment: "preview" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AwsRemoteReaderError);
    expect(error).toMatchObject({
      code: "AWS_REMOTE_READ_FAILED",
      details: {
        operation: "dynamodb:GetItem",
        cell: "notes",
        environment: "preview",
        table: "deployments",
        cause: {
          name: "AccessDeniedException",
          message: "not allowed",
        },
      },
    });
  });

  it("throws a typed error when the CloudWatch log read fails", async () => {
    const failure = new Error("rate limited");

    failure.name = "ThrottlingException";
    const reader = new AwsRemoteReader({
      deploymentMetadataTable: "deployments",
      dynamodb: new FakeAwsClient({
        GetItemCommand: {
          Item: deploymentItem(),
        },
      }),
      logs: new FakeAwsClient({
        FilterLogEventsCommand: failure,
      }),
    });

    let error: unknown;

    try {
      await reader.readLogs({ cell: "notes", environment: "preview" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AwsRemoteReaderError);
    expect(error).toMatchObject({
      code: "AWS_REMOTE_READ_FAILED",
      details: {
        operation: "cloudwatch-logs:FilterLogEvents",
        cell: "notes",
        environment: "preview",
        logGroupName: "/aws/lambda/anvil-notes-preview",
        cause: {
          name: "ThrottlingException",
          message: "rate limited",
        },
      },
    });
  });

  it("throws a typed error when deployment metadata is malformed", async () => {
    const reader = new AwsRemoteReader({
      deploymentMetadataTable: "deployments",
      dynamodb: new FakeAwsClient({
        GetItemCommand: {
          Item: {
            ...deploymentItem(),
            manifest: { S: "not json" },
          },
        },
      }),
      logs: new FakeAwsClient(),
    });

    let error: unknown;

    try {
      await reader.inspect({ cell: "notes", environment: "preview" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AwsRemoteReaderError);
    expect(error).toMatchObject({
      code: "AWS_DEPLOYMENT_METADATA_INVALID",
      details: {
        attribute: "manifest",
      },
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

    const response = this.responses[command.constructor.name];

    if (response instanceof Error) {
      throw response;
    }

    return response ?? {};
  }
}

class SequenceAwsClient {
  readonly commands: Array<{ name: string; input: unknown }> = [];

  constructor(private readonly responses: Record<string, unknown[]>) {}

  async send(command: { input: unknown; constructor: { name: string } }) {
    this.commands.push({
      name: command.constructor.name,
      input: command.input,
    });

    return this.responses[command.constructor.name]?.shift() ?? {};
  }

  commandNames(): string[] {
    return this.commands.map((command) => command.name);
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
    updatedAt: { S: "2026-01-01T00:00:00.000Z" },
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
        CellEventBusName: "events-bus",
        CellJobQueueUrl: "https://sqs.example.test/jobs",
        CellJobDeadLetterQueueUrl: "https://sqs.example.test/jobs-dlq",
      }),
    },
    artifacts: {
      S: JSON.stringify({
        lambda: {
          key: "notes/server-abc123.zip",
          bytes: 123,
          sha256: "abc123",
        },
        template: {
          key: "notes/template.json",
          bytes: 456,
          sha256: "def456",
        },
        manifest: {
          key: "notes/manifest.json",
          bytes: 789,
          sha256: "fed789",
        },
        clientAssets: [
          {
            key: "notes/client/index.html",
            bytes: 42,
            contentType: "text/html",
            sha256: "client123",
            cacheControl: "no-cache",
          },
        ],
      }),
    },
  };
}
