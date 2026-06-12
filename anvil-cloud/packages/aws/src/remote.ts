import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

import type { CellManifest } from "@anvil-cloud/builder";
import type { DeploymentEnvironment } from "./index.js";

export type AwsRemoteInspectResult = {
  ok: true;
  adapter: "aws";
  cell: string;
  environment: DeploymentEnvironment;
  deploymentId: string;
  runtimeUrl: string;
  manifest: CellManifest;
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

    return {
      ok: true,
      adapter: "aws",
      cell: input.cell,
      environment: input.environment,
      deploymentId: stringAttribute(item.deploymentId, "deploymentId"),
      runtimeUrl: stringAttribute(item.runtimeUrl, "runtimeUrl"),
      manifest,
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
        deploymentMetadataTable: this.options.deploymentMetadataTable,
      },
    };
  }

  async readLogs(input: {
    cell: string;
    environment: DeploymentEnvironment;
    sinceMs?: number;
    limit?: number;
  }): Promise<AwsRemoteLogsResult> {
    const inspected = await this.inspect(input);
    const logGroupName = inspected.resources.logs;

    if (!logGroupName) {
      return {
        ok: true,
        adapter: "aws",
        cell: input.cell,
        environment: input.environment,
        logs: [],
      };
    }

    const response = await this.logs.send(
      new FilterLogEventsCommand({
        logGroupName,
        startTime: input.sinceMs,
        limit: input.limit ?? 50,
      }),
    );

    return {
      ok: true,
      adapter: "aws",
      cell: input.cell,
      environment: input.environment,
      logs: (response.events ?? []).map((event) =>
        parseLogEvent(event.timestamp, event.message ?? ""),
      ),
    };
  }

  private async readDeploymentItem(input: {
    cell: string;
    environment: DeploymentEnvironment;
  }) {
    const response = await this.dynamodb.send(
      new GetItemCommand({
        TableName: this.options.deploymentMetadataTable,
        Key: {
          pk: { S: `deployment#${input.cell}#${input.environment}` },
        },
      }),
    );

    if (!response.Item) {
      throw new Error(
        `No AWS deployment metadata found for ${input.cell}/${input.environment}.`,
      );
    }

    return response.Item;
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
  return JSON.parse(stringAttribute(attribute, name)) as T;
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

  throw new Error(`Deployment metadata attribute '${name}' is required.`);
}
