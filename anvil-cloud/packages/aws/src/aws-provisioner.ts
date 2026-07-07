import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  type Stack,
  type StackEvent,
} from "@aws-sdk/client-cloudformation";
import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Cause, Effect, Exit, Schedule } from "effect";

import {
  summarizeAwsPreviewDeployArtifacts,
  type AwsDeployArtifact,
} from "./artifacts.js";
import { createAwsResourceNames } from "./cloudformation.js";
import { normalizePreviewName } from "./preview-name.js";
import type {
  AwsPreviewProvisioner,
  AwsPreviewProvisionerInput,
  AwsPreviewProvisionerResult,
} from "./provisioner.js";

export type AwsSdkPreviewProvisionerOptions = {
  artifactBucket: string;
  region?: string;
  stackNamePrefix?: string;
  stackPollDelayMs?: number;
  stackMaxPollAttempts?: number;
  s3?: Pick<S3Client, "send">;
  cloudFormation?: Pick<CloudFormationClient, "send">;
  dynamodb?: Pick<DynamoDBClient, "send">;
};

export type AwsSdkPreviewDestroyerOptions = {
  region?: string;
  stackNamePrefix?: string;
  deploymentMetadataTable?: string;
  stackPollDelayMs?: number;
  stackMaxPollAttempts?: number;
  cloudFormation?: Pick<CloudFormationClient, "send">;
  dynamodb?: Pick<DynamoDBClient, "send">;
  s3?: Pick<S3Client, "send">;
};

export type AwsPreviewDestroyInput = {
  cell: string;
  environment: string;
  previewName?: string;
};

export type AwsPreviewDestroyResult = {
  ok: true;
  adapter: "aws";
  cell: string;
  environment: string;
  previewName: string;
  stackName: string;
  deleted: boolean;
  metadataDeleted: boolean;
  emptiedBuckets: string[];
};

export type AwsPreviewDestroyErrorCode =
  | "AWS_DESTROY_FAILED"
  | "AWS_DESTROY_OPERATION_FAILED"
  | "AWS_DESTROY_TIMEOUT";

export type AwsStackFailureEvent = {
  logicalResourceId: string;
  resourceStatus: string;
  resourceType?: string;
  reason: string;
};

export class AwsPreviewProvisioningError extends Error {
  readonly code:
    | "AWS_STACK_FAILED"
    | "AWS_PROVISIONING_OPERATION_FAILED"
    | "AWS_STACK_OUTPUT_MISSING"
    | "AWS_STACK_TIMEOUT";
  readonly details:
    | {
        stackName: string;
        status: string;
        events: AwsStackFailureEvent[];
      }
    | {
        operation: string;
        stackName?: string;
        bucket?: string;
        table?: string;
        cause: AwsSdkErrorCause;
      }
    | {
        stackName: string;
        output: string;
      }
    | {
        stackName: string;
        lastStatus?: string;
        attempts: number;
        delayMs: number;
      };

  constructor(
    code:
      | "AWS_STACK_FAILED"
      | "AWS_PROVISIONING_OPERATION_FAILED"
      | "AWS_STACK_OUTPUT_MISSING"
      | "AWS_STACK_TIMEOUT",
    message: string,
    details: AwsPreviewProvisioningError["details"],
  ) {
    super(message);
    this.name = "AwsPreviewProvisioningError";
    this.code = code;
    this.details = details;
  }
}

export class AwsPreviewDestroyError extends Error {
  readonly code: AwsPreviewDestroyErrorCode;
  readonly details:
    | {
        stackName: string;
        status: string;
      }
    | {
        operation: string;
        stackName?: string;
        bucket?: string;
        table?: string;
        cause: AwsSdkErrorCause;
      }
    | {
        stackName: string;
        lastStatus?: string;
        attempts: number;
        delayMs: number;
      };

  constructor(
    code: AwsPreviewDestroyErrorCode,
    message: string,
    details: AwsPreviewDestroyError["details"],
  ) {
    super(message);
    this.name = "AwsPreviewDestroyError";
    this.code = code;
    this.details = details;
  }
}

