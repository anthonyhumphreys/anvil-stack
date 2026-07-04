import type { CellManifest } from "@anvil-cloud/builder";

import type { DeploymentEnvironment } from "./index.js";

const runtimeTimeoutSeconds = 30;
const runtimeMemoryMb = 256;
const jobQueueVisibilityTimeoutSeconds = runtimeTimeoutSeconds * 2;
const serviceCpu = "256";
const serviceMemoryMb = "512";

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
  const workflows = manifest.workflows ?? [];
  const services = manifest.services ?? [];
  const runtimeEnvironmentVariables: Record<string, unknown> = {
    ANVIL_CELL: manifest.cell.name,
    ANVIL_ENV: environment,
    ANVIL_AWS_DEPLOYMENT_METADATA_TABLE: {
      Ref: "DeploymentMetadataTable",
    },
  };
  const outboundFetchAllowList = outboundFetchAllowListFor(
    manifest.capabilities.outboundFetch,
  );

  if (outboundFetchAllowList.length > 0) {
    runtimeEnvironmentVariables.ANVIL_OUTBOUND_FETCH_ALLOW =
      outboundFetchAllowList.join(",");
  }

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
        MemorySize: runtimeMemoryMb,
        Timeout: runtimeTimeoutSeconds,
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
        ...privateBucketProperties(),
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
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
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
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
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
        ...privateBucketProperties(),
      },
    };
    outputs.CellFilesBucketName = {
      Description: "S3 bucket for Cell-owned files.",
      Value: { Ref: "CellFilesBucket" },
    };
  }

  if (manifest.capabilities.events) {
    runtimeEnvironmentVariables.ANVIL_EVENT_BUS_NAME = {
      Ref: "CellEventBus",
    };
    resources.CellEventBus = {
      Type: "AWS::Events::EventBus",
      Properties: {
        Name: names.eventBus,
      },
    };
    outputs.CellEventBusName = {
      Description: "EventBridge bus for Cell-published events.",
      Value: { Ref: "CellEventBus" },
    };
  }

  if (manifest.jobs.length > 0) {
    runtimeEnvironmentVariables.ANVIL_JOB_QUEUE_URL = {
      Ref: "CellJobQueue",
    };
    resources.CellJobDeadLetterQueue = {
      Type: "AWS::SQS::Queue",
      Properties: {
        QueueName: names.jobDeadLetterQueue,
        MessageRetentionPeriod: 1_209_600,
      },
    };
    resources.CellJobQueue = {
      Type: "AWS::SQS::Queue",
      Properties: {
        QueueName: names.jobQueue,
        VisibilityTimeout: jobQueueVisibilityTimeoutSeconds,
        RedrivePolicy: {
          deadLetterTargetArn: {
            "Fn::GetAtt": ["CellJobDeadLetterQueue", "Arn"],
          },
          maxReceiveCount: 3,
        },
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
    outputs.CellJobDeadLetterQueueUrl = {
      Description: "SQS dead-letter queue URL for failed Cell jobs.",
      Value: { Ref: "CellJobDeadLetterQueue" },
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

  if (workflows.length > 0) {
    runtimeEnvironmentVariables.ANVIL_WORKFLOW_STATE_MACHINES = {
      "Fn::Sub": JSON.stringify(
        Object.fromEntries(
          workflows.map((workflow) => [
            workflow.name,
            `\${Workflow${logicalIdPart(workflow.name)}StateMachine}`,
          ]),
        ),
      ),
    };
    resources.WorkflowStateMachineRole = {
      Type: "AWS::IAM::Role",
      Properties: {
        RoleName: names.workflowStateMachineRole,
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: {
                Service: "states.amazonaws.com",
              },
              Action: "sts:AssumeRole",
            },
          ],
        },
        Policies: [
          {
            PolicyName: `${names.base}-workflows`,
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["lambda:InvokeFunction"],
                  Resource: { "Fn::GetAtt": ["RuntimeFunction", "Arn"] },
                },
              ],
            },
          },
        ],
      },
    };

    for (const workflow of workflows) {
      const logicalName = logicalIdPart(workflow.name);
      const stateMachineId = `Workflow${logicalName}StateMachine`;

      resources[stateMachineId] = {
        Type: "AWS::StepFunctions::StateMachine",
        Properties: {
          StateMachineName: withSuffix(
            names.base,
            sanitizeName(`workflow-${workflow.name}`, 24) || "workflow",
            80,
          ),
          RoleArn: { "Fn::GetAtt": ["WorkflowStateMachineRole", "Arn"] },
          DefinitionString: {
            "Fn::Sub": JSON.stringify(
              createWorkflowStateMachineDefinition(workflow),
            ),
          },
        },
      };
      outputs[`Workflow${logicalName}StateMachineArn`] = {
        Description: `Step Functions state machine ARN for workflow '${workflow.name}'.`,
        Value: { Ref: stateMachineId },
      };
    }
  }

  if (services.length > 0) {
    resources.ServiceCluster = {
      Type: "AWS::ECS::Cluster",
      Properties: {
        ClusterName: names.serviceCluster,
      },
    };
    resources.ServiceTaskExecutionRole = {
      Type: "AWS::IAM::Role",
      Properties: {
        RoleName: names.serviceTaskExecutionRole,
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: {
                Service: "ecs-tasks.amazonaws.com",
              },
              Action: "sts:AssumeRole",
            },
          ],
        },
        ManagedPolicyArns: [
          "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
        ],
      },
    };
    resources.ServiceLogGroup = {
      Type: "AWS::Logs::LogGroup",
      Properties: {
        LogGroupName: `/ecs/${names.base}-services`,
        RetentionInDays: 14,
      },
    };

    services.forEach((service) => {
      const logicalName = logicalIdPart(service.name);
      const taskId = `Service${logicalName}TaskDefinition`;
      const serviceId = `Service${logicalName}`;

      resources[taskId] = {
        Type: "AWS::ECS::TaskDefinition",
        Properties: {
          Family: withSuffix(
            names.base,
            sanitizeName(`service-${service.name}`, 24) || "service",
            255,
          ),
          Cpu: serviceCpu,
          Memory: serviceMemoryMb,
          NetworkMode: "awsvpc",
          RequiresCompatibilities: ["FARGATE"],
          ExecutionRoleArn: {
            "Fn::GetAtt": ["ServiceTaskExecutionRole", "Arn"],
          },
          ContainerDefinitions: [
            {
              Name: sanitizeName(service.name, 64) || "service",
              Image: "public.ecr.aws/docker/library/node:20-alpine",
              Essential: true,
              Command: [
                "node",
                "-e",
                `console.log(${JSON.stringify(`Anvil preview service '${service.name}' is provisioned by the adapter.`)}); setInterval(() => {}, 60000);`,
              ],
              Environment: [
                { Name: "ANVIL_CELL", Value: manifest.cell.name },
                { Name: "ANVIL_ENV", Value: environment },
                { Name: "ANVIL_SERVICE", Value: service.name },
              ],
              LogConfiguration: {
                LogDriver: "awslogs",
                Options: {
                  "awslogs-group": { Ref: "ServiceLogGroup" },
                  "awslogs-region": { Ref: "AWS::Region" },
                  "awslogs-stream-prefix": "anvil-service",
                },
              },
            },
          ],
        },
      };
      resources[serviceId] = {
        Type: "AWS::ECS::Service",
        Properties: {
          Cluster: { Ref: "ServiceCluster" },
          DesiredCount: 1,
          LaunchType: "FARGATE",
          TaskDefinition: { Ref: taskId },
          NetworkConfiguration: {
            AwsvpcConfiguration: {
              AssignPublicIp: "ENABLED",
              Subnets: { Ref: "ServiceSubnetIds" },
            },
          },
        },
      };
      outputs[`Service${logicalName}Name`] = {
        Description: `ECS service name for Cell service '${service.name}'.`,
        Value: { "Fn::GetAtt": [serviceId, "Name"] },
      };
    });

    outputs.ServiceClusterName = {
      Description: "ECS cluster for preview service handlers.",
      Value: { Ref: "ServiceCluster" },
    };
    outputs.ServiceLogGroupName = {
      Description: "CloudWatch log group for preview service handlers.",
      Value: { Ref: "ServiceLogGroup" },
    };
  }

  const parameters: Record<string, CloudFormationParameter> = {
    [serverBucketParameter]: {
      Type: "String",
      Description: "S3 bucket containing the bundled Lambda runtime artifact.",
    },
    [serverKeyParameter]: {
      Type: "String",
      Description: "S3 key for the bundled Lambda runtime artifact.",
    },
  };

  if (services.length > 0) {
    parameters.ServiceSubnetIds = {
      Type: "List<AWS::EC2::Subnet::Id>",
      Description:
        "Subnet ids (typically public subnets with internet egress) used by adapter-owned ECS/Fargate preview services.",
    };
  }

  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: `Anvil Cloud preview deployment for ${manifest.cell.name}.`,
    Parameters: parameters,
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
  jobDeadLetterQueue: string;
  eventBus: string;
  workflowStateMachineRole: string;
  serviceCluster: string;
  serviceTaskExecutionRole: string;
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
    jobDeadLetterQueue: withSuffix(base, "jobs-dlq", 80),
    eventBus: withSuffix(base, "events", 80),
    workflowStateMachineRole: `${base}-workflow-role`,
    serviceCluster: withSuffix(base, "services", 255),
    serviceTaskExecutionRole: `${base}-service-task-role`,
  };
}

