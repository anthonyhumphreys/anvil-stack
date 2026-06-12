import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  type FilterLogEventsCommandOutput,
} from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

import type { CellManifest } from "@anvil-cloud/builder";
import type { AwsPreviewDeployArtifactSummary } from "./artifacts.js";
import type { DeploymentEnvironment } from "./index.js";

export type AwsRemoteInspectResult = {
  ok: true;
  adapter: "aws";
  cell: string;
  environment: DeploymentEnvironment;
  deploymentId: string;
  updatedAt?: string;
  runtimeUrl: string;
  manifest: CellManifest;
  artifacts?: AwsPreviewDeployArtifactSummary;
  resources: Record<string, string>;
};

export type AwsRemoteLogEntry = {
  timestamp: string;
  message: string;
  level?: string;
  raw?: string;
};

export type AwsRemoteLogsResult = {
  ok: true;
  adapter: "aws";
  cell: string;
  environment: DeploymentEnvironment;
  logs: AwsRemoteLogEntry[];
};

export type AwsRemoteReaderOptions = {
  deploymentMetadataTable: string;
  region?: string;
  dynamodb?: Pick<DynamoDBClient, "send">;
  logs?: Pick<CloudWatchLogsClient, "send">;
};

export type AwsRemoteReaderErrorCode =
  | "AWS_DEPLOYMENT_METADATA_INVALID"
  | "AWS_DEPLOYMENT_METADATA_NOT_FOUND"
  | "AWS_REMOTE_READ_FAILED";

export class AwsRemoteReaderError extends Error {
  readonly code: AwsRemoteReaderErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: AwsRemoteReaderErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AwsRemoteReaderError";
    this.code = code;
    this.details = details;
  }
}

export class AwsRemoteReader {
  private readonly dynamodb: Pick<DynamoDBClient, "send">;
  private readonly logs: Pick<CloudWatchLogsClient, "send">;

  constructor(private readonly options: AwsRemoteReaderOptions) {
    const clientOptions =
      options.region === undefined ? {} : { region: options.region };

    this.dynamodb = options.dynamodb ?? new DynamoDBClient(clientOptions);
    this.logs = options.logs ?? new CloudWatchLogsClient(clientOptions);
  }

  async inspect(input: {
    cell: string;
    environment: DeploymentEnvironment;
  }): Promise<AwsRemoteInspectResult> {
    const item = await this.readDeploymentItem(input);
    const manifest = parseJsonAttribute<CellManifest>(
      item.manifest,
      "manifest",
    );
    const outputs = parseJsonAttribute<Record<string, string>>(
      item.outputs,
      "outputs",
    );
    const artifacts = optionalJsonAttribute<AwsPreviewDeployArtifactSummary>(
      item.artifacts,
      "artifacts",
    );

    const result: AwsRemoteInspectResult = {
      ok: true,
      adapter: "aws",
      cell: input.cell,
      environment: input.environment,
      deploymentId: stringAttribute(item.deploymentId, "deploymentId"),
      runtimeUrl: stringAttribute(item.runtimeUrl, "runtimeUrl"),
      manifest,
      ...(artifacts ? { artifacts } : {}),
      resources: {
        stack: stringAttribute(item.stackName, "stackName"),
        runtimeUrl: stringAttribute(item.runtimeUrl, "runtimeUrl"),
        ...(outputs.ClientAssetsBucketName
          ? { assetsBucket: outputs.ClientAssetsBucketName }
          : {}),
        ...(outputs.RuntimeLogGroupName
          ? { logs: outputs.RuntimeLogGroupName }
          : {}),
        ...(outputs.CellDataTableName
          ? { database: outputs.CellDataTableName }
          : {}),
        ...(outputs.CellFilesBucketName
          ? { files: outputs.CellFilesBucketName }
          : {}),
        ...(outputs.CellEventBusName
          ? { events: outputs.CellEventBusName }
          : {}),
        ...(outputs.CellJobQueueUrl ? { jobs: outputs.CellJobQueueUrl } : {}),
        ...(outputs.CellJobDeadLetterQueueUrl
          ? { jobDeadLetterQueue: outputs.CellJobDeadLetterQueueUrl }
          : {}),
        deploymentMetadataTable: this.options.deploymentMetadataTable,
      },
    };

    const updatedAt = optionalStringAttribute(item.updatedAt);

    if (updatedAt !== undefined) {
      result.updatedAt = updatedAt;
    }

    return result;
  }