export class AwsSdkPreviewProvisioner implements AwsPreviewProvisioner {
  private readonly s3: Pick<S3Client, "send">;
  private readonly cloudFormation: Pick<CloudFormationClient, "send">;
  private readonly dynamodb: Pick<DynamoDBClient, "send">;

  constructor(private readonly options: AwsSdkPreviewProvisionerOptions) {
    const clientOptions =
      options.region === undefined ? {} : { region: options.region };

    this.s3 = options.s3 ?? new S3Client(clientOptions);
    this.cloudFormation =
      options.cloudFormation ?? new CloudFormationClient(clientOptions);
    this.dynamodb = options.dynamodb ?? new DynamoDBClient(clientOptions);
  }

  async provision(
    input: AwsPreviewProvisionerInput,
  ): Promise<AwsPreviewProvisionerResult> {
    return runAwsEffect(this.provisionEffect(input));
  }

  private provisionEffect(
    input: AwsPreviewProvisionerInput,
  ): Effect.Effect<AwsPreviewProvisionerResult, AwsPreviewProvisioningError> {
    const stackName = awsPreviewStackNameFor(
      input.plan.cell,
      stackEnvironment(input.environment, input.previewName),
      this.options.stackNamePrefix,
    );
    const serverKey = artifactKey(input.artifacts.lambda);

    return Effect.gen(this, function* () {
      yield* this.uploadArtifactEffect(input.artifacts.lambda, serverKey);
      yield* this.uploadArtifactEffect(
        input.artifacts.template,
        artifactKey(input.artifacts.template),
      );
      yield* this.uploadArtifactEffect(
        input.artifacts.manifest,
        artifactKey(input.artifacts.manifest),
      );
      yield* this.applyStackEffect(input, stackName, serverKey);

      const stack = yield* this.waitForStackEffect(stackName);
      const outputs = outputsFrom(stack);
      const clientAssetsBucket = yield* requiredStackOutputEffect(
        outputs,
        "ClientAssetsBucketName",
        stackName,
      );

      // Client asset counts are unbounded, so cap concurrent S3 uploads.
      yield* Effect.all(
        input.artifacts.clientAssets.map((artifact) =>
          this.uploadArtifactEffect(artifact, artifact.key, clientAssetsBucket),
        ),
        { concurrency: 8 },
      );

      const deploymentId = `dep_${Date.now().toString(36)}`;
      const metadataTable = yield* requiredStackOutputEffect(
        outputs,
        "DeploymentMetadataTableName",
        stackName,
      );
      const deploymentMetadataKey = deploymentMetadataRecordKey(
        input.plan.cell,
        input.environment,
        input.previewName,
      );

      yield* this.publishDeploymentMetadataEffect({
        tableName: metadataTable,
        key: deploymentMetadataKey,
        deploymentId,
        input,
        stackName,
        outputs,
      });

      const runtimeUrl = yield* requiredStackOutputEffect(
        outputs,
        "RuntimeUrl",
        stackName,
      );
      const logs = yield* requiredStackOutputEffect(
        outputs,
        "RuntimeLogGroupName",
        stackName,
      );

      return {
        deploymentId,
        previewName: normalizePreviewName(input.previewName),
        url: runtimeUrl,
        resources: {
          stack: stackName,
          runtimeUrl,
          lambda: createAwsResourceNames(input.plan.cell, input.environment)
            .runtimeFunction,
          assetsBucket: clientAssetsBucket,
          logs,
          deploymentMetadataTable: metadataTable,
          deploymentMetadataKey,
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
          ...workflowStateMachineResources(input.manifest, outputs),
        },
      };
    });
  }

  private uploadArtifactEffect(
    artifact: AwsDeployArtifact,
    key: string,
    bucket = this.options.artifactBucket,
  ): Effect.Effect<void, AwsPreviewProvisioningError> {
    return Effect.tryPromise({
      try: () => this.uploadArtifact(artifact, key, bucket),
      catch: toAwsPreviewProvisioningError,
    });
  }

