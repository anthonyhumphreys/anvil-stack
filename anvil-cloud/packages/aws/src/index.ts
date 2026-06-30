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
  awsPreviewStackNameFor,
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
  AwsLambdaMicroVmSandboxError,
  AwsLambdaMicroVmSandboxProvider,
  createAwsLambdaMicroVmSandboxProviderFromEnv,
  type AwsLambdaMicroVmSandboxProviderOptions,
} from "./sandbox.js";
export {
  BedrockInferenceProvider,
  checkAwsAgentCompatibility,
  type AwsAgentCompatibilityResult,
  type BedrockInferenceProviderOptions,
} from "./agent.js";
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
  type AwsWorkflowStepEvent,
  type AwsWorkflowStepResult,
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
    | "agent-sandboxes"
    | "jobs"
    | "logs"
    | "runtime"
    | "workflows";
  name: string;
  details?: Record<string, unknown>;
};

export type DeploymentPlan = {
  schemaVersion: "0.1";
  adapter: "aws";
  environment: DeploymentEnvironment;
  cell: string;
  changes: DeploymentPlanChange[];
  review: DeploymentPlanReview;
  warnings: string[];
  operations: DeploymentPlanOperations;
};

export type DeploymentPlanReview = {
  stableId: string;
  operation: "deploy";
  summary: {
    creates: number;
    updates: number;
    reuses: number;
    total: number;
  };
  changeSummary: DeploymentPlanReviewConceptSummary[];
  changeSet: DeploymentPlanReviewChange[];
  capabilityDiffs: DeploymentPlanCapabilityDiff[];
  cost: {
    drivers: DeploymentPlanCostDriver[];
    notes: string[];
  };
  rollback: DeploymentPlanOperations["rollback"];
  cleanup: DeploymentPlanOperations["cleanup"];
  approvalSummary: DeploymentPlanApprovalSummary;
  approvalGates: DeploymentPlanApprovalGate[];
};

export type DeploymentPlanReviewConceptSummary = {
  concept: DeploymentPlanChange["concept"];
  creates: number;
  updates: number;
  reuses: number;
  total: number;
  changeIds: string[];
};

export type DeploymentPlanReviewChange = {
  id: string;
  action: DeploymentPlanChange["kind"];
  concept: DeploymentPlanChange["concept"];
  name: string;
  details?: Record<string, unknown>;
};

export type DeploymentPlanCapabilityDiff = {
  id: string;
  action: "add" | "update" | "unchanged";
  capability: DeploymentPlanChange["concept"];
  name: string;
  details?: Record<string, unknown>;
};

export type DeploymentPlanCostDriver = {
  id: string;
  label: string;
  reason: string;
};

export type DeploymentPlanApprovalGate = {
  id: string;
  required: boolean;
  severity: "info" | "review" | "block";
  reason: string;
  changeIds: string[];
};

export type DeploymentPlanApprovalSummary = {
  required: number;
  info: number;
  review: number;
  block: number;
  hasBlockingGate: boolean;
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
  feature: "agentSandboxes" | "outboundFetch" | "services" | "workflows";
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
        hint: "Run anvil-cloud build before invoking the AWS preview provisioner.",
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
          hint: "Inspect the CloudFormation failure details, fix the generated plan or AWS account configuration, then rerun anvil-cloud deploy --preview.",
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
        `anvil-cloud inspect --app ${deployInput.manifest.cell.name} --env ${deployInput.environment ?? "preview"} --json`,
        `anvil-cloud logs --app ${deployInput.manifest.cell.name} --env ${deployInput.environment ?? "preview"} --json`,
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

  if (manifest.workflows.length > 0) {
    changes.push({
      kind: "create",
      concept: "workflows",
      name: `${manifest.cell.name}-${environment}`,
      details: {
        service: "step-functions",
        workflows: manifest.workflows.map((workflow) => ({
          name: workflow.name,
          steps: workflow.steps,
        })),
      },
    });
  }

  const sandboxAgents = sandboxRequiredAgents(manifest);

  if (sandboxAgents.length > 0) {
    changes.push({
      kind: "create",
      concept: "agent-sandboxes",
      name: `${manifest.cell.name}-${environment}`,
      details: {
        service: "lambda-microvms",
        agents: sandboxAgents.map((agent) => ({
          name: agent.name,
          provider: agent.model.provider,
          approvals: agent.requires.humanApproval,
          durability: agent.runtime.durability,
        })),
        imageConfigured: isAgentSandboxImageConfigured(),
      },
    });
  }

  const operations = createOperations(manifest, environment);

  return {
    schemaVersion: "0.1",
    adapter: "aws",
    environment,
    cell: manifest.cell.name,
    changes,
    review: createDeploymentPlanReview(
      manifest,
      environment,
      changes,
      operations,
    ),
    warnings: createWarnings(manifest),
    operations,
  };
}

