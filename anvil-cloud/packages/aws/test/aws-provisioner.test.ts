import { describe, expect, it } from "vitest";

import {
  AwsPreviewDestroyError,
  AwsPreviewProvisioningError,
  AwsSdkPreviewDestroyer,
  AwsSdkPreviewProvisioner,
  awsPreviewStackNameFor,
} from "../src/index.js";
import type { AwsPreviewProvisionerInput } from "../src/index.js";

describe("AwsSdkPreviewProvisioner", () => {
  it("derives stable preview stack names", () => {
    expect(awsPreviewStackNameFor("Notes App", "Preview", "Anvil_Dev")).toBe(
      "anvil-dev-notes-app-preview",
    );
  });

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
              {
                OutputKey: "CellEventBusName",
                OutputValue: "events-bus",
              },
              {
                OutputKey: "CellJobQueueUrl",
                OutputValue: "https://sqs.example.test/jobs",
              },
              {
                OutputKey: "CellJobDeadLetterQueueUrl",
                OutputValue: "https://sqs.example.test/jobs-dlq",
              },
              {
                OutputKey: "WorkflowSyncNotesStateMachineArn",
                OutputValue:
                  "arn:aws:states:eu-west-2:123456789012:stateMachine:syncNotes",
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
      previewName: "default",
      url: "https://runtime.example.test",
      resources: {
        stack: "anvil-notes-preview",
        runtimeUrl: "https://runtime.example.test",
        assetsBucket: "assets-bucket",
        deploymentMetadataTable: "deployments-table",
        deploymentMetadataKey: "deployment#notes#preview",
        database: "data-table",
        events: "events-bus",
        jobs: "https://sqs.example.test/jobs",
        jobDeadLetterQueue: "https://sqs.example.test/jobs-dlq",
        "workflow:syncNotes":
          "arn:aws:states:eu-west-2:123456789012:stateMachine:syncNotes",
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
      ServerSideEncryption: "AES256",
    });
    expect(s3.commands[3]?.input).toMatchObject({
      Bucket: "assets-bucket",
      Key: "notes/client/index.html",
      ContentType: "text/html",
      ServerSideEncryption: "AES256",
      CacheControl: "no-cache",
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
        previewName: {
          S: "default",
        },
      },
    });
    expect(
      JSON.parse(
        stringAttribute(dynamodb.commands[0]?.input, "Item.artifacts.S"),
      ),
    ).toEqual({
      lambda: {
        key: "notes/server.zip",
        bytes: 3,
        sha256: "hash-lambda",
      },
      template: {
        key: "notes/template.json",
        bytes: 1,
        sha256: "hash-template",
      },
      manifest: {
        key: "notes/manifest.json",
        bytes: 1,
        sha256: "hash-manifest",
      },
      clientAssets: [
        {
          key: "notes/client/index.html",
          bytes: 1,
          contentType: "text/html",
          sha256: "hash-client-index",
          cacheControl: "no-cache",
        },
      ],
    });
  });

  it("uses named preview stack and metadata keys", async () => {
    const cloudFormation = new FakeAwsClient({
      DescribeStacksCommand: {
        Stacks: [
          {
            Outputs: [
              {
                OutputKey: "RuntimeUrl",
                OutputValue: "https://branch.example.test",
              },
              {
                OutputKey: "ClientAssetsBucketName",
                OutputValue: "assets-bucket",
              },
              {
                OutputKey: "RuntimeLogGroupName",
                OutputValue: "/aws/lambda/anvil-notes-preview-branch",
              },
              {
                OutputKey: "DeploymentMetadataTableName",
                OutputValue: "deployments-table",
              },
            ],
          },
        ],
      },
    });
    const dynamodb = new FakeAwsClient();
    const provisioner = new AwsSdkPreviewProvisioner({
      artifactBucket: "artifact-bucket",
      cloudFormation,
      dynamodb,
      s3: new FakeAwsClient(),
    });

    const result = await provisioner.provision(
      createInput({ previewName: "Feature/Branch" }),
    );

    expect(result).toMatchObject({
      previewName: "feature-branch",
      resources: {
        stack: "anvil-notes-preview-feature-branch",
        deploymentMetadataKey: "deployment#notes#preview#feature-branch",
      },
    });
    expect(cloudFormation.commands[0]?.input).toMatchObject({
      StackName: "anvil-notes-preview-feature-branch",
    });
    expect(dynamodb.commands[0]?.input).toMatchObject({
      Item: {
        pk: { S: "deployment#notes#preview#feature-branch" },
        previewName: { S: "feature-branch" },
      },
    });
  });

  it("includes recent CloudFormation failure events when a stack fails", async () => {
    const cloudFormation = new FakeAwsClient({
      DescribeStacksCommand: {
        Stacks: [
          {
            StackStatus: "CREATE_FAILED",
          },
        ],
      },
      DescribeStackEventsCommand: {
        StackEvents: [
          {
            LogicalResourceId: "RuntimeFunction",
            ResourceStatus: "CREATE_FAILED",
            ResourceStatusReason:
              "The runtime role is missing lambda:CreateFunction permissions.",
            ResourceType: "AWS::Lambda::Function",
          },
          {
            LogicalResourceId: "RuntimeRole",
            ResourceStatus: "CREATE_COMPLETE",
            ResourceType: "AWS::IAM::Role",
          },
        ],
      },
    });
    const provisioner = new AwsSdkPreviewProvisioner({
      artifactBucket: "artifact-bucket",
      s3: new FakeAwsClient(),
      cloudFormation,
      dynamodb: new FakeAwsClient(),
      stackPollDelayMs: 0,
    });

    let error: unknown;

    try {
      await provisioner.provision(createInput());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AwsPreviewProvisioningError);
    expect(error).toMatchObject({
      name: "AwsPreviewProvisioningError",
      code: "AWS_STACK_FAILED",
      details: {
        stackName: "anvil-notes-preview",
        status: "CREATE_FAILED",
        events: [
          {
            logicalResourceId: "RuntimeFunction",
            resourceStatus: "CREATE_FAILED",
            resourceType: "AWS::Lambda::Function",
            reason:
              "The runtime role is missing lambda:CreateFunction permissions.",
          },
        ],
      },
    });
    expect(cloudFormation.commandNames()).toContain(
      "DescribeStackEventsCommand",
    );
  });

  it("throws a typed timeout when the stack never reaches a terminal status", async () => {
    const cloudFormation = new FakeAwsClient({
      DescribeStacksCommand: {
        Stacks: [
          {
            StackStatus: "UPDATE_IN_PROGRESS",
          },
        ],
      },
    });
    const provisioner = new AwsSdkPreviewProvisioner({
      artifactBucket: "artifact-bucket",
      s3: new FakeAwsClient(),
      cloudFormation,
      dynamodb: new FakeAwsClient(),
      stackPollDelayMs: 0,
      stackMaxPollAttempts: 2,
    });

    let error: unknown;

    try {
      await provisioner.provision(createInput());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AwsPreviewProvisioningError);
    expect(error).toMatchObject({
      code: "AWS_STACK_TIMEOUT",
      details: {
        stackName: "anvil-notes-preview",
        lastStatus: "UPDATE_IN_PROGRESS",
        attempts: 2,
        delayMs: 0,
      },
    });
    expect(cloudFormation.commandNames()).toEqual([
      "CreateStackCommand",
      "DescribeStacksCommand",
      "DescribeStacksCommand",
    ]);
  });

  it("throws a typed error when a required CloudFormation output is missing", async () => {
    const cloudFormation = new FakeAwsClient({
      DescribeStacksCommand: {
        Stacks: [
          {
            Outputs: [
              {
                OutputKey: "RuntimeUrl",
                OutputValue: "https://runtime.example.test",
              },
            ],
          },
        ],
      },
    });
    const provisioner = new AwsSdkPreviewProvisioner({
      artifactBucket: "artifact-bucket",
      s3: new FakeAwsClient(),
      cloudFormation,
      dynamodb: new FakeAwsClient(),
    });

    let error: unknown;

    try {
      await provisioner.provision(createInput());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AwsPreviewProvisioningError);
    expect(error).toMatchObject({
      code: "AWS_STACK_OUTPUT_MISSING",
      details: {
        stackName: "anvil-notes-preview",
        output: "ClientAssetsBucketName",
      },
    });
  });

  it("throws a typed operation error when an artifact upload fails", async () => {
    const failure = new Error("put denied");

    failure.name = "AccessDenied";
    const provisioner = new AwsSdkPreviewProvisioner({
      artifactBucket: "artifact-bucket",
      s3: new FakeAwsClient({
        PutObjectCommand: failure,
      }),
      cloudFormation: new FakeAwsClient(),
      dynamodb: new FakeAwsClient(),
    });

    let error: unknown;

    try {
      await provisioner.provision(createInput());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AwsPreviewProvisioningError);
    expect(error).toMatchObject({
      code: "AWS_PROVISIONING_OPERATION_FAILED",
      details: {
        operation: "s3:PutObject",
        bucket: "artifact-bucket",
        cause: {
          name: "AccessDenied",
          message: "put denied",
        },
      },
    });
  });

  it("throws a typed operation error when publishing deployment metadata fails", async () => {
    const failure = new Error("write capacity exceeded");

    failure.name = "ProvisionedThroughputExceededException";
    const provisioner = new AwsSdkPreviewProvisioner({
      artifactBucket: "artifact-bucket",
      s3: new FakeAwsClient(),
      cloudFormation: new FakeAwsClient({
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
              ],
            },
          ],
        },
      }),
      dynamodb: new FakeAwsClient({
        PutItemCommand: failure,
      }),
    });

    let error: unknown;

    try {
      await provisioner.provision(createInput());
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AwsPreviewProvisioningError);
    expect(error).toMatchObject({
      code: "AWS_PROVISIONING_OPERATION_FAILED",
      details: {
        operation: "dynamodb:PutItem",
        stackName: "anvil-notes-preview",
        table: "deployments-table",
        cause: {
          name: "ProvisionedThroughputExceededException",
          message: "write capacity exceeded",
        },
      },
    });
  });
});