  private async uploadArtifact(
    artifact: AwsDeployArtifact,
    key: string,
    bucket = this.options.artifactBucket,
  ): Promise<void> {
    await writeAwsProvisioningOperation("s3:PutObject", { bucket }, () =>
      this.s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: Buffer.from(artifact.body),
          ContentType: artifact.contentType,
          ServerSideEncryption: "AES256",
          ...(artifact.cacheControl
            ? { CacheControl: artifact.cacheControl }
            : {}),
        }),
      ),
    );
  }

  private async applyStack(
    input: AwsPreviewProvisionerInput,
    stackName: string,
    serverKey: string,
  ): Promise<void> {
    const parameters = [
      {
        ParameterKey: "ServerBundleBucket",
        ParameterValue: this.options.artifactBucket,
      },
      {
        ParameterKey: "ServerBundleKey",
        ParameterValue: serverKey,
      },
    ];
    const templateBody = JSON.stringify(input.template);

    let created = false;

    try {
      await writeAwsProvisioningOperation(
        "cloudformation:CreateStack",
        { stackName },
        () =>
          this.cloudFormation.send(
            new CreateStackCommand({
              StackName: stackName,
              TemplateBody: templateBody,
              Capabilities: ["CAPABILITY_NAMED_IAM"],
              Parameters: parameters,
              Tags: [
                {
                  Key: "anvil:cell",
                  Value: input.plan.cell,
                },
                {
                  Key: "anvil:env",
                  Value: input.environment,
                },
              ],
            }),
          ),
      );
      created = true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      try {
        await writeAwsProvisioningOperation(
          "cloudformation:UpdateStack",
          { stackName },
          () =>
            this.cloudFormation.send(
              new UpdateStackCommand({
                StackName: stackName,
                TemplateBody: templateBody,
                Capabilities: ["CAPABILITY_NAMED_IAM"],
                Parameters: parameters,
              }),
            ),
        );
      } catch (updateError) {
        if (!isNoUpdatesError(updateError)) {
          throw updateError;
        }
      }
    }

    if (created) {
      return;
    }
  }

  private async describeStack(stackName: string): Promise<Stack> {
    const response = await writeAwsProvisioningOperation(
      "cloudformation:DescribeStacks",
      { stackName },
      () =>
        this.cloudFormation.send(
          new DescribeStacksCommand({
            StackName: stackName,
          }),
        ),
    );
    const [stack] = response.Stacks ?? [];

    if (!stack) {
      throw new Error(`CloudFormation stack '${stackName}' was not found.`);
    }

    return stack;
  }

  private waitForStackEffect(
    stackName: string,
  ): Effect.Effect<Stack, AwsPreviewProvisioningError> {
    const maxAttempts = this.options.stackMaxPollAttempts ?? 60;
    const delayMs = this.options.stackPollDelayMs ?? 5000;

    const pollOnce = Effect.gen(this, function* () {
      const stack = yield* Effect.tryPromise({
        try: () => this.describeStack(stackName),
        catch: toAwsPreviewProvisioningError,
      });
      const status = stack.StackStatus;

      if (status && isFailedStackStatus(status)) {
        const failureSummary = yield* Effect.tryPromise({
          try: () => this.describeStackFailureSummary(stackName),
          catch: toAwsPreviewProvisioningError,
        });

        return yield* Effect.fail(
          new AwsPreviewProvisioningError(
            "AWS_STACK_FAILED",
            `CloudFormation stack '${stackName}' finished with status '${status}'.${failureSummary.messageSuffix}`,
            {
              stackName,
              status,
              events: failureSummary.events,
            },
          ),
        );
      }

      return stack;
    });

    return Effect.gen(this, function* () {
      const stack = yield* pollOnce.pipe(
        Effect.repeat({
          schedule: pollSchedule(delayMs, maxAttempts),
          until: (candidate) => isSettledStackStatus(candidate.StackStatus),
        }),
      );

      if (!isSettledStackStatus(stack.StackStatus)) {
        return yield* Effect.fail(
          new AwsPreviewProvisioningError(
            "AWS_STACK_TIMEOUT",
            `CloudFormation stack '${stackName}' did not finish within ${maxAttempts} attempts. Last status: ${stack.StackStatus ?? "unknown"}.`,
            {
              stackName,
              ...(stack.StackStatus ? { lastStatus: stack.StackStatus } : {}),
              attempts: maxAttempts,
              delayMs,
            },
          ),
        );
      }

      return stack;
    });
  }

  private async describeStackFailureSummary(stackName: string): Promise<{
    messageSuffix: string;
    events: AwsStackFailureEvent[];
  }> {
    try {
      const response = await this.cloudFormation.send(
        new DescribeStackEventsCommand({
          StackName: stackName,
        }),
      );
      const events = (response.StackEvents ?? [])
        .filter(isFailureEvent)
        .slice(0, 5)
        .map(toFailureEvent);

      if (events.length === 0) {
        return { messageSuffix: "", events };
      }

      return {
        messageSuffix: ` Recent failures: ${events
          .map((event) => `${event.logicalResourceId}: ${event.reason}`)
          .join("; ")}`,
        events,
      };
    } catch {
      return { messageSuffix: "", events: [] };
    }
  }

  private async publishDeploymentMetadata(input: {
    tableName: string;
    key: string;
    deploymentId: string;
    input: AwsPreviewProvisionerInput;
    stackName: string;
    outputs: Record<string, string>;
  }): Promise<void> {
    await writeAwsProvisioningOperation(
      "dynamodb:PutItem",
      { stackName: input.stackName, table: input.tableName },
      () =>
        this.dynamodb.send(
          new PutItemCommand({
            TableName: input.tableName,
            Item: {
              pk: {
                S: input.key,
              },
              deploymentId: { S: input.deploymentId },
              cell: { S: input.input.plan.cell },
              environment: { S: input.input.environment },
              previewName: {
                S: normalizePreviewName(input.input.previewName),
              },
              stackName: { S: input.stackName },
              runtimeUrl: {
                S: requiredStackOutput(
                  input.outputs,
                  "RuntimeUrl",
                  input.stackName,
                ),
              },
              manifest: { S: JSON.stringify(input.input.manifest) },
              outputs: { S: JSON.stringify(input.outputs) },
              artifacts: {
                S: JSON.stringify(
                  summarizeAwsPreviewDeployArtifacts(input.input.artifacts),
                ),
              },
              updatedAt: { S: new Date().toISOString() },
            },
          }),
        ),
    );
  }

  private applyStackEffect(
    input: AwsPreviewProvisionerInput,
    stackName: string,
    serverKey: string,
  ): Effect.Effect<void, AwsPreviewProvisioningError> {
    return Effect.tryPromise({
      try: () => this.applyStack(input, stackName, serverKey),
      catch: toAwsPreviewProvisioningError,
    });
  }

  private publishDeploymentMetadataEffect(input: {
    tableName: string;
    key: string;
    deploymentId: string;
    input: AwsPreviewProvisionerInput;
    stackName: string;
    outputs: Record<string, string>;
  }): Effect.Effect<void, AwsPreviewProvisioningError> {
    return Effect.tryPromise({
      try: () => this.publishDeploymentMetadata(input),
      catch: toAwsPreviewProvisioningError,
    });
  }
}