function createDeploymentPlanReview(
  manifest: CellManifest,
  environment: DeploymentEnvironment,
  changes: DeploymentPlanChange[],
  operations: DeploymentPlanOperations,
): DeploymentPlanReview {
  const changeSet = changes.map(toReviewPlanChange);
  const capabilityDiffs = changes.map(toCapabilityDiff);
  const approvalGates = createPreviewApprovalGates(
    manifest,
    changeSet,
    capabilityDiffs,
  );

  return {
    stableId: `aws-preview:${slug(manifest.cell.name)}:${environment}:deploy`,
    operation: "deploy",
    summary: {
      creates: changes.filter((change) => change.kind === "create").length,
      updates: changes.filter((change) => change.kind === "update").length,
      reuses: changes.filter((change) => change.kind === "reuse").length,
      total: changes.length,
    },
    changeSummary: createChangeSummary(changeSet),
    changeSet,
    capabilityDiffs,
    cost: {
      drivers: createStructuredCostDrivers(manifest),
      notes: operations.cost.notes,
    },
    rollback: operations.rollback,
    cleanup: operations.cleanup,
    approvalSummary: createApprovalSummary(approvalGates),
    approvalGates,
  };
}

function createChangeSummary(
  changeSet: DeploymentPlanReviewChange[],
): DeploymentPlanReviewConceptSummary[] {
  const summaries = new Map<
    DeploymentPlanChange["concept"],
    DeploymentPlanReviewConceptSummary
  >();

  for (const change of changeSet) {
    const existing =
      summaries.get(change.concept) ??
      ({
        concept: change.concept,
        creates: 0,
        updates: 0,
        reuses: 0,
        total: 0,
        changeIds: [],
      } satisfies DeploymentPlanReviewConceptSummary);

    if (change.action === "create") {
      existing.creates += 1;
    } else if (change.action === "update") {
      existing.updates += 1;
    } else {
      existing.reuses += 1;
    }

    existing.total += 1;
    existing.changeIds.push(change.id);
    summaries.set(change.concept, existing);
  }

  return Array.from(summaries.values())
    .map((summary) => ({
      ...summary,
      changeIds: summary.changeIds.sort(),
    }))
    .sort((left, right) => left.concept.localeCompare(right.concept));
}

function toReviewPlanChange(
  change: DeploymentPlanChange,
): DeploymentPlanReviewChange {
  const reviewChange: DeploymentPlanReviewChange = {
    id: [change.kind, slug(change.concept), slug(change.name)].join(":"),
    action: change.kind,
    concept: change.concept,
    name: change.name,
  };

  if (change.details !== undefined) {
    reviewChange.details = change.details;
  }

  return reviewChange;
}

function toCapabilityDiff(
  change: DeploymentPlanChange,
): DeploymentPlanCapabilityDiff {
  const diff: DeploymentPlanCapabilityDiff = {
    id: `${slug(change.concept)}:${slug(change.name)}`,
    action:
      change.kind === "create"
        ? "add"
        : change.kind === "update"
          ? "update"
          : "unchanged",
    capability: change.concept,
    name: change.name,
  };

  if (change.details !== undefined) {
    diff.details = change.details;
  }

  return diff;
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
        "anvil-cloud deploy --preview --json",
        `anvil-cloud destroy --preview --app ${manifest.cell.name} --yes --json`,
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
        `anvil-cloud destroy --preview --app ${manifest.cell.name} --yes --json`,
      ],
      notes: [
        "Destroy empties stack-owned buckets and removes deployment metadata when configured.",
      ],
    },
  };
}