  async readLogs(input: {
    cell: string;
    environment: DeploymentEnvironment;
    sinceMs?: number;
    limit?: number;
  }): Promise<AwsRemoteLogsResult> {
    const inspected = await this.inspect(input);
    const logGroupName = inspected.resources.logs;
    const limit = input.limit ?? 50;

    if (!logGroupName) {
      return {
        ok: true,
        adapter: "aws",
        cell: input.cell,
        environment: input.environment,
        logs: [],
      };
    }

    const events = [];
    let nextToken: string | undefined;

    do {
      const response: FilterLogEventsCommandOutput = await readAwsRemote(
        "cloudwatch-logs:FilterLogEvents",
        {
          cell: input.cell,
          environment: input.environment,
          logGroupName,
        },
        () =>
          this.logs.send(
            new FilterLogEventsCommand({
              logGroupName,
              startTime: input.sinceMs,
              limit: Math.max(1, limit - events.length),
              nextToken,
            }),
          ),
      );

      events.push(...(response.events ?? []));
      nextToken = response.nextToken;
    } while (nextToken !== undefined && events.length < limit);

    return {
      ok: true,
      adapter: "aws",
      cell: input.cell,
      environment: input.environment,
      logs: events.slice(0, limit).map((event) =>
        parseLogEvent(event.timestamp, event.message ?? ""),
      ),
    };
  }

  private async readDeploymentItem(input: {
    cell: string;
    environment: DeploymentEnvironment;
  }) {
    const response = await readAwsRemote(
      "dynamodb:GetItem",
      {
        cell: input.cell,
        environment: input.environment,
        table: this.options.deploymentMetadataTable,
      },
      () =>
        this.dynamodb.send(
          new GetItemCommand({
            TableName: this.options.deploymentMetadataTable,
            Key: {
              pk: { S: `deployment#${input.cell}#${input.environment}` },
            },
          }),
        ),
    );

    if (!response.Item) {
      throw new AwsRemoteReaderError(
        "AWS_DEPLOYMENT_METADATA_NOT_FOUND",
        `No AWS deployment metadata found for ${input.cell}/${input.environment}.`,
        {
          cell: input.cell,
          environment: input.environment,
          table: this.options.deploymentMetadataTable,
        },
      );
    }

    return response.Item;
  }
}

async function readAwsRemote<T>(
  operation: string,
  details: Record<string, unknown>,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new AwsRemoteReaderError(
      "AWS_REMOTE_READ_FAILED",
      `AWS remote read failed during ${operation}.`,
      {
        ...details,
        operation,
        cause:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
              }
            : String(error),
      },
    );
  }
}

export function createAwsRemoteReaderFromEnv(
  env: Record<string, string | undefined> = process.env,
): AwsRemoteReader | null {
  const deploymentMetadataTable = env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;

  if (!deploymentMetadataTable) {
    return null;
  }

  const options: AwsRemoteReaderOptions = {
    deploymentMetadataTable,
  };
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;

  if (region !== undefined) {
    options.region = region;
  }

  return new AwsRemoteReader(options);
}

function parseLogEvent(
  timestamp: number | undefined,
  message: string,
): AwsRemoteLogEntry {
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;

    const entry: AwsRemoteLogEntry = {
      timestamp: new Date(timestamp ?? Date.now()).toISOString(),
      message:
        typeof parsed.message === "string"
          ? parsed.message
          : JSON.stringify(parsed),
      raw: message,
    };

    if (typeof parsed.level === "string") {
      entry.level = parsed.level;
    }

    return entry;
  } catch {
    return {
      timestamp: new Date(timestamp ?? Date.now()).toISOString(),
      message,
      raw: message,
    };
  }
}

function parseJsonAttribute<T>(attribute: unknown, name: string): T {
  const raw = stringAttribute(attribute, name);

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new AwsRemoteReaderError(
      "AWS_DEPLOYMENT_METADATA_INVALID",
      `Deployment metadata attribute '${name}' is not valid JSON.`,
      {
        attribute: name,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function optionalJsonAttribute<T>(
  attribute: unknown,
  name: string,
): T | undefined {
  if (!attribute) {
    return undefined;
  }

  return parseJsonAttribute<T>(attribute, name);
}

function stringAttribute(attribute: unknown, name: string): string {
  if (
    typeof attribute === "object" &&
    attribute !== null &&
    "S" in attribute &&
    typeof attribute.S === "string"
  ) {
    return attribute.S;
  }

  throw new AwsRemoteReaderError(
    "AWS_DEPLOYMENT_METADATA_INVALID",
    `Deployment metadata attribute '${name}' is required.`,
    { attribute: name },
  );
}

function optionalStringAttribute(attribute: unknown): string | undefined {
  if (
    typeof attribute === "object" &&
    attribute !== null &&
    "S" in attribute &&
    typeof attribute.S === "string"
  ) {
    return attribute.S;
  }

  return undefined;
}