export class AwsSdkPreviewDestroyer {
  private readonly cloudFormation: Pick<CloudFormationClient, "send">;
  private readonly dynamodb: Pick<DynamoDBClient, "send">;
  private readonly s3: Pick<S3Client, "send">;

  constructor(private readonly options: AwsSdkPreviewDestroyerOptions = {}) {
    const clientOptions =
      options.region === undefined ? {} : { region: options.region };

    this.cloudFormation =
      options.cloudFormation ?? new CloudFormationClient(clientOptions);
    this.dynamodb = options.dynamodb ?? new DynamoDBClient(clientOptions);
    this.s3 = options.s3 ?? new S3Client(clientOptions);
  }

  async destroy(
    input: AwsPreviewDestroyInput,
  ): Promise<AwsPreviewDestroyResult> {
    return runAwsEffect(this.destroyEffect(input));
  }

  private destroyEffect(
    input: AwsPreviewDestroyInput,
  ): Effect.Effect<AwsPreviewDestroyResult, AwsPreviewDestroyError> {
    const stackName = awsPreviewStackNameFor(
      input.cell,
      stackEnvironment(input.environment, input.previewName),
      this.options.stackNamePrefix,
    );
    const previewName = normalizePreviewName(input.previewName);

    return Effect.gen(this, function* () {
      const stack = yield* Effect.tryPromise({
        try: () => this.readStack(stackName),
        catch: toAwsPreviewDestroyError,
      });

      if (!stack) {
        const metadataDeleted = yield* Effect.tryPromise({
          try: () => this.deleteDeploymentMetadata(input),
          catch: toAwsPreviewDestroyError,
        });

        return {
          ok: true as const,
          adapter: "aws" as const,
          cell: input.cell,
          environment: input.environment,
          previewName,
          stackName,
          deleted: false,
          metadataDeleted,
          emptiedBuckets: [],
        };
      }

      const emptiedBuckets = yield* Effect.tryPromise({
        try: () => this.emptyStackBuckets(stack),
        catch: toAwsPreviewDestroyError,
      });

      yield* Effect.tryPromise({
        try: () =>
          writeAwsDestroyOperation(
            "cloudformation:DeleteStack",
            { stackName },
            () =>
              this.cloudFormation.send(
                new DeleteStackCommand({
                  StackName: stackName,
                }),
              ),
          ),
        catch: toAwsPreviewDestroyError,
      });
      yield* this.waitForStackDeletionEffect(stackName);

      const metadataDeleted = yield* Effect.tryPromise({
        try: () => this.deleteDeploymentMetadata(input),
        catch: toAwsPreviewDestroyError,
      });

      return {
        ok: true as const,
        adapter: "aws" as const,
        cell: input.cell,
        environment: input.environment,
        previewName,
        stackName,
        deleted: true,
        metadataDeleted,
        emptiedBuckets,
      };
    });
  }

