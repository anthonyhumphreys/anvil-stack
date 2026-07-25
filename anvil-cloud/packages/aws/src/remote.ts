import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  type FilterLogEventsCommandOutput,
} from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { Cause, Effect, Exit } from "effect";

import type { CellManifest } from "@anvil-cloud/builder";
import type { AwsPreviewDeployArtifactSummary } from "./artifacts.js";
import type { DeploymentEnvironment } from "./index.js";
import { normalizePreviewName } from "./preview-name.js";

export type AwsRemoteInspectResult = {
  ok: true;
  adapter: "aws";
  cell: string;
  environment: DeploymentEnvironment;
  previewName: string;
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
  previewName: string;
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
    previewName?: string;
  }): Promise<AwsRemoteInspectResult> {
    return runAwsRemoteEffect(this.inspectEffect(input));
  }

  async readLogs(input: {
    cell: string;
    environment: DeploymentEnvironment;
    previewName?: string;
    sinceMs?: number;
    limit?: number;
  }): Promise<AwsRemoteLogsResult> {
    return runAwsRemoteEffect(this.readLogsEffect(input));
  }

  private inspectEffect(input: {
    cell: string;
    environment: DeploymentEnvironment;
    previewName?: string;
  }): Effect.Effect<AwsRemoteInspectResult, AwsRemoteReaderError> {
    return Effect.gen(this, function* () {
      const item = yield* this.readDeploymentItemEffect(input);
      const manifest = yield* parseJsonAttribute<CellManifest>(
        item.manifest,
        "manifest",
      );
      const outputs = yield* parseJsonAttribute<Record<string, string>>(
        item.outputs,
        "outputs",
      );
      const artifacts =
        yield* optionalJsonAttribute<AwsPreviewDeployArtifactSummary>(
          item.artifacts,
          "artifacts",
        );

      const runtimeUrl = yield* stringAttribute(item.runtimeUrl, "runtimeUrl");
      const result: AwsRemoteInspectResult = {
        ok: true,
        adapter: "aws",
        cell: input.cell,
        environment: input.environment,
        previewName: normalizePreviewName(
          yield* optionalStringAttributeEffect(item.previewName, "default"),
        ),
        deploymentId: yield* stringAttribute(item.deploymentId, "deploymentId"),
        runtimeUrl,
        manifest,
        ...(artifacts ? { artifacts } : {}),
        resources: {
          stack: yield* stringAttribute(item.stackName, "stackName"),
          runtimeUrl,
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
          ...workflowStateMachineResources(manifest, outputs),
          deploymentMetadataTable: this.options.deploymentMetadataTable,
        },
      };

      const updatedAt = optionalStringAttribute(item.updatedAt);

      if (updatedAt !== undefined) {
        result.updatedAt = updatedAt;
      }

      return result;
    });
  }

  private readLogsEffect(input: {
    cell: string;
    environment: DeploymentEnvironment;
    previewName?: string;
    sinceMs?: number;
    limit?: number;
  }): Effect.Effect<AwsRemoteLogsResult, AwsRemoteReaderError> {
    return Effect.gen(this, function* () {
      const inspected = yield* this.inspectEffect(input);
      const logGroupName = inspected.resources.logs;
      const limit = input.limit ?? 50;

      if (!logGroupName) {
        return {
          ok: true,
          adapter: "aws" as const,
          cell: input.cell,
          environment: input.environment,
          previewName: inspected.previewName,
          logs: [],
        };
      }

      const events: NonNullable<FilterLogEventsCommandOutput["events"]> = [];
      let nextToken: string | undefined;

      do {
        const response = yield* readAwsRemoteEffect(
          "cloudwatch-logs:FilterLogEvents",
          {
            cell: input.cell,
            environment: input.environment,
            previewName: input.previewName,
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
        adapter: "aws" as const,
        cell: input.cell,
        environment: input.environment,
        previewName: inspected.previewName,
        logs: events
          .slice(0, limit)
          .map((event) => parseLogEvent(event.timestamp, event.message ?? "")),
      };
    });
  }

  private readDeploymentItemEffect(input: {
    cell: string;
    environment: DeploymentEnvironment;
    previewName?: string;
  }) {
    return Effect.gen(this, function* () {
      const response = yield* readAwsRemoteEffect(
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
                pk: {
                  S: deploymentMetadataRecordKey(
                    input.cell,
                    input.environment,
                    input.previewName,
                  ),
                },
              },
            }),
          ),
      );

      if (!response.Item) {
        return yield* Effect.fail(
          new AwsRemoteReaderError(
            "AWS_DEPLOYMENT_METADATA_NOT_FOUND",
            `No AWS deployment metadata found for ${input.cell}/${input.environment}.`,
            {
              cell: input.cell,
              environment: input.environment,
              previewName: normalizePreviewName(input.previewName),
              table: this.options.deploymentMetadataTable,
            },
          ),
        );
      }

      return response.Item;
    });
  }
}

