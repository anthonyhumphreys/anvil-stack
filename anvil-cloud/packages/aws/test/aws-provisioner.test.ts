import { describe, expect, it } from "vitest";

import { AwsSdkPreviewProvisioner } from "../src/index.js";
import type { AwsPreviewProvisionerInput } from "../src/index.js";

describe("AwsSdkPreviewProvisioner", () => {
  it("uploads artifacts, applies the stack, uploads client assets, and publishes metadata", async () => {
    const s3 = new FakeAwsClient();
    const cloudFormation = new FakeAwsClient({
      DescribeStacksCommand: {
        Stacks: [
          {
            Outputs: [
              {
                OutputKey: "RuntimeUrl",
                OutputValue: "https://runtime.example.test",
              },
              {
                OutputKey: "ClientAssetsBucketName",
                OutputValue: "assets-bucket",
              },
              {
                OutputKey: "RuntimeLogGroupName",
                OutputValue: "/aws/lambda/anvil-notes-preview",
              },
              {
                OutputKey: "DeploymentMetadataTableName",
                OutputValue: "deployments-table",
              },
              {
                OutputKey: "CellDataTableName",
                OutputValue: "data-table",
              },
            ],
          },
        ],
      },
    });
    const dynamodb = new FakeAwsClient();
    const provisioner = new AwsSdkPreviewProvisioner({
      artifactBucket: "artifact-bucket",
      region: "eu-west-2",
      s3,
      cloudFormation,
      dynamodb,
    });

    const result = await provisioner.provision(createInput());

    expect(result).toMatchObject({
      deploymentId: expect.stringMatching(/^dep_/),
      url: "https://runtime.example.test",
      resources: {
        stack: "anvil-notes-preview",
        runtimeUrl: "https://runtime.example.test",
        assetsBucket: "assets-bucket",
        deploymentMetadataTable: "deployments-table",
        database: "data-table",
      },
    });
    expect(s3.commandNames()).toEqual([
      "PutObjectCommand",
      "PutObjectCommand",
      "PutObjectCommand",
      "PutObjectCommand",
    ]);
    expect(s3.commands[0]?.input).toMatchObject({
      Bucket: "artifact-bucket",
      Key: "notes/server.zip",
      ContentType: "application/zip",
    });
    expect(s3.commands[3]?.input).toMatchObject({
      Bucket: "assets-bucket",
      Key: "notes/client/index.html",
      ContentType: "text/html",
    });
    expect(cloudFormation.commandNames()).toEqual([
      "CreateStackCommand",
      "DescribeStacksCommand",
    ]);
    expect(cloudFormation.commands[0]?.input).toMatchObject({
      StackName: "anvil-notes-preview",
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      Parameters: [
        {
          ParameterKey: "ServerBundleBucket",
          ParameterValue: "artifact-bucket",
        },
        {
          ParameterKey: "ServerBundleKey",
          ParameterValue: "notes/server.zip",
        },
      ],
    });
    expect(dynamodb.commandNames()).toEqual(["PutItemCommand"]);
    expect(dynamodb.commands[0]?.input).toMatchObject({
      TableName: "deployments-table",
      Item: {
        pk: {
          S: "deployment#notes#preview",
        },
        cell: {
          S: "notes",
        },
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

    return this.responses[command.constructor.name] ?? {};
  }

  commandNames(): string[] {
    return this.commands.map((command) => command.name);
  }
}

function createInput(): AwsPreviewProvisionerInput {
  return {
    environment: "preview",
    manifest: {
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
      capabilities: {
        database: true,
      },
    },
    plan: {
      schemaVersion: "0.1",
      adapter: "aws",
      environment: "preview",
      cell: "notes",
      changes: [],
      warnings: [],
    },
    template: {
      AWSTemplateFormatVersion: "2010-09-09",
      Description: "test",
      Parameters: {},
      Resources: {},
      Outputs: {},
    },
    artifacts: {
      lambda: {
        key: "notes/server.zip",
        body: new Uint8Array([1, 2, 3]),
        contentType: "application/zip",
      },
      template: {
        key: "notes/template.json",
        body: new Uint8Array([4]),
        contentType: "application/json",
      },
      manifest: {
        key: "notes/manifest.json",
        body: new Uint8Array([5]),
        contentType: "application/json",
      },
      clientAssets: [
        {
          key: "notes/client/index.html",
          body: new Uint8Array([6]),
          contentType: "text/html",
        },
      ],
    },
  };
}
