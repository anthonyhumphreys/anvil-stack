import type { BuildOutput, CellManifest } from "@anvil-cloud/builder";
import { AwsPreviewProvisioningError } from "./aws-provisioner.js";
import {
  createAwsPreviewDeployArtifacts,
  summarizeAwsPreviewDeployArtifacts,
  type AwsPreviewDeployArtifactSummary,
} from "./artifacts.js";
export {
  AwsPreviewProvisioningError,
  AwsPreviewDestroyError,
  AwsSdkPreviewDestroyer,
  AwsSdkPreviewProvisioner,
  createAwsSdkPreviewDestroyerFromEnv,
  createAwsSdkPreviewProvisionerFromEnv,
  type AwsPreviewDestroyErrorCode,
  type AwsPreviewDestroyInput,
  type AwsPreviewDestroyResult,
  type AwsStackFailureEvent,
  type AwsSdkPreviewDestroyerOptions,
  type AwsSdkPreviewProvisionerOptions,
} from "./aws-provisioner.js";
import {
  createAwsPreviewCloudFormationTemplate,
  type CloudFormationTemplate,
} from "./cloudformation.js";
import type { AwsPreviewProvisioner } from "./provisioner.js";

export {
  createAwsPreviewDeployArtifacts,
  summarizeAwsPreviewDeployArtifacts,
  type AwsDeployArtifact,
  type AwsPreviewDeployArtifactSummary,
  type AwsPreviewDeployArtifacts,
} from "./artifacts.js";
export {
  createAwsPreviewCloudFormationTemplate,
  createAwsResourceNames,
  type AwsPreviewTemplateOptions,
  type AwsResourceNames,
  type CloudFormationOutput,
  type CloudFormationParameter,
  type CloudFormationResource,
  type CloudFormationTemplate,
} from "./cloudformation.js";
export {
  awsHttpEventToRuntimeRequest,
  createAwsRuntimeHandler,
  runtimeResponseToAwsHttpResponse,
  type AwsHttpEvent,
  type AwsHttpResponse,
  type AwsRuntimeHandler,
} from "./http.js";
export {
  AwsDynamoDbDatabaseAdapter,
  AwsS3FileAdapter,
  createAwsRuntimeHostFromEnv,
  type AwsRuntimeHostOptions,
} from "./host.js";
export {
  createAwsLambdaRuntimeHandler,
  type AwsLambdaRuntimeEvent,
  type AwsLambdaRuntimeHandler,
  type AwsLambdaRuntimeResult,
  type AwsScheduledJobEvent,
  type AwsSqsEvent,
} from "./lambda.js";
export {
  type AwsPreviewProvisioner,
  type AwsPreviewProvisionerInput,
  type AwsPreviewProvisionerResult,
} from "./provisioner.js";
export {
  AwsRemoteReaderError,
  AwsRemoteReader,
  createAwsRemoteReaderFromEnv,
  type AwsRemoteInspectResult,
  type AwsRemoteLogEntry,
  type AwsRemoteLogsResult,
  type AwsRemoteReaderErrorCode,
  type AwsRemoteReaderOptions,
} from "./remote.js";

export type DeploymentEnvironment = "preview";

export type DeploymentPlanChange = {
  kind: "create" | "update" | "reuse";
  concept:
    | "audit"
    | "client-assets"
    | "database"
    | "environment"
    | "events"
    | "files"
    | "http-ingress"
    | "jobs"
    | "logs"
    | "runtime";
  name: string;
  details?: Record<string, unknown>;
};

export type DeploymentPlan = {
  schemaVersion: "0.1";
  adapter: "aws";
  environment: DeploymentEnvironment;
  cell: string;
  changes: DeploymentPlanChange[];
  warnings: string[];
  operations: DeploymentPlanOperations;
};

export type DeploymentPlanOperations = {
  rollback: {
    supported: boolean;
    strategy: "redeploy-previous-artifact" | "manual";
    commands: string[];
    notes: string[];
  };
  cost: {
    billingMode: "usage-based-preview";
    drivers: string[];
    notes: string[];
  };
  cleanup: {
    commands: string[];
    notes: string[];
  };
};

export type AwsPreviewSupportDiagnostic = {
  code: "AWS_PREVIEW_UNSUPPORTED_FEATURE";
  feature: "outboundFetch" | "services" | "workflows";
  message: string;
  hint: string;
  names: string[];
};