function createPreviewApprovalGates(
  manifest: CellManifest,
  changeSet: DeploymentPlanReviewChange[],
  capabilityDiffs: DeploymentPlanCapabilityDiff[],
): DeploymentPlanApprovalGate[] {
  const gates: DeploymentPlanApprovalGate[] = [];
  const unsupported = checkAwsPreviewSupport(manifest);

  if (unsupported.length > 0) {
    gates.push({
      id: "aws-preview-support-gate",
      required: true,
      severity: "block",
      reason:
        "AWS preview cannot execute every declared Cell feature yet. Deploy is gated before provisioning.",
      changeIds: unsupported.flatMap((diagnostic) =>
        idsForConcepts(changeSet, [
          conceptForUnsupportedFeature(diagnostic.feature),
        ]),
      ),
    });
  }

  if (manifest.capabilities.database === true) {
    gates.push({
      id: "data-resource-review",
      required: true,
      severity: "review",
      reason:
        "Database capability creates persistent preview data resources. Confirm retention and cleanup expectations.",
      changeIds: idsForConcepts(changeSet, ["database"]),
    });
  }

  if (
    isObject(manifest.capabilities.files) &&
    manifest.capabilities.files.publicRead === true
  ) {
    gates.push({
      id: "public-file-access-review",
      required: true,
      severity: "review",
      reason:
        "Files are configured for public reads. Confirm object exposure before preview deployment.",
      changeIds: idsForConcepts(changeSet, ["files"]),
    });
  }

  const asyncCapabilityIds = idsForConcepts(changeSet, ["events", "jobs"]);

  if (asyncCapabilityIds.length > 0) {
    gates.push({
      id: "async-capability-review",
      required: true,
      severity: "review",
      reason:
        "Events or jobs add asynchronous runtime resources that should be inspected during preview cleanup.",
      changeIds: asyncCapabilityIds,
    });
  }

  const agentSandboxIds = idsForConcepts(changeSet, ["agent-sandboxes"]);

  if (agentSandboxIds.length > 0) {
    gates.push({
      id: "agent-sandbox-review",
      required: true,
      severity: "review",
      reason:
        "Sandbox-required agents create Lambda MicroVM sandbox sessions. Confirm image, IAM role, network, approval, TTL, and cleanup policy.",
      changeIds: agentSandboxIds,
    });
  }

  if (gates.length === 0) {
    gates.push({
      id: "standard-review",
      required: false,
      severity: "info",
      reason: "No high-risk AWS preview capability changes were detected.",
      changeIds: capabilityDiffs.map((diff) => diff.id),
    });
  }

  return gates;
}

function createApprovalSummary(
  gates: DeploymentPlanApprovalGate[],
): DeploymentPlanApprovalSummary {
  return {
    required: gates.filter((gate) => gate.required).length,
    info: gates.filter((gate) => gate.severity === "info").length,
    review: gates.filter((gate) => gate.severity === "review").length,
    block: gates.filter((gate) => gate.severity === "block").length,
    hasBlockingGate: gates.some((gate) => gate.severity === "block"),
  };
}

function idsForConcepts(
  changeSet: DeploymentPlanReviewChange[],
  concepts: string[],
): string[] {
  const wanted = new Set(concepts);

  return changeSet
    .filter((change) => wanted.has(change.concept))
    .map((change) => change.id)
    .sort();
}

function conceptForUnsupportedFeature(
  feature: AwsPreviewSupportDiagnostic["feature"],
): string {
  return feature === "agentSandboxes" ? "agent-sandboxes" : feature;
}

