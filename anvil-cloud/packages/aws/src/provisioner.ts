import type { AwsPreviewDeployArtifacts } from "./artifacts.js";
import type { CloudFormationTemplate } from "./cloudformation.js";
import type { DeploymentEnvironment, DeploymentPlan } from "./index.js";
import type { CellManifest } from "@anvil-cloud/builder";

export type AwsPreviewProvisionerInput = {
  environment: DeploymentEnvironment;
  previewName?: string;
  manifest: CellManifest;
  plan: DeploymentPlan;
  template: CloudFormationTemplate;
  artifacts: AwsPreviewDeployArtifacts;
};

export type AwsPreviewProvisionerResult = {
  deploymentId: string;
  previewName: string;
  url: string;
  resources: Record<string, string>;
};

export interface AwsPreviewProvisioner {
  provision(
    input: AwsPreviewProvisionerInput,
  ): Promise<AwsPreviewProvisionerResult>;
}