  private async readStack(stackName: string): Promise<Stack | null> {
    try {
      return await describeStack(this.cloudFormation, stackName);
    } catch (error) {
      if (isStackNotFoundError(error)) {
        return null;
      }

      throw toAwsDestroyOperationError("cloudformation:DescribeStacks", error, {
        stackName,
      });
    }
  }

  private waitForStackDeletionEffect(
    stackName: string,
  ): Effect.Effect<void, AwsPreviewDestroyError> {
    const maxAttempts = this.options.stackMaxPollAttempts ?? 60;
    const delayMs = this.options.stackPollDelayMs ?? 5000;

    type DeletionPoll = {
      deleted: boolean;
      lastStatus?: string;
    };

    const pollOnce: Effect.Effect<DeletionPoll, AwsPreviewDestroyError> =
      Effect.tryPromise({
        try: () => describeStack(this.cloudFormation, stackName),
        catch: (error) => error,
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            isStackNotFoundError(error)
              ? Effect.succeed<DeletionPoll>({ deleted: true })
              : Effect.fail(
                  toAwsPreviewDestroyError(
                    error,
                    "cloudformation:DescribeStacks",
                    { stackName },
                  ),
                ),
          onSuccess: (stack) => {
            const status = stack.StackStatus;

            if (status === "DELETE_COMPLETE") {
              return Effect.succeed<DeletionPoll>({
                deleted: true,
                lastStatus: status,
              });
            }

            if (status && isFailedStackStatus(status)) {
              return Effect.fail(
                new AwsPreviewDestroyError(
                  "AWS_DESTROY_FAILED",
                  `CloudFormation stack '${stackName}' finished with status '${status}' while deleting.`,
                  {
                    stackName,
                    status,
                  },
                ),
              );
            }

            return Effect.succeed<DeletionPoll>({
              deleted: false,
              ...(status ? { lastStatus: status } : {}),
            });
          },
        }),
      );