function createWorkflowStateMachineDefinition(workflow: {
  name: string;
  steps: string[];
}): Record<string, unknown> {
  const states: Record<string, unknown> = {};

  workflow.steps.forEach((step, index) => {
    const nextStep = workflow.steps[index + 1];

    states[step] = {
      Type: "Task",
      Resource: "${RuntimeFunction.Arn}",
      Parameters: {
        source: "anvil.workflows",
        detail: {
          workflow: workflow.name,
          step,
          "runId.$": "$.runId",
          "input.$": "$.input",
          "steps.$": "$.steps",
        },
      },
      ResultPath: "$",
      ...(nextStep ? { Next: nextStep } : { End: true }),
    };
  });

  return {
    Comment: `Anvil workflow ${workflow.name}.`,
    StartAt: workflow.steps[0] ?? "Complete",
    States:
      workflow.steps.length > 0
        ? states
        : {
            Complete: {
              Type: "Succeed",
            },
          },
  };
}

function createRuntimePolicyStatements(
  manifest: CellManifest,
): Array<Record<string, unknown>> {
  const statements: Array<Record<string, unknown>> = [
    {
      Effect: "Allow",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: {
        "Fn::Sub": "${RuntimeLogGroup.Arn}:*",
      },
    },
  ];

  if (manifest.capabilities.database === true) {
    statements.push({
      Effect: "Allow",
      Action: [
        "dynamodb:DeleteItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:Scan",
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

  if (manifest.capabilities.events) {
    statements.push({
      Effect: "Allow",
      Action: ["events:PutEvents"],
      Resource: { "Fn::GetAtt": ["CellEventBus", "Arn"] },
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

function privateBucketProperties(): Record<string, unknown> {
  return {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: "AES256",
          },
        },
      ],
    },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  };
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

function outboundFetchAllowListFor(capability: unknown): string[] {
  if (!capability || typeof capability !== "object") {
    return [];
  }

  const allow = (capability as { allow?: unknown }).allow;

  if (!Array.isArray(allow)) {
    return [];
  }

  return allow.filter((value): value is string => typeof value === "string");
}