export type DeploymentResult =
  | {
      ok: true;
      deploymentId: string;
      environment: DeploymentEnvironment;
      url: string;
      resources: Record<string, string>;
      next: string[];
      plan: DeploymentPlan;
      template: CloudFormationTemplate;
      artifacts: AwsPreviewDeployArtifactSummary;
    }
  | {
      ok: false;
      code: string;
      message: string;
      hint?: string;
      plan: DeploymentPlan;
      template: CloudFormationTemplate;
      artifacts?: AwsPreviewDeployArtifactSummary;
      diagnostics?: AwsPreviewSupportDiagnostic[];
      details?: Record<string, unknown>;
    };

export type AwsPreviewDeploymentSynthesis = {
  plan: DeploymentPlan;
  template: CloudFormationTemplate;
};

export type AwsPreviewDeployInput = {
  manifest: CellManifest;
  buildOutput?: BuildOutput;
  environment?: DeploymentEnvironment;
};

export interface DeploymentAdapter {
  readonly name: string;
  plan(
    manifest: CellManifest,
    environment: DeploymentEnvironment,
  ): DeploymentPlan;
  deploy(
    manifest: CellManifest,
    environment: DeploymentEnvironment,
  ): Promise<DeploymentResult>;
}

export type AwsPreviewDeploymentAdapterOptions = {
  provisioner?: AwsPreviewProvisioner;
};

export class AwsPreviewDeploymentAdapter implements DeploymentAdapter {
  readonly name = "aws";

  constructor(
    private readonly options: AwsPreviewDeploymentAdapterOptions = {},
  ) {}

  plan(
    manifest: CellManifest,
    environment: DeploymentEnvironment = "preview",
  ): DeploymentPlan {
    return createAwsPreviewDeploymentPlan(manifest, environment);
  }

  synthesize(
    manifest: CellManifest,
    environment: DeploymentEnvironment = "preview",
  ): AwsPreviewDeploymentSynthesis {
    return synthesizeAwsPreviewDeployment(manifest, environment);
  }

  async deploy(
    input: CellManifest | AwsPreviewDeployInput,
    environment: DeploymentEnvironment = "preview",
  ): Promise<DeploymentResult> {
    const deployInput = normalizeDeployInput(input, environment);
    const synthesis = this.synthesize(
      deployInput.manifest,
      deployInput.environment ?? "preview",
    );
    const supportDiagnostics = checkAwsPreviewSupport(deployInput.manifest);

    if (supportDiagnostics.length > 0) {
      return {
        ok: false,
        code: "AWS_PREVIEW_UNSUPPORTED_FEATURE",
        message:
          "This Cell uses features that AWS preview cannot execute in alpha.",
        hint: "AWS remains the only supported provider, but not every local alpha feature has an AWS execution path yet.",
        plan: synthesis.plan,
        template: synthesis.template,
        diagnostics: supportDiagnostics,
      };
    }

    const artifacts = deployInput.buildOutput
      ? await createAwsPreviewDeployArtifacts({
          manifest: deployInput.manifest,
          template: synthesis.template,
          buildOutput: deployInput.buildOutput,
        })
      : undefined;
    const artifactSummary = artifacts
      ? summarizeAwsPreviewDeployArtifacts(artifacts)
      : undefined;

    if (!this.options.provisioner) {
      const result: DeploymentResult = {
        ok: false,
        code: "AWS_PROVISIONER_NOT_CONFIGURED",
        message:
          "AWS preview provisioning needs a provisioner implementation or AWS client configuration.",
        hint: "The adapter produced a stable deployment plan, CloudFormation template, and deploy artifacts for this Cell.",
        plan: synthesis.plan,
        template: synthesis.template,
      };

      if (artifactSummary) {
        result.artifacts = artifactSummary;
      }

      return result;
    }

    if (!artifacts || !artifactSummary) {
      return {
        ok: false,
        code: "AWS_BUILD_OUTPUT_REQUIRED",
        message:
          "AWS preview provisioning requires builder output so deploy artifacts can be uploaded.",
        hint: "Run anvil build before invoking the AWS preview provisioner.",
        plan: synthesis.plan,
        template: synthesis.template,
      };
    }

    let provisioned;

    try {
      provisioned = await this.options.provisioner.provision({
        environment: deployInput.environment ?? "preview",
        manifest: deployInput.manifest,
        plan: synthesis.plan,
        template: synthesis.template,
        artifacts,
      });
    } catch (error) {
      if (error instanceof AwsPreviewProvisioningError) {
        return {
          ok: false,
          code: error.code,
          message: error.message,
          hint: "Inspect the CloudFormation failure details, fix the generated plan or AWS account configuration, then rerun anvil deploy --preview.",
          plan: synthesis.plan,
          template: synthesis.template,
          artifacts: artifactSummary,
          details: error.details,
        };
      }

      throw error;
    }

    return {
      ok: true,
      deploymentId: provisioned.deploymentId,
      environment: deployInput.environment ?? "preview",
      url: provisioned.url,
      resources: provisioned.resources,
      next: [
        `anvil inspect --app ${deployInput.manifest.cell.name} --env ${deployInput.environment ?? "preview"} --json`,
        `anvil logs --app ${deployInput.manifest.cell.name} --env ${deployInput.environment ?? "preview"} --json`,
      ],
      plan: synthesis.plan,
      template: synthesis.template,
      artifacts: artifactSummary,
    };
  }
}