    return Effect.gen(function* () {
      const result = yield* pollOnce.pipe(
        Effect.repeat({
          schedule: pollSchedule(delayMs, maxAttempts),
          until: (poll) => poll.deleted,
        }),
      );

      if (!result.deleted) {
        return yield* Effect.fail(
          new AwsPreviewDestroyError(
            "AWS_DESTROY_TIMEOUT",
            `CloudFormation stack '${stackName}' was not deleted within ${maxAttempts} attempts. Last status: ${result.lastStatus ?? "unknown"}.`,
            {
              stackName,
              ...(result.lastStatus ? { lastStatus: result.lastStatus } : {}),
              attempts: maxAttempts,
              delayMs,
            },
          ),
        );
      }
    });
  }

  private async emptyStackBuckets(stack: Stack): Promise<string[]> {
    const outputs = outputsFrom(stack);
    const bucketNames = [
      outputs.ClientAssetsBucketName,
      outputs.CellFilesBucketName,
    ].filter((bucketName): bucketName is string => Boolean(bucketName));
    const emptiedBuckets: string[] = [];

    for (const bucketName of bucketNames) {
      await this.emptyBucket(bucketName);
      emptiedBuckets.push(bucketName);
    }

    return emptiedBuckets;
  }

  private async emptyBucket(bucketName: string): Promise<void> {
    let continuationToken: string | undefined;

    do {
      let response;

      try {
        response = await this.s3.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            ContinuationToken: continuationToken,
          }),
        );
      } catch (error) {
        if (isBucketNotFoundError(error)) {
          return;
        }

        throw toAwsDestroyOperationError("s3:ListObjectsV2", error, {
          bucket: bucketName,
        });
      }
      const objects = (response.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => key !== undefined)
        .map((key) => ({ Key: key }));

      if (objects.length > 0) {
        await writeAwsDestroyOperation(
          "s3:DeleteObjects",
          { bucket: bucketName },
          () =>
            this.s3.send(
              new DeleteObjectsCommand({
                Bucket: bucketName,
                Delete: {
                  Objects: objects,
                  Quiet: true,
                },
              }),
            ),
        );
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken !== undefined);
  }

  private async deleteDeploymentMetadata(
    input: AwsPreviewDestroyInput,
  ): Promise<boolean> {
    const tableName = this.options.deploymentMetadataTable;

    if (!tableName) {
      return false;
    }

    try {
      await writeAwsDestroyOperation(
        "dynamodb:DeleteItem",
        { table: tableName },
        () =>
          this.dynamodb.send(
            new DeleteItemCommand({
              TableName: tableName,
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
    } catch (error) {
      if (isDynamoDbResourceNotFoundError(error)) {
        return false;
      }

      throw error;
    }

    return true;
  }
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

function stackEnvironment(environment: string, previewName?: string): string {
  const normalizedPreviewName = normalizePreviewName(previewName);

  return normalizedPreviewName === "default"
    ? environment
    : `${environment}-${normalizedPreviewName}`;
}

type AwsSdkErrorCause = {
  name: string;
  message: string;
};

// Runs an AWS orchestration effect at the Promise boundary. Typed failures
// and defects are both rethrown as their original values so callers keep the
// pre-Effect error contract.
async function runAwsEffect<T, E>(effect: Effect.Effect<T, E>): Promise<T> {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  throw Cause.squash(exit.cause);
}

// One initial attempt plus (maxAttempts - 1) spaced repeats keeps the total
// describe-call budget identical to the previous manual polling loops. The
// passthrough makes Effect.repeat return the last poll result instead of the
// schedule counters.
function pollSchedule<T>(delayMs: number, maxAttempts: number) {
  return Schedule.spaced(`${Math.max(0, delayMs)} millis`).pipe(
    Schedule.intersect(Schedule.recurs(Math.max(0, maxAttempts - 1))),
    Schedule.passthrough,
  ) as Schedule.Schedule<T, T>;
}

function isSettledStackStatus(status: string | undefined): boolean {
  return !status || !status.endsWith("_IN_PROGRESS");
}

function toAwsPreviewDestroyError(
  error: unknown,
  operation = "destroy",
  details: { stackName?: string; bucket?: string; table?: string } = {},
): AwsPreviewDestroyError {
  if (error instanceof AwsPreviewDestroyError) {
    return error;
  }

  return toAwsDestroyOperationError(operation, error, details);
}

function toAwsPreviewProvisioningError(
  error: unknown,
): AwsPreviewProvisioningError {
  if (error instanceof AwsPreviewProvisioningError) {
    return error;
  }

  return new AwsPreviewProvisioningError(
    "AWS_PROVISIONING_OPERATION_FAILED",
    "AWS provisioning operation failed during effect execution.",
    {
      operation: "effect",
      cause: awsSdkErrorCause(error),
    },
  );
}

function requiredStackOutputEffect(
  outputs: Record<string, string>,
  key: string,
  stackName: string,
): Effect.Effect<string, AwsPreviewProvisioningError> {
  return Effect.try({
    try: () => requiredStackOutput(outputs, key, stackName),
    catch: toAwsPreviewProvisioningError,
  });
}

async function writeAwsProvisioningOperation<T>(
  operation: string,
  details: {
    stackName?: string;
    bucket?: string;
    table?: string;
  },
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof AwsPreviewProvisioningError) {
      throw error;
    }

    if (isAlreadyExistsError(error) || isNoUpdatesError(error)) {
      throw error;
    }

    throw new AwsPreviewProvisioningError(
      "AWS_PROVISIONING_OPERATION_FAILED",
      `AWS provisioning operation failed during ${operation}.`,
      {
        operation,
        ...details,
        cause: awsSdkErrorCause(error),
      },
    );
  }
}

async function writeAwsDestroyOperation<T>(
  operation: string,
  details: {
    stackName?: string;
    bucket?: string;
    table?: string;
  },
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof AwsPreviewDestroyError) {
      throw error;
    }

    throw toAwsDestroyOperationError(operation, error, details);
  }
}