function createStructuredCostDrivers(
  manifest: CellManifest,
): DeploymentPlanCostDriver[] {
  const drivers: DeploymentPlanCostDriver[] = [
    {
      id: "lambda",
      label: "Lambda requests and duration",
      reason: "The Cell runtime executes in Lambda for AWS preview.",
    },
    {
      id: "lambda-function-url",
      label: "Lambda function URL traffic",
      reason: "Preview HTTP ingress is exposed through the runtime URL.",
    },
    {
      id: "cloudwatch",
      label: "CloudWatch log ingestion and retention",
      reason: "Runtime logs are retained for inspect and logs commands.",
    },
    {
      id: "client-assets",
      label: "S3 client asset storage",
      reason: "Built client assets are uploaded for preview hosting.",
    },
    {
      id: "deployment-metadata",
      label: "DynamoDB deployment metadata table reads and writes",
      reason:
        "Preview deploy, inspect, logs, and destroy use deployment metadata when configured.",
    },
  ];

  if (manifest.capabilities.database === true) {
    drivers.push({
      id: "dynamodb-data",
      label: "DynamoDB Cell data table reads and writes",
      reason: "Database capability maps Cell tables to DynamoDB resources.",
    });
  }

  if (manifest.capabilities.files) {
    drivers.push({
      id: "s3-files",
      label: "S3 Cell file storage and requests",
      reason: "Files capability stores Cell-owned objects in S3.",
    });
  }

  if (manifest.capabilities.events) {
    drivers.push({
      id: "eventbridge",
      label: "EventBridge event bus events",
      reason: "Events capability publishes through EventBridge.",
    });
  }

  if (manifest.jobs.length > 0) {
    drivers.push({
      id: "sqs-jobs",
      label: "SQS queue requests and retained messages",
      reason: `${manifest.jobs.length} job definition(s) require queue resources.`,
    });
  }

  if (manifest.workflows.length > 0) {
    drivers.push({
      id: "step-functions",
      label: "Step Functions state transitions",
      reason: `${manifest.workflows.length} workflow definition(s) map to state machine resources once AWS preview support lands.`,
    });
  }

  if (sandboxRequiredAgents(manifest).length > 0) {
    drivers.push({
      id: "lambda-microvms-agent-sandboxes",
      label: "Lambda MicroVM agent sandbox sessions",
      reason:
        "Sandbox-required mounted agents can run in sessionful Lambda MicroVM sandboxes.",
    });
  }

  return drivers;
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

  if (manifest.workflows.length > 0) {
    drivers.push("Step Functions state transitions");
  }

  if (sandboxRequiredAgents(manifest).length > 0) {
    drivers.push("Lambda MicroVM agent sandbox sessions");
  }

  return drivers;
}

export function checkAwsPreviewSupport(
  manifest: CellManifest,
): AwsPreviewSupportDiagnostic[] {
  const diagnostics: AwsPreviewSupportDiagnostic[] = [];
  const sandboxAgents = sandboxRequiredAgents(manifest);

  if (sandboxAgents.length > 0 && !isAgentSandboxImageConfigured()) {
    diagnostics.push({
      code: "AWS_PREVIEW_UNSUPPORTED_FEATURE",
      feature: "agentSandboxes",
      message:
        "AWS preview requires a Lambda MicroVM image before it can run sandbox-required agents.",
      hint: "Set ANVIL_AWS_AGENT_SANDBOX_IMAGE to a Lambda MicroVM image ARN or remove runtime.sandbox: 'required' from mounted agents for this preview deploy.",
      names: sandboxAgents.map((agent) => agent.name),
    });
  }

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

function sandboxRequiredAgents(manifest: CellManifest) {
  return Object.values(manifest.agents ?? {}).filter(
    (agent) => agent.requires.sandbox,
  );
}

function isAgentSandboxImageConfigured(): boolean {
  return (
    typeof process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE === "string" &&
    process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE.length > 0
  );
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

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "anvil"
  );
}

function outboundFetchAllowList(capability: unknown): string[] {
  if (!isObject(capability) || !Array.isArray(capability.allow)) {
    return [];
  }

  return capability.allow.filter((entry): entry is string => {
    return typeof entry === "string";
  });
}

export {
  AwsPulumiDeployAdapter,
  createAwsPulumiPlan,
  createPulumiMappings,
  deterministicName,
  type AnvilDeployAdapter,
  type DeployInput,
  type DeployPlan,
  type DeployResult,
  type RemoveInput,
  type RemoveResult,
} from "./pulumi-adapter.js";
