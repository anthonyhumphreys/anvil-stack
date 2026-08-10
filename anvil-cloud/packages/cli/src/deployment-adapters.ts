import { AwsPreviewDeploymentAdapter } from "@anvil-cloud/aws";
import { CloudflarePreviewDeploymentAdapter } from "@anvil-cloud/cloudflare";
import type { DeploymentPlanAdapter } from "@anvil-cloud/deployment";

export type RegisteredDeploymentAdapter = {
  name: string;
  previewPlanner: DeploymentPlanAdapter;
  stageOperations: "supported" | "plan-only";
};

const awsPreviewAdapter = new AwsPreviewDeploymentAdapter();

const adapters = new Map<string, RegisteredDeploymentAdapter>([
  [
    "aws",
    {
      name: "aws",
      previewPlanner: {
        name: "aws",
        plan(manifest, environment) {
          if (environment !== "preview") {
            throw new Error(
              `AWS preview planning does not support environment '${environment}'.`,
            );
          }
          return awsPreviewAdapter.plan(manifest, "preview");
        },
      },
      stageOperations: "supported",
    },
  ],
]);

export function resolveDeploymentAdapter(
  name: string,
  options: { temporary?: boolean } = {},
): RegisteredDeploymentAdapter | undefined {
  if (name === "cloudflare") {
    return {
      name: "cloudflare",
      previewPlanner: new CloudflarePreviewDeploymentAdapter({
        authentication: options.temporary ? "temporary" : "permanent",
      }),
      stageOperations: "plan-only",
    };
  }

  return adapters.get(name);
}

export function supportedDeploymentAdapters(): string[] {
  return [...adapters.keys(), "cloudflare"].sort();
}