function toAwsDestroyOperationError(
  operation: string,
  error: unknown,
  details: {
    stackName?: string;
    bucket?: string;
    table?: string;
  },
): AwsPreviewDestroyError {
  return new AwsPreviewDestroyError(
    "AWS_DESTROY_OPERATION_FAILED",
    `AWS destroy operation failed during ${operation}.`,
    {
      operation,
      ...details,
      cause: awsSdkErrorCause(error),
    },
  );
}

function awsSdkErrorCause(error: unknown): AwsSdkErrorCause {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "UnknownAwsSdkError",
    message: String(error),
  };
}

export function createAwsSdkPreviewProvisionerFromEnv(
  env: Record<string, string | undefined> = process.env,
): AwsSdkPreviewProvisioner | null {
  const artifactBucket = env.ANVIL_AWS_ARTIFACT_BUCKET;

  if (!artifactBucket) {
    return null;
  }

  const options: AwsSdkPreviewProvisionerOptions = {
    artifactBucket,
  };
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;

  if (region !== undefined) {
    options.region = region;
  }

  if (env.ANVIL_AWS_STACK_PREFIX !== undefined) {
    options.stackNamePrefix = env.ANVIL_AWS_STACK_PREFIX;
  }

  return new AwsSdkPreviewProvisioner(options);
}

