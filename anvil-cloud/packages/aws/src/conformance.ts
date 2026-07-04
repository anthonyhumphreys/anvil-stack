import type { CellManifest } from "@anvil-cloud/builder";

import type { DeploymentAdapter, DeploymentEnvironment } from "./index.js";

export type AdapterConformanceDiagnostic = {
  code: string;
  message: string;
  path: string;
};

export type AdapterConformanceResult = {
  ok: boolean;
  adapter: string;
  environment: DeploymentEnvironment;
  diagnostics: AdapterConformanceDiagnostic[];
};

export function runPreviewAdapterConformance(options: {
  adapter: DeploymentAdapter;
  manifest: CellManifest;
  environment?: DeploymentEnvironment;
}): AdapterConformanceResult {
  const environment = options.environment ?? "preview";
  const diagnostics: AdapterConformanceDiagnostic[] = [];
  const plan = options.adapter.plan(options.manifest, environment);

  if (plan.schemaVersion !== "0.1") {
    diagnostics.push({
      code: "ADAPTER_PLAN_SCHEMA_INVALID",
      message: "Deployment plan schemaVersion must be 0.1.",
      path: "plan.schemaVersion",
    });
  }

  if (plan.adapter !== options.adapter.name) {
    diagnostics.push({
      code: "ADAPTER_PLAN_NAME_MISMATCH",
      message: `Plan adapter '${plan.adapter}' does not match adapter '${options.adapter.name}'.`,
      path: "plan.adapter",
    });
  }

  if (plan.review.stableId.length === 0) {
    diagnostics.push({
      code: "ADAPTER_REVIEW_ID_MISSING",
      message: "Plan review must expose a stable review id.",
      path: "plan.review.stableId",
    });
  }

  assertSortedIds(
    plan.review.changeSet.map((change) => change.id),
    "plan.review.changeSet",
    diagnostics,
  );
  assertSortedIds(
    plan.review.capabilityDiffs.map((diff) => diff.id),
    "plan.review.capabilityDiffs",
    diagnostics,
  );

  if (plan.review.approvalGates.length === 0) {
    diagnostics.push({
      code: "ADAPTER_APPROVAL_GATES_MISSING",
      message: "Plan review must include at least one approval gate.",
      path: "plan.review.approvalGates",
    });
  }

  if (
    plan.review.approvalSummary.required !==
    plan.review.approvalGates.filter((gate) => gate.required).length
  ) {
    diagnostics.push({
      code: "ADAPTER_APPROVAL_SUMMARY_INVALID",
      message: "approvalSummary.required must match required approval gates.",
      path: "plan.review.approvalSummary.required",
    });
  }

  if (plan.review.cost.drivers.length === 0) {
    diagnostics.push({
      code: "ADAPTER_COST_DRIVERS_MISSING",
      message: "Plan review must include cost driver metadata.",
      path: "plan.review.cost.drivers",
    });
  }

  if (plan.review.rollback.commands.length === 0) {
    diagnostics.push({
      code: "ADAPTER_ROLLBACK_COMMANDS_MISSING",
      message: "Plan review must include rollback guidance.",
      path: "plan.review.rollback.commands",
    });
  }

  if (plan.review.cleanup.commands.length === 0) {
    diagnostics.push({
      code: "ADAPTER_CLEANUP_COMMANDS_MISSING",
      message: "Plan review must include cleanup guidance.",
      path: "plan.review.cleanup.commands",
    });
  }

  return {
    ok: diagnostics.length === 0,
    adapter: options.adapter.name,
    environment,
    diagnostics,
  };
}

function assertSortedIds(
  ids: string[],
  path: string,
  diagnostics: AdapterConformanceDiagnostic[],
): void {
  const sorted = [...ids].sort();

  if (ids.join("\0") !== sorted.join("\0")) {
    diagnostics.push({
      code: "ADAPTER_REVIEW_IDS_NOT_SORTED",
      message: "Review ids must be emitted in stable sorted order.",
      path,
    });
  }
}
