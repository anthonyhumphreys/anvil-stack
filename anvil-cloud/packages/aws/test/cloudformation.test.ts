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
    expect(template.Resources.RuntimeFunction).toMatchObject({
      Type: "AWS::Lambda::Function",
      Properties: {
        Runtime: "nodejs20.x",
        Handler: "index.handler",
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
      CellJobQueue: {
        Type: "AWS::SQS::Queue",
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
  });
});

describe("createAwsResourceNames", () => {
  it("keeps generated S3 bucket names within AWS length limits", () => {
    const names = createAwsResourceNames(
      "this-cell-name-is-comically-long-because-tests-should-be-rude",
      "preview",
    );

    expect(names.clientAssetsBucket.length).toBeLessThanOrEqual(63);
    expect(names.filesBucket.length).toBeLessThanOrEqual(63);
    expect(names.clientAssetsBucket).toMatch(/^[a-z0-9-]+$/);
  });
});
