import type { CellManifest } from "@anvil-cloud/builder";

import type { DeploymentEnvironment } from "./index.js";

export type CloudFormationTemplate = {
  AWSTemplateFormatVersion: "2010-09-09";
  Description: string;
  Parameters: Record<string, CloudFormationParameter>;
  Resources: Record<string, CloudFormationResource>;
  Outputs: Record<string, CloudFormationOutput>;
};

export type CloudFormationParameter = {
  Type: string;
  Description?: string;
};

export type CloudFormationResource = {
  Type: string;
  Properties: Record<string, unknown>;
};

export type CloudFormationOutput = {
  Description?: string;
  Value: unknown;
};

export type AwsPreviewTemplateOptions = {
  environment?: DeploymentEnvironment;
  serverBucketParameter?: string;
  serverKeyParameter?: string;
};

export function createAwsPreviewCloudFormationTemplate(
  manifest: CellManifest,
  options: AwsPreviewTemplateOptions = {},
): CloudFormationTemplate {
  const environment = options.environment ?? "preview";
  const names = createAwsResourceNames(manifest.cell.name, environment);
  const serverBucketParameter =
    options.serverBucketParameter ?? "ServerBundleBucket";
  const serverKeyParameter = options.serverKeyParameter ?? "ServerBundleKey";
  const runtimeEnvironmentVariables: Record<string, unknown> = {
    ANVIL_CELL: manifest.cell.name,
    ANVIL_ENV: environment,
    ANVIL_AWS_DEPLOYMENT_METADATA_TABLE: {
      Ref: "DeploymentMetadataTable",
    },
  };
  const resources: Record<string, CloudFormationResource> = {
    RuntimeRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        RoleName: names.runtimeRole,
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: {
                Service: "lambda.amazonaws.com",
              },
              Action: "sts:AssumeRole",
            },
          ],
        },
        Policies: [
          {
            PolicyName: `${names.base}-runtime`,
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: createRuntimePolicyStatements(manifest),
            },
          },
        ],
      },
    },
    RuntimeFunction: {
      Type: "AWS::Lambda::Function",
      Properties: {
        FunctionName: names.runtimeFunction,
        Runtime: runtimeFor(manifest.cell.runtime),
        Handler: "index.handler",
        Role: { "Fn::GetAtt": ["RuntimeRole", "Arn"] },
        Code: {
          S3Bucket: { Ref: serverBucketParameter },
          S3Key: { Ref: serverKeyParameter },
        },
        Environment: {
          Variables: runtimeEnvironmentVariables,
        },
      },
    },
    RuntimeFunctionUrl: {
      Type: "AWS::Lambda::Url",
      Properties: {
        AuthType: "NONE",
        TargetFunctionArn: { Ref: "RuntimeFunction" },
      },
    },
    RuntimeFunctionUrlPermission: {
      Type: "AWS::Lambda::Permission",
      Properties: {
        Action: "lambda:InvokeFunctionUrl",
        FunctionName: { Ref: "RuntimeFunction" },
        Principal: "*",
        FunctionUrlAuthType: "NONE",
      },
    },
    ClientAssetsBucket: {
      Type: "AWS::S3::Bucket",
      Properties: {
        BucketName: names.clientAssetsBucket,
      },
    },
    RuntimeLogGroup: {
      Type: "AWS::Logs::LogGroup",
      Properties: {
        LogGroupName: `/aws/lambda/${names.runtimeFunction}`,
        RetentionInDays: 14,
      },
    },
    DeploymentMetadataTable: {
      Type: "AWS::DynamoDB::Table",
      Properties: {
        TableName: names.deploymentMetadataTable,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          {
            AttributeName: "pk",
            AttributeType: "S",
          },
        ],
        KeySchema: [
          {
            AttributeName: "pk",
            KeyType: "HASH",
          },
        ],
      },
    },
  };
  const outputs: Record<string, CloudFormationOutput> = {
    RuntimeUrl: {
      Description:
        "Public runtime URL for Anvil query, mutation, and endpoint traffic.",
      Value: { "Fn::GetAtt": ["RuntimeFunctionUrl", "FunctionUrl"] },
    },
    ClientAssetsBucketName: {
      Description: "S3 bucket for built client assets.",
      Value: { Ref: "ClientAssetsBucket" },
    },
    RuntimeLogGroupName: {
      Description: "CloudWatch log group for runtime logs.",
      Value: { Ref: "RuntimeLogGroup" },
    },
    DeploymentMetadataTableName: {
      Description: "DynamoDB table for deployment metadata.",
      Value: { Ref: "DeploymentMetadataTable" },
    },
  };

  if (manifest.capabilities.database === true) {
    runtimeEnvironmentVariables.ANVIL_CELL_DATA_TABLE = {
      Ref: "CellDataTable",
    };
    resources.CellDataTable = {
      Type: "AWS::DynamoDB::Table",
      Properties: {
        TableName: names.cellDataTable,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          {
            AttributeName: "pk",
            AttributeType: "S",
          },
          {
            AttributeName: "sk",
            AttributeType: "S",
          },
        ],
        KeySchema: [
          {
            AttributeName: "pk",
            KeyType: "HASH",
          },
          {
            AttributeName: "sk",
            KeyType: "RANGE",
          },
        ],
      },
    };
    outputs.CellDataTableName = {
      Description: "DynamoDB table for Cell-owned data.",
      Value: { Ref: "CellDataTable" },
    };
  }

  if (manifest.capabilities.files) {
    runtimeEnvironmentVariables.ANVIL_FILES_BUCKET = {
      Ref: "CellFilesBucket",
    };
    resources.CellFilesBucket = {
      Type: "AWS::S3::Bucket",
      Properties: {
        BucketName: names.filesBucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
    };
    outputs.CellFilesBucketName = {
      Description: "S3 bucket for Cell-owned files.",
      Value: { Ref: "CellFilesBucket" },
    };
  }

  if (manifest.jobs.length > 0) {
    runtimeEnvironmentVariables.ANVIL_JOB_QUEUE_URL = {
      Ref: "CellJobQueue",
    };
    resources.CellJobQueue = {
      Type: "AWS::SQS::Queue",
      Properties: {
        QueueName: names.jobQueue,
      },
    };
    resources.CellJobQueueEventSourceMapping = {
      Type: "AWS::Lambda::EventSourceMapping",
      Properties: {
        FunctionName: { Ref: "RuntimeFunction" },
        EventSourceArn: { "Fn::GetAtt": ["CellJobQueue", "Arn"] },
        BatchSize: 10,
        FunctionResponseTypes: ["ReportBatchItemFailures"],
      },
    };
    outputs.CellJobQueueUrl = {
      Description: "SQS queue URL for queued Cell jobs.",
      Value: { Ref: "CellJobQueue" },
    };

    for (const job of manifest.jobs) {
      if (!job.schedule) {
        continue;
      }

      const logicalName = logicalIdPart(job.name);
      const ruleId = `ScheduledJob${logicalName}Rule`;
      const permissionId = `ScheduledJob${logicalName}Permission`;

      resources[ruleId] = {
        Type: "AWS::Events::Rule",
        Properties: {
          Name: withSuffix(
            names.base,
            sanitizeName(`job-${job.name}`, 24) || "job",
            64,
          ),
          ScheduleExpression: job.schedule,
          State: "ENABLED",
          Targets: [
            {
              Arn: { "Fn::GetAtt": ["RuntimeFunction", "Arn"] },
              Id: `RuntimeFunction${logicalName}`,
              Input: JSON.stringify({
                source: "anvil.jobs",
                detail: {
                  name: job.name,
                  payload: null,
                },
              }),
            },
          ],
        },
      };
      resources[permissionId] = {
        Type: "AWS::Lambda::Permission",
        Properties: {
          Action: "lambda:InvokeFunction",
          FunctionName: { Ref: "RuntimeFunction" },
          Principal: "events.amazonaws.com",
          SourceArn: { "Fn::GetAtt": [ruleId, "Arn"] },
        },
      };
    }
  }

  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Anvil Cloud preview deployment for ${manifest.cell.name}.`,
    Parameters: {
      [serverBucketParameter]: {
        Type: "String",
        Description:
          "S3 bucket containing the bundled Lambda runtime artifact.",
      },
      [serverKeyParameter]: {
        Type: "String",
        Description: "S3 key for the bundled Lambda runtime artifact.",
      },
    },
    Resources: resources,
    Outputs: outputs,
  };
}

export type AwsResourceNames = {
  base: string;
  runtimeFunction: string;
  runtimeRole: string;
  clientAssetsBucket: string;
  cellDataTable: string;
  deploymentMetadataTable: string;
  filesBucket: string;
  jobQueue: string;
};

export function createAwsResourceNames(
  cellName: string,
  environment: DeploymentEnvironment,
): AwsResourceNames {
  const base = sanitizeName(`anvil-${cellName}-${environment}`, 48);

  return {
    base,
    runtimeFunction: base,
    runtimeRole: `${base}-runtime-role`,
    clientAssetsBucket: withSuffix(base, "assets", 63),
    cellDataTable: `${base}-data`,
    deploymentMetadataTable: `${base}-deployments`,
    filesBucket: withSuffix(base, "files", 63),
    jobQueue: withSuffix(base, "jobs", 80),
  };
}

function createRuntimePolicyStatements(
  manifest: CellManifest,
): Array<Record<string, unknown>> {
  const statements: Array<Record<string, unknown>> = [
    {
      Effect: "Allow",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: "*",
    },
  ];

  if (manifest.capabilities.database === true) {
    statements.push({
      Effect: "Allow",
      Action: [
        "dynamodb:BatchGetItem",
        "dynamodb:BatchWriteItem",
        "dynamodb:DeleteItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:UpdateItem",
      ],
      Resource: { "Fn::GetAtt": ["CellDataTable", "Arn"] },
    });
  }

  if (manifest.capabilities.files) {
    statements.push({
      Effect: "Allow",
      Action: ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"],
      Resource: {
        "Fn::Sub": "${CellFilesBucket.Arn}/*",
      },
    });
  }

  if (manifest.jobs.length > 0) {
    statements.push({
      Effect: "Allow",
      Action: [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage",
        "sqs:SendMessage",
      ],
      Resource: { "Fn::GetAtt": ["CellJobQueue", "Arn"] },
    });
  }

  return statements;
}

function runtimeFor(runtime: string): string {
  switch (runtime) {
    case "nodejs20":
      return "nodejs20.x";
    case "nodejs22":
      return "nodejs22.x";
    default:
      return "nodejs20.x";
  }
}

function withSuffix(base: string, suffix: string, maxLength: number): string {
  const suffixWithDash = `-${suffix}`;
  const trimmedBase = base.slice(0, maxLength - suffixWithDash.length);

  return `${trimmedBase}${suffixWithDash}`;
}

function sanitizeName(value: string, maxLength: number): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength)
    .replace(/-$/g, "");
}

function logicalIdPart(value: string): string {
  const normalized = value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");

  return normalized.length > 0 ? normalized : "Job";
}
