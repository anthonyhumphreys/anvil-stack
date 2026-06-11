import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { AwsDeployArtifact } from "./artifacts.js";
import { createAwsResourceNames } from "./cloudformation.js";
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
    const stackName = stackNameFor(
      input.plan.cell,
      input.environment,
      this.options.stackNamePrefix,
    );
    const serverKey = artifactKey(input.artifacts.lambda);

    await this.uploadArtifact(input.artifacts.lambda, serverKey);
    await this.uploadArtifact(
      input.artifacts.template,
      artifactKey(input.artifacts.template),
    );
    await this.uploadArtifact(
      input.artifacts.manifest,
      artifactKey(input.artifacts.manifest),
    );
    await this.applyStack(input, stackName, serverKey);

    const stack = await this.waitForStack(stackName);
    const outputs = outputsFrom(stack);
    const clientAssetsBucket = requiredOutput(
      outputs,
      "ClientAssetsBucketName",
    );

    await Promise.all(
      input.artifacts.clientAssets.map((artifact) =>
        this.uploadArtifact(artifact, artifact.key, clientAssetsBucket),
      ),
    );

    const deploymentId = `dep_${Date.now().toString(36)}`;
    const metadataTable = requiredOutput(
      outputs,
      "DeploymentMetadataTableName",
    );

    await this.publishDeploymentMetadata({
      tableName: metadataTable,
      deploymentId,
      input,
      stackName,
      outputs,
    });

    return {
      deploymentId,
      url: requiredOutput(outputs, "RuntimeUrl"),
      resources: {
        stack: stackName,
        runtimeUrl: requiredOutput(outputs, "RuntimeUrl"),
        lambda: createAwsResourceNames(input.plan.cell, input.environment)
          .runtimeFunction,
        assetsBucket: clientAssetsBucket,
        logs: requiredOutput(outputs, "RuntimeLogGroupName"),
        deploymentMetadataTable: metadataTable,
        ...(outputs.CellDataTableName
          ? { database: outputs.CellDataTableName }
          : {}),
        ...(outputs.CellFilesBucketName
          ? { files: outputs.CellFilesBucketName }
          : {}),
      },
    };
  }

  private async uploadArtifact(
    artifact: AwsDeployArtifact,
    key: string,
    bucket = this.options.artifactBucket,
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from(artifact.body),
        ContentType: artifact.contentType,
      }),
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
      await this.cloudFormation.send(
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
      );
      created = true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      try {
        await this.cloudFormation.send(
          new UpdateStackCommand({
            StackName: stackName,
            TemplateBody: templateBody,
            Capabilities: ["CAPABILITY_NAMED_IAM"],
            Parameters: parameters,
          }),
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
    const response = await this.cloudFormation.send(
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

  private async waitForStack(stackName: string): Promise<Stack> {
    const maxAttempts = this.options.stackMaxPollAttempts ?? 60;
    const delayMs = this.options.stackPollDelayMs ?? 5000;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const stack = await this.describeStack(stackName);
      const status = stack.StackStatus;

      if (status && isFailedStackStatus(status)) {
        throw new Error(
          `CloudFormation stack '${stackName}' finished with status '${status}'.`,
        );
      }

      if (!status || !status.endsWith("_IN_PROGRESS")) {
        return stack;
      }

      await delay(delayMs);
    }

    throw new Error(
      `CloudFormation stack '${stackName}' did not finish within ${maxAttempts} attempts.`,
    );
  }

  private async publishDeploymentMetadata(input: {
    tableName: string;
    deploymentId: string;
    input: AwsPreviewProvisionerInput;
    stackName: string;
    outputs: Record<string, string>;
  }): Promise<void> {
    await this.dynamodb.send(
      new PutItemCommand({
        TableName: input.tableName,
        Item: {
          pk: {
            S: `deployment#${input.input.plan.cell}#${input.input.environment}`,
          },
          deploymentId: { S: input.deploymentId },
          cell: { S: input.input.plan.cell },
          environment: { S: input.input.environment },
          stackName: { S: input.stackName },
          runtimeUrl: { S: requiredOutput(input.outputs, "RuntimeUrl") },
          manifest: { S: JSON.stringify(input.input.manifest) },
          outputs: { S: JSON.stringify(input.outputs) },
          updatedAt: { S: new Date().toISOString() },
        },
      }),
    );
  }
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

function stackNameFor(
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

function requiredOutput(outputs: Record<string, string>, key: string): string {
  const value = outputs[key];

  if (!value) {
    throw new Error(`CloudFormation output '${key}' is required.`);
  }

  return value;
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

function isFailedStackStatus(status: string): boolean {
  return (
    status.endsWith("_FAILED") ||
    status === "ROLLBACK_COMPLETE" ||
    status === "UPDATE_ROLLBACK_COMPLETE" ||
    status === "DELETE_COMPLETE"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