// Runs a remote-reader effect at the Promise boundary. Typed failures and
// defects are both rethrown as their original values so callers keep the
// pre-Effect error contract.
async function runAwsRemoteEffect<T>(
  effect: Effect.Effect<T, AwsRemoteReaderError>,
): Promise<T> {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  throw Cause.squash(exit.cause);
}

function readAwsRemoteEffect<T>(
  operation: string,
  details: Record<string, unknown>,
  read: () => Promise<T>,
): Effect.Effect<T, AwsRemoteReaderError> {
  return Effect.tryPromise({
    try: read,
    catch: (error) =>
      new AwsRemoteReaderError(
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
      ),
  });
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

function parseJsonAttribute<T>(
  attribute: unknown,
  name: string,
): Effect.Effect<T, AwsRemoteReaderError> {
  return stringAttribute(attribute, name).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => JSON.parse(raw) as T,
        catch: (error) =>
          new AwsRemoteReaderError(
            "AWS_DEPLOYMENT_METADATA_INVALID",
            `Deployment metadata attribute '${name}' is not valid JSON.`,
            {
              attribute: name,
              cause: error instanceof Error ? error.message : String(error),
            },
          ),
      }),
    ),
  );
}

function optionalJsonAttribute<T>(
  attribute: unknown,
  name: string,
): Effect.Effect<T | undefined, AwsRemoteReaderError> {
  if (!attribute) {
    return Effect.succeed(undefined);
  }

  return parseJsonAttribute<T>(attribute, name);
}

function stringAttribute(
  attribute: unknown,
  name: string,
): Effect.Effect<string, AwsRemoteReaderError> {
  if (
    typeof attribute === "object" &&
    attribute !== null &&
    "S" in attribute &&
    typeof attribute.S === "string"
  ) {
    return Effect.succeed(attribute.S);
  }

  return Effect.fail(
    new AwsRemoteReaderError(
      "AWS_DEPLOYMENT_METADATA_INVALID",
      `Deployment metadata attribute '${name}' is required.`,
      { attribute: name },
    ),
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

function optionalStringAttributeEffect(
  attribute: unknown,
  fallback: string,
): Effect.Effect<string, never> {
  return Effect.succeed(optionalStringAttribute(attribute) ?? fallback);
}

function deploymentMetadataRecordKey(
  cell: string,
  environment: string,
  previewName?: string,
): string {
  const normalizedPreviewName = normalizePreviewName(previewName);

  return normalizedPreviewName === "default"
    ? `deployment#${cell}#${environment}`
    : `deployment#${cell}#${environment}#${normalizedPreviewName}`;
}

function workflowStateMachineResources(
  manifest: CellManifest,
  outputs: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    (manifest.workflows ?? [])
      .map((workflow) => {
        const value =
          outputs[`Workflow${logicalIdPart(workflow.name)}StateMachineArn`];

        return value ? [`workflow:${workflow.name}`, value] : null;
      })
      .filter((entry): entry is [string, string] => entry !== null),
  );
}

function logicalIdPart(value: string): string {
  const normalized = value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");

  return normalized.length > 0 ? normalized : "Workflow";
}