describe("AwsSdkPreviewDestroyer", () => {
  it("deletes the computed preview stack and waits for completion", async () => {
    const cloudFormation = new SequenceAwsClient({
      DescribeStacksCommand: [
        {
          Stacks: [
            {
              StackStatus: "CREATE_COMPLETE",
            },
          ],
        },
        {
          Stacks: [
            {
              StackStatus: "DELETE_COMPLETE",
            },
          ],
        },
      ],
      DeleteStackCommand: [{}],
    });
    const destroyer = new AwsSdkPreviewDestroyer({
      cloudFormation,
      stackPollDelayMs: 0,
    });

    await expect(
      destroyer.destroy({ cell: "notes", environment: "preview" }),
    ).resolves.toEqual({
      ok: true,
      adapter: "aws",
      cell: "notes",
      environment: "preview",
      previewName: "default",
      stackName: "anvil-notes-preview",
      deleted: true,
      metadataDeleted: false,
      emptiedBuckets: [],
    });
    expect(cloudFormation.commandNames()).toEqual([
      "DescribeStacksCommand",
      "DeleteStackCommand",
      "DescribeStacksCommand",
    ]);
  });

  it("returns deleted false when the preview stack is already absent", async () => {
    const cloudFormation = new SequenceAwsClient({
      DescribeStacksCommand: [stackNotFoundError()],
    });
    const destroyer = new AwsSdkPreviewDestroyer({
      cloudFormation,
      stackPollDelayMs: 0,
    });

    await expect(
      destroyer.destroy({ cell: "notes", environment: "preview" }),
    ).resolves.toMatchObject({
      ok: true,
      stackName: "anvil-notes-preview",
      deleted: false,
      metadataDeleted: false,
      emptiedBuckets: [],
    });
    expect(cloudFormation.commandNames()).toEqual(["DescribeStacksCommand"]);
  });

  it("deletes deployment metadata when a metadata table is configured", async () => {
    const cloudFormation = new SequenceAwsClient({
      DescribeStacksCommand: [
        {
          Stacks: [
            {
              StackStatus: "CREATE_COMPLETE",
            },
          ],
        },
        {
          Stacks: [
            {
              StackStatus: "DELETE_COMPLETE",
            },
          ],
        },
      ],
      DeleteStackCommand: [{}],
    });
    const dynamodb = new FakeAwsClient();
    const destroyer = new AwsSdkPreviewDestroyer({
      cloudFormation,
      dynamodb,
      deploymentMetadataTable: "deployments",
      stackPollDelayMs: 0,
    });

    await expect(
      destroyer.destroy({ cell: "notes", environment: "preview" }),
    ).resolves.toMatchObject({
      ok: true,
      deleted: true,
      metadataDeleted: true,
      emptiedBuckets: [],
    });
    expect(dynamodb.commandNames()).toEqual(["DeleteItemCommand"]);
    expect(dynamodb.commands[0]?.input).toMatchObject({
      TableName: "deployments",
      Key: {
        pk: {
          S: "deployment#notes#preview",
        },
      },
    });
  });

  it("deletes stale deployment metadata when the preview stack is already absent", async () => {
    const cloudFormation = new SequenceAwsClient({
      DescribeStacksCommand: [stackNotFoundError()],
    });
    const dynamodb = new FakeAwsClient();
    const destroyer = new AwsSdkPreviewDestroyer({
      cloudFormation,
      dynamodb,
      deploymentMetadataTable: "deployments",
      stackPollDelayMs: 0,
    });

    await expect(
      destroyer.destroy({ cell: "notes", environment: "preview" }),
    ).resolves.toMatchObject({
      ok: true,
      deleted: false,
      metadataDeleted: true,
      emptiedBuckets: [],
    });
    expect(dynamodb.commandNames()).toEqual(["DeleteItemCommand"]);
  });

  it("ignores missing stale deployment metadata when the preview stack is already absent", async () => {
    const missingTable = new Error("Requested resource not found");

    missingTable.name = "ResourceNotFoundException";

    const cloudFormation = new SequenceAwsClient({
      DescribeStacksCommand: [stackNotFoundError()],
    });
    const dynamodb = new FakeAwsClient({
      DeleteItemCommand: missingTable,
    });
    const destroyer = new AwsSdkPreviewDestroyer({
      cloudFormation,
      dynamodb,
      deploymentMetadataTable: "deployments",
      stackPollDelayMs: 0,
    });

    await expect(
      destroyer.destroy({ cell: "notes", environment: "preview" }),
    ).resolves.toMatchObject({
      ok: true,
      deleted: false,
      metadataDeleted: false,
      emptiedBuckets: [],
    });
    expect(dynamodb.commandNames()).toEqual(["DeleteItemCommand"]);
  });

  it("empties stack-owned S3 buckets before deleting the preview stack", async () => {
    const cloudFormation = new SequenceAwsClient({
      DescribeStacksCommand: [
        {
          Stacks: [
            {
              StackStatus: "CREATE_COMPLETE",
              Outputs: [
                {
                  OutputKey: "ClientAssetsBucketName",
                  OutputValue: "assets-bucket",
                },
                {
                  OutputKey: "CellFilesBucketName",
                  OutputValue: "files-bucket",
                },
              ],
            },
          ],
        },
        {
          Stacks: [
            {
              StackStatus: "DELETE_COMPLETE",
            },
          ],
        },
      ],
      DeleteStackCommand: [{}],
    });
    const s3 = new SequenceAwsClient({
      ListObjectsV2Command: [
        {
          Contents: [{ Key: "index.html" }, { Key: "assets/app.js" }],
          NextContinuationToken: "next-page",
        },
        {
          Contents: [{ Key: "assets/app.css" }],
        },
        {
          Contents: [{ Key: "uploads/file.txt" }],
        },
      ],
      DeleteObjectsCommand: [{}, {}, {}],
    });
    const destroyer = new AwsSdkPreviewDestroyer({
      cloudFormation,
      s3,
      stackPollDelayMs: 0,
    });

    await expect(
      destroyer.destroy({ cell: "notes", environment: "preview" }),
    ).resolves.toMatchObject({
      ok: true,
      deleted: true,
      emptiedBuckets: ["assets-bucket", "files-bucket"],
    });
    expect(s3.commandNames()).toEqual([
      "ListObjectsV2Command",
      "DeleteObjectsCommand",
      "ListObjectsV2Command",
      "DeleteObjectsCommand",
      "ListObjectsV2Command",
      "DeleteObjectsCommand",
    ]);
    expect(s3.commands[0]?.input).toMatchObject({
      Bucket: "assets-bucket",
    });
    expect(s3.commands[1]?.input).toMatchObject({
      Bucket: "assets-bucket",
      Delete: {
        Objects: [{ Key: "index.html" }, { Key: "assets/app.js" }],
        Quiet: true,
      },
    });
    expect(s3.commands[2]?.input).toMatchObject({
      Bucket: "assets-bucket",
      ContinuationToken: "next-page",
    });
    expect(s3.commands[4]?.input).toMatchObject({
      Bucket: "files-bucket",
    });
    expect(cloudFormation.commandNames()).toEqual([
      "DescribeStacksCommand",
      "DeleteStackCommand",
      "DescribeStacksCommand",
    ]);
  });

  it("throws a typed error when stack deletion fails", async () => {
    const cloudFormation = new SequenceAwsClient({
      DescribeStacksCommand: [
        {
          Stacks: [
            {
              StackStatus: "CREATE_COMPLETE",
            },
          ],
        },
        {
          Stacks: [
            {
              StackStatus: "DELETE_FAILED",
            },
          ],
        },
      ],
      DeleteStackCommand: [{}],
    });
    const destroyer = new AwsSdkPreviewDestroyer({
      cloudFormation,
      stackPollDelayMs: 0,
    });

    let error: unknown;

    try {
      await destroyer.destroy({ cell: "notes", environment: "preview" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AwsPreviewDestroyError);
    expect(error).toMatchObject({
      code: "AWS_DESTROY_FAILED",
      details: {
        stackName: "anvil-notes-preview",
        status: "DELETE_FAILED",
      },
    });
    expect(cloudFormation.commandNames()).toEqual([
      "DescribeStacksCommand",
      "DeleteStackCommand",
      "DescribeStacksCommand",
    ]);
  });

  it("throws a typed timeout when stack deletion does not finish", async () => {
    const cloudFormation = new SequenceAwsClient({
      DescribeStacksCommand: [
        {
          Stacks: [
            {
              StackStatus: "CREATE_COMPLETE",
            },
          ],
        },
        {
          Stacks: [
            {
              StackStatus: "DELETE_IN_PROGRESS",
            },
          ],
        },
        {
          Stacks: [
            {
              StackStatus: "DELETE_IN_PROGRESS",
            },
          ],
        },
      ],
      DeleteStackCommand: [{}],
    });
    const destroyer = new AwsSdkPreviewDestroyer({
      cloudFormation,
      stackPollDelayMs: 0,
      stackMaxPollAttempts: 2,
    });

    let error: unknown;

    try {
      await destroyer.destroy({ cell: "notes", environment: "preview" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AwsPreviewDestroyError);
    expect(error).toMatchObject({
      code: "AWS_DESTROY_TIMEOUT",
      details: {
        stackName: "anvil-notes-preview",
        lastStatus: "DELETE_IN_PROGRESS",
        attempts: 2,
        delayMs: 0,
      },
    });
    expect(cloudFormation.commandNames()).toEqual([
      "DescribeStacksCommand",
      "DeleteStackCommand",
      "DescribeStacksCommand",
      "DescribeStacksCommand",
    ]);
  });

  it("throws a typed operation error when bucket cleanup fails", async () => {
    const failure = new Error("list denied");

    failure.name = "AccessDenied";
    const cloudFormation = new SequenceAwsClient({
      DescribeStacksCommand: [
        {
          Stacks: [
            {
              StackStatus: "CREATE_COMPLETE",
              Outputs: [
                {
                  OutputKey: "ClientAssetsBucketName",
                  OutputValue: "assets-bucket",
                },
              ],
            },
          ],
        },
      ],
    });
    const s3 = new SequenceAwsClient({
      ListObjectsV2Command: [failure],
    });
    const destroyer = new AwsSdkPreviewDestroyer({
      cloudFormation,
      s3,
    });

    let error: unknown;

    try {
      await destroyer.destroy({ cell: "notes", environment: "preview" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AwsPreviewDestroyError);
    expect(error).toMatchObject({
      code: "AWS_DESTROY_OPERATION_FAILED",
      details: {
        operation: "s3:ListObjectsV2",
        bucket: "assets-bucket",
        cause: {
          name: "AccessDenied",
          message: "list denied",
        },
      },
    });
  });

  it("throws a typed operation error when stale metadata cleanup fails", async () => {
    const failure = new Error("delete denied");

    failure.name = "AccessDeniedException";
    const cloudFormation = new SequenceAwsClient({
      DescribeStacksCommand: [stackNotFoundError()],
    });
    const destroyer = new AwsSdkPreviewDestroyer({
      cloudFormation,
      dynamodb: new FakeAwsClient({
        DeleteItemCommand: failure,
      }),
      deploymentMetadataTable: "deployments",
    });

    let error: unknown;

    try {
      await destroyer.destroy({ cell: "notes", environment: "preview" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AwsPreviewDestroyError);
    expect(error).toMatchObject({
      code: "AWS_DESTROY_OPERATION_FAILED",
      details: {
        operation: "dynamodb:DeleteItem",
        table: "deployments",
        cause: {
          name: "AccessDeniedException",
          message: "delete denied",
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

    const response = this.responses[command.constructor.name];

    if (response instanceof Error) {
      throw response;
    }

    return response ?? {};
  }

  commandNames(): string[] {
    return this.commands.map((command) => command.name);
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

    const next = this.responses[command.constructor.name]?.shift();

    if (next instanceof Error) {
      throw next;
    }

    return next ?? {};
  }

  commandNames(): string[] {
    return this.commands.map((command) => command.name);
  }
}

function stackNotFoundError(): Error {
  const error = new Error("Stack with id anvil-notes-preview does not exist");

  error.name = "ValidationError";

  return error;
}

function stringAttribute(value: unknown, path: string): string {
  const resolved = path.split(".").reduce<unknown>((current, part) => {
    if (typeof current !== "object" || current === null || !(part in current)) {
      return undefined;
    }

    return (current as Record<string, unknown>)[part];
  }, value);

  if (typeof resolved !== "string") {
    throw new Error(`Expected ${path} to be a string.`);
  }

  return resolved;
}

function createInput(
  overrides: Partial<AwsPreviewProvisionerInput> = {},
): AwsPreviewProvisionerInput {
  return {
    environment: "preview",
    ...overrides,
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
      workflows: [{ name: "syncNotes", steps: ["fetch", "store"] }],
      services: [],
      capabilities: {
        database: true,
      },
    },
    ...(overrides.manifest ? { manifest: overrides.manifest } : {}),
    plan: {
      schemaVersion: "0.1",
      adapter: "aws",
      environment: "preview",
      cell: "notes",
      changes: [],
      warnings: [],
    },
    ...(overrides.plan ? { plan: overrides.plan } : {}),
    template: {
      AWSTemplateFormatVersion: "2010-09-09",
      Description: "test",
      Parameters: {},
      Resources: {},
      Outputs: {},
    },
    ...(overrides.template ? { template: overrides.template } : {}),
    artifacts: {
      lambda: {
        key: "notes/server.zip",
        body: new Uint8Array([1, 2, 3]),
        contentType: "application/zip",
        sha256: "hash-lambda",
      },
      template: {
        key: "notes/template.json",
        body: new Uint8Array([4]),
        contentType: "application/json",
        sha256: "hash-template",
      },
      manifest: {
        key: "notes/manifest.json",
        body: new Uint8Array([5]),
        contentType: "application/json",
        sha256: "hash-manifest",
      },
      clientAssets: [
        {
          key: "notes/client/index.html",
          body: new Uint8Array([6]),
          contentType: "text/html",
          sha256: "hash-client-index",
          cacheControl: "no-cache",
        },
      ],
    },
    ...(overrides.artifacts ? { artifacts: overrides.artifacts } : {}),
  };
}