export function createAwsSdkPreviewDestroyerFromEnv(
  env: Record<string, string | undefined> = process.env,
): AwsSdkPreviewDestroyer {
  const options: AwsSdkPreviewDestroyerOptions = {};
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;

  if (region !== undefined) {
    options.region = region;
  }

  if (env.ANVIL_AWS_STACK_PREFIX !== undefined) {
    options.stackNamePrefix = env.ANVIL_AWS_STACK_PREFIX;
  }

  if (env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE !== undefined) {
    options.deploymentMetadataTable = env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
  }

  return new AwsSdkPreviewDestroyer(options);
}

async function describeStack(
  cloudFormation: Pick<CloudFormationClient, "send">,
  stackName: string,
): Promise<Stack> {
  const response = await cloudFormation.send(
    new DescribeStacksCommand({
      StackName: stackName,
    }),
  );
  const [stack] = response.Stacks ?? [];

  if (!stack) {
    throw new Error(`CloudFormation stack '${stackName}' was not found.`);
  }

  return stack;
}

export function awsPreviewStackNameFor(
  cell: string,
  environment: string,
  prefix = "anvil",
): string {
  return `${prefix}-${cell}-${environment}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 128);
}

function artifactKey(artifact: AwsDeployArtifact): string {
  return artifact.key;
}

function outputsFrom(stack: Stack): Record<string, string> {
  const outputs: Record<string, string> = {};

  for (const output of stack.Outputs ?? []) {
    if (output.OutputKey && output.OutputValue) {
      outputs[output.OutputKey] = output.OutputValue;
    }
  }

  return outputs;
}

function requiredStackOutput(
  outputs: Record<string, string>,
  key: string,
  stackName: string,
): string {
  const value = outputs[key];

  if (!value) {
    throw new AwsPreviewProvisioningError(
      "AWS_STACK_OUTPUT_MISSING",
      `CloudFormation stack '${stackName}' is missing required output '${key}'.`,
      {
        stackName,
        output: key,
      },
    );
  }

  return value;
}

function workflowStateMachineResources(
  manifest: AwsPreviewProvisionerInput["manifest"],
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

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    String(error.name).includes("AlreadyExists")
  );
}

function isNoUpdatesError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "ValidationError" &&
    error.message.includes("No updates")
  );
}

function isStackNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "ValidationError" || error.name === "ResourceNotFound") &&
    /does not exist|not found/i.test(error.message)
  );
}

function isBucketNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "NoSuchBucket" ||
      error.name === "NotFound" ||
      /\b(bucket|specified bucket)\b.*\b(does not exist|not found)\b/i.test(
        error.message,
      ))
  );
}

function isDynamoDbResourceNotFoundError(error: unknown): boolean {
  if (
    !(error instanceof AwsPreviewDestroyError) ||
    error.code !== "AWS_DESTROY_OPERATION_FAILED"
  ) {
    return false;
  }

  const details = error.details;

  return (
    "cause" in details &&
    typeof details.cause === "object" &&
    details.cause.name === "ResourceNotFoundException"
  );
}

function isFailedStackStatus(status: string): boolean {
  return (
    status.endsWith("_FAILED") ||
    status === "ROLLBACK_COMPLETE" ||
    status === "UPDATE_ROLLBACK_COMPLETE" ||
    status === "DELETE_COMPLETE"
  );
}

function isFailureEvent(event: StackEvent): boolean {
  return (
    typeof event.ResourceStatus === "string" &&
    isFailedStackStatus(event.ResourceStatus)
  );
}

function toFailureEvent(event: StackEvent): AwsStackFailureEvent {
  const failure: AwsStackFailureEvent = {
    logicalResourceId: event.LogicalResourceId ?? "UnknownResource",
    resourceStatus: event.ResourceStatus ?? "UNKNOWN",
    reason: event.ResourceStatusReason ?? "No failure reason reported.",
  };

  if (event.ResourceType !== undefined) {
    failure.resourceType = event.ResourceType;
  }

  return failure;
}
