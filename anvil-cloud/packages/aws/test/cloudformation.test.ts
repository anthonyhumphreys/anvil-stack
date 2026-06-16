import { describe, expect, it } from "vitest";

import {
  createAwsPreviewCloudFormationTemplate,
  createAwsResourceNames,
} from "../src/index.js";

describe("createAwsPreviewCloudFormationTemplate", () => {
  it("maps Cell capabilities to AWS preview resources", () => {
    const template = createAwsPreviewCloudFormationTemplate({
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
        tables: {
          notes: {
            fields: {},
          },
        },
      },
      queries: ["listNotes"],
      mutations: ["createNote"],
      endpoints: [],
      jobs: [],
      capabilities: {
        database: true,
        files: {
          publicRead: false,
        },
      },
    });

    expect(template.Parameters).toMatchObject({
      ServerBundleBucket: {
        Type: "String",
      },
      ServerBundleKey: {
        Type: "String",
      },
    });
    expect(Object.keys(template.Resources)).toEqual(
      expect.arrayContaining([
        "RuntimeRole",
        "RuntimeFunction",
        "RuntimeFunctionUrl",
        "RuntimeFunctionUrlPermission",
        "RuntimeLogGroup",
        "ClientAssetsBucket",
        "DeploymentMetadataTable",
        "CellDataTable",
        "CellFilesBucket",
      ]),
    );
    expect(template.Resources.ClientAssetsBucket).toMatchObject({
      Type: "AWS::S3::Bucket",
      Properties: {
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
      },
    });
    expect(
      template.Resources.ClientAssetsBucket.Properties.BucketName,
    ).toBeUndefined();
    expect(template.Resources.CellFilesBucket).toMatchObject({
      Type: "AWS::S3::Bucket",
      Properties: {
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
      },
    });
    expect(
      template.Resources.CellFilesBucket.Properties.BucketName,
    ).toBeUndefined();
    expect(template.Resources.RuntimeFunction).toMatchObject({
      Type: "AWS::Lambda::Function",
      Properties: {
        Runtime: "nodejs20.x",
        Handler: "index.handler",
        MemorySize: 256,
        Timeout: 30,
        Environment: {
          Variables: {
            ANVIL_CELL: "notes",
            ANVIL_ENV: "preview",
            ANVIL_AWS_DEPLOYMENT_METADATA_TABLE: {
              Ref: "DeploymentMetadataTable",
            },
            ANVIL_CELL_DATA_TABLE: {
              Ref: "CellDataTable",
            },
            ANVIL_FILES_BUCKET: {
              Ref: "CellFilesBucket",
            },
          },
        },
      },
    });
    expect(template.Resources.DeploymentMetadataTable).toMatchObject({
      Type: "AWS::DynamoDB::Table",
      Properties: {
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      },
    });
    expect(template.Resources.CellDataTable).toMatchObject({
      Type: "AWS::DynamoDB::Table",
      Properties: {
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      },
    });
    expect(template.Resources.RuntimeRole).toMatchObject({
      Type: "AWS::IAM::Role",
      Properties: {
        Policies: [
          {
            PolicyDocument: {
              Statement: expect.arrayContaining([
                {
                  Effect: "Allow",
                  Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                  Resource: {
                    "Fn::Sub": "${RuntimeLogGroup.Arn}:*",
                  },
                },
                {
                  Effect: "Allow",
                  Action: [
                    "dynamodb:DeleteItem",
                    "dynamodb:GetItem",
                    "dynamodb:PutItem",
                    "dynamodb:Query",
                    "dynamodb:Scan",
                  ],
                  Resource: {
                    "Fn::GetAtt": ["CellDataTable", "Arn"],
                  },
                },
              ]),
            },
          },
        ],
      },
    });
    expect(template.Outputs).toMatchObject({
      RuntimeUrl: {
        Value: {
          "Fn::GetAtt": ["RuntimeFunctionUrl", "FunctionUrl"],
        },
      },
      CellDataTableName: {
        Value: {
          Ref: "CellDataTable",
        },
      },
      CellFilesBucketName: {
        Value: {
          Ref: "CellFilesBucket",
        },
      },
    });
  });

  it("omits optional database and file resources when capabilities are absent", () => {
    const template = createAwsPreviewCloudFormationTemplate({
      schemaVersion: "0.1",
      cell: {
        name: "simple",
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
    });

    expect(template.Resources.CellDataTable).toBeUndefined();
    expect(template.Resources.CellFilesBucket).toBeUndefined();
    expect(template.Outputs.CellDataTableName).toBeUndefined();
    expect(template.Outputs.CellFilesBucketName).toBeUndefined();
    expect(template.Resources.RuntimeFunction).toMatchObject({
      Properties: {
        Environment: {
          Variables: {
            ANVIL_CELL: "simple",
            ANVIL_AWS_DEPLOYMENT_METADATA_TABLE: {
              Ref: "DeploymentMetadataTable",
            },
          },
        },
      },
    });
    expect(
      template.Resources.RuntimeFunction.Properties.Environment,
    ).not.toMatchObject({
      Variables: {
        ANVIL_CELL_DATA_TABLE: expect.anything(),
        ANVIL_FILES_BUCKET: expect.anything(),
      },
    });
  });

  it("maps declared jobs to SQS and EventBridge resources", () => {
    const template = createAwsPreviewCloudFormationTemplate({
      schemaVersion: "0.1",
      cell: {
        name: "jobs-cell",
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
      jobs: [
        {
          name: "refreshNotes",
          schedule: "rate(1 hour)",
        },
        {
          name: "sendDigest",
        },
      ],
      capabilities: {
        scheduledJobs: true,
      },
    });

    expect(template.Resources).toMatchObject({
      CellJobDeadLetterQueue: {
        Type: "AWS::SQS::Queue",
        Properties: {
          MessageRetentionPeriod: 1_209_600,
        },
      },
      CellJobQueue: {
        Type: "AWS::SQS::Queue",
        Properties: {
          VisibilityTimeout: 60,
          RedrivePolicy: {
            deadLetterTargetArn: {
              "Fn::GetAtt": ["CellJobDeadLetterQueue", "Arn"],
            },
            maxReceiveCount: 3,
          },
        },
      },
      CellJobQueueEventSourceMapping: {
        Type: "AWS::Lambda::EventSourceMapping",
        Properties: {
          EventSourceArn: {
            "Fn::GetAtt": ["CellJobQueue", "Arn"],
          },
          FunctionResponseTypes: ["ReportBatchItemFailures"],
        },
      },
      ScheduledJobRefreshNotesRule: {
        Type: "AWS::Events::Rule",
        Properties: {
          ScheduleExpression: "rate(1 hour)",
          Targets: [
            {
              Input: JSON.stringify({
                source: "anvil.jobs",
                detail: {
                  name: "refreshNotes",
                  payload: null,
                },
              }),
            },
          ],
        },
      },
      ScheduledJobRefreshNotesPermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          Principal: "events.amazonaws.com",
        },
      },
    });
    expect(template.Resources.RuntimeFunction).toMatchObject({
      Properties: {
        Environment: {
          Variables: {
            ANVIL_JOB_QUEUE_URL: {
              Ref: "CellJobQueue",
            },
          },
        },
      },
    });
    expect(template.Outputs.CellJobQueueUrl).toMatchObject({
      Value: {
        Ref: "CellJobQueue",
      },
    });
    expect(template.Outputs.CellJobDeadLetterQueueUrl).toMatchObject({
      Value: {
        Ref: "CellJobDeadLetterQueue",
      },
    });
  });

  it("maps declared workflows to Step Functions resources", () => {
    const template = createAwsPreviewCloudFormationTemplate({
      schemaVersion: "0.1",
      cell: {
        name: "workflow-cell",
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
      workflows: [
        {
          name: "syncNotes",
          steps: ["fetch", "store"],
        },
      ],
      services: [],
      capabilities: {
        workflows: true,
      },
    });

    expect(template.Resources.WorkflowStateMachineRole).toMatchObject({
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: {
          Statement: [
            expect.objectContaining({
              Principal: {
                Service: "states.amazonaws.com",
              },
            }),
          ],
        },
        Policies: [
          {
            PolicyDocument: {
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
    });
    expect(template.Resources.WorkflowSyncNotesStateMachine).toMatchObject({
      Type: "AWS::StepFunctions::StateMachine",
      Properties: {
        RoleArn: { "Fn::GetAtt": ["WorkflowStateMachineRole", "Arn"] },
        DefinitionString: {
          "Fn::Sub": expect.any(String),
        },
      },
    });

    const definition = JSON.parse(
      template.Resources.WorkflowSyncNotesStateMachine.Properties
        .DefinitionString["Fn::Sub"] as string,
    ) as Record<string, any>;

    expect(definition).toMatchObject({
      StartAt: "fetch",
      States: {
        fetch: {
          Type: "Task",
          Resource: "${RuntimeFunction.Arn}",
          Next: "store",
          Parameters: {
            source: "anvil.workflows",
            detail: {
              workflow: "syncNotes",
              step: "fetch",
              "runId.$": "$.runId",
              "input.$": "$.input",
              "steps.$": "$.steps",
            },
          },
        },
        store: {
          Type: "Task",
          Resource: "${RuntimeFunction.Arn}",
          End: true,
        },
      },
    });
    expect(template.Outputs.WorkflowSyncNotesStateMachineArn).toMatchObject({
      Value: {
        Ref: "WorkflowSyncNotesStateMachine",
      },
    });
  });
});

describe("createAwsResourceNames", () => {
  it("keeps generated named resource identifiers within AWS length limits", () => {
    const names = createAwsResourceNames(
      "this-cell-name-is-comically-long-because-tests-should-be-rude",
      "preview",
    );

    expect(names.jobQueue.length).toBeLessThanOrEqual(80);
    expect(names.jobDeadLetterQueue.length).toBeLessThanOrEqual(80);
    expect(names.eventBus.length).toBeLessThanOrEqual(80);
    expect(names.workflowStateMachineRole.length).toBeLessThanOrEqual(64);
    expect(names.jobQueue).toMatch(/^[a-z0-9-]+$/);
  });
});