function normalizeDeployInput(
  input: CellManifest | AwsPreviewDeployInput,
  fallbackEnvironment: DeploymentEnvironment,
): AwsPreviewDeployInput {
  if ("manifest" in input) {
    return {
      ...input,
      environment: input.environment ?? fallbackEnvironment,
    };
  }

  return {
    manifest: input,
    environment: fallbackEnvironment,
  };
}

export function synthesizeAwsPreviewDeployment(
  manifest: CellManifest,
  environment: DeploymentEnvironment = "preview",
): AwsPreviewDeploymentSynthesis {
  return {
    plan: createAwsPreviewDeploymentPlan(manifest, environment),
    template: createAwsPreviewCloudFormationTemplate(manifest, {
      environment,
    }),
  };
}

export function createAwsPreviewDeploymentPlan(
  manifest: CellManifest,
  environment: DeploymentEnvironment = "preview",
): DeploymentPlan {
  const changes: DeploymentPlanChange[] = [
    {
      kind: "create",
      concept: "runtime",
      name: `${manifest.cell.name}-${environment}`,
      details: {
        service: "lambda",
        runtime: manifest.cell.runtime,
      },
    },
    {
      kind: "create",
      concept: "http-ingress",
      name: `${manifest.cell.name}-${environment}`,
      details: {
        queries: manifest.queries.length,
        mutations: manifest.mutations.length,
        endpoints: manifest.endpoints.map((endpoint) => ({
          method: endpoint.method,
          path: endpoint.path,
        })),
      },
    },
    {
      kind: "create",
      concept: "client-assets",
      name: `${manifest.cell.name}-${environment}`,
      details: {
        service: "s3-cloudfront",
      },
    },
    {
      kind: "create",
      concept: "logs",
      name: `${manifest.cell.name}-${environment}`,
      details: {
        service: "cloudwatch-logs",
      },
    },
    {
      kind: "create",
      concept: "audit",
      name: `${manifest.cell.name}-${environment}`,
    },
  ];

  if (manifest.capabilities.database === true) {
    changes.push({
      kind: "create",
      concept: "database",
      name: `${manifest.cell.name}-${environment}`,
      details: {
        service: "dynamodb",
        tables: Object.keys(manifest.schema.tables),
      },
    });
  }

  if (manifest.capabilities.files) {
    changes.push({
      kind: "create",
      concept: "files",
      name: `${manifest.cell.name}-${environment}`,
      details: {
        service: "s3",
        publicRead:
          isObject(manifest.capabilities.files) &&
          manifest.capabilities.files.publicRead === true,
      },
    });
  }

  if (manifest.capabilities.events) {
    changes.push({
      kind: "create",
      concept: "events",
      name: `${manifest.cell.name}-${environment}`,
      details: {
        service: "eventbridge",
      },
    });
  }

  if (manifest.jobs.length > 0) {
    changes.push({
      kind: "create",
      concept: "jobs",
      name: `${manifest.cell.name}-${environment}`,
      details: {
        scheduled: manifest.jobs.filter((job) => job.schedule).length,
        queued: manifest.jobs.filter((job) => !job.schedule).length,
      },
    });
  }

  return {
    schemaVersion: "0.1",
    adapter: "aws",
    environment,
    cell: manifest.cell.name,
    changes,
    warnings: createWarnings(manifest),
    operations: createOperations(manifest, environment),
  };
}

function createOperations(
  manifest: CellManifest,
  environment: DeploymentEnvironment,
): DeploymentPlanOperations {
  return {
    rollback: {
      supported: false,
      strategy: "manual",
      commands: [
        "anvil deploy --preview --json",
        `anvil destroy --preview --app ${manifest.cell.name} --yes --json`,
      ],
      notes: [
        "Preview rollback commands are not implemented yet.",
        "Until artifact rollback lands, redeploy a known-good checkout or destroy the preview stack.",
      ],
    },
    cost: {
      billingMode: "usage-based-preview",
      drivers: createCostDrivers(manifest),
      notes: [
        `Environment '${environment}' uses AWS on-demand resources.`,
        "Destroy preview stacks that are not actively being inspected.",
      ],
    },
    cleanup: {
      commands: [
        `anvil destroy --preview --app ${manifest.cell.name} --yes --json`,
      ],
      notes: [
        "Destroy empties stack-owned buckets and removes deployment metadata when configured.",
      ],
    },
  };
}

function createCostDrivers(manifest: CellManifest): string[] {
  const drivers = [
    "Lambda requests and duration",
    "Lambda function URL traffic",
    "CloudWatch log ingestion and retention",
    "S3 client asset storage",
    "DynamoDB deployment metadata table reads and writes",
  ];

  if (manifest.capabilities.database === true) {
    drivers.push("DynamoDB Cell data table reads and writes");
  }

  if (manifest.capabilities.files) {
    drivers.push("S3 Cell file storage and requests");
  }

  if (manifest.capabilities.events) {
    drivers.push("EventBridge event bus events");
  }

  if (manifest.jobs.length > 0) {
    drivers.push("SQS queue requests and retained messages");
  }

  return drivers;
}

export function checkAwsPreviewSupport(
  manifest: CellManifest,
): AwsPreviewSupportDiagnostic[] {
  const diagnostics: AwsPreviewSupportDiagnostic[] = [];

  if (manifest.services.length > 0) {
    diagnostics.push({
      code: "AWS_PREVIEW_UNSUPPORTED_FEATURE",
      feature: "services",
      message:
        "AWS preview does not support service execution yet. Services run under the local supervisor during alpha.",
      hint: "Remove declared services for AWS preview, or run this Cell locally until the container-backed service adapter lands.",
      names: manifest.services.map((service) => service.name),
    });
  }

  if (manifest.workflows.length > 0) {
    diagnostics.push({
      code: "AWS_PREVIEW_UNSUPPORTED_FEATURE",
      feature: "workflows",
      message:
        "AWS preview does not support workflow execution yet. Workflows run on the local runtime during alpha.",
      hint: "Remove declared workflows for AWS preview, or run this Cell locally until the Step Functions workflow adapter lands.",
      names: manifest.workflows.map((workflow) => workflow.name),
    });
  }

  if (manifest.capabilities.outboundFetch) {
    diagnostics.push({
      code: "AWS_PREVIEW_UNSUPPORTED_FEATURE",
      feature: "outboundFetch",
      message:
        "AWS preview does not support outbound fetch policy enforcement yet.",
      hint: "Remove capabilities.outboundFetch for AWS preview, or keep this Cell local until outbound network policy is implemented.",
      names: outboundFetchAllowList(manifest.capabilities.outboundFetch),
    });
  }

  return diagnostics;
}

function createWarnings(manifest: CellManifest): string[] {
  const warnings: string[] = [];

  if (manifest.capabilities.files && !manifest.capabilities.database) {
    warnings.push(
      "Files are enabled without database capability; make sure object ownership is tracked in Cell code.",
    );
  }

  for (const diagnostic of checkAwsPreviewSupport(manifest)) {
    warnings.push(diagnostic.message);
  }

  return warnings;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outboundFetchAllowList(capability: unknown): string[] {
  if (!isObject(capability) || !Array.isArray(capability.allow)) {
    return [];
  }

  return capability.allow.filter((entry): entry is string => {
    return typeof entry === "string";
  });
}
