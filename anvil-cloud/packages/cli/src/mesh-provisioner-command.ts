import {
  applyMeshProvisionerDeployment,
  createMeshProvisionerDeploymentPlan,
  provisionMeshProvisionerToken,
  removeMeshProvisionerDeployment,
  writeMeshProvisionerWranglerConfig,
} from "@anvil-cloud/cloudflare";

type ProvisionerCommandContext = {
  flags: Set<string>;
  values: Map<string, string>;
};

const USAGE =
  "anvil-cloud mesh provisioner <plan|apply|remove|secrets> --provisioner <path> --name <worker> [--mode managed|byo] [--account-id <id>] [--config-out <path>] [--stage production] [--write] [--dry-run] [--test-deployment] [--evidence <ref>] [--from-file <token-file>|--from-stdin] [--json]";

export async function commandMeshProvisioner(
  context: ProvisionerCommandContext,
  action: string | undefined,
): Promise<void> {
  const provisionerDir = context.values.get("provisioner");
  const workerName = context.values.get("name");
  const mode = context.values.get("mode") ?? "managed";
  if (
    !provisionerDir ||
    !workerName ||
    !action ||
    !["plan", "apply", "remove", "secrets"].includes(action) ||
    (mode !== "managed" && mode !== "byo")
  ) {
    invalidUsage(context, USAGE);
    return;
  }
  const tokenFile = context.values.get("from-file");
  const fromStdin = context.flags.has("from-stdin");
  if (action === "secrets" && Boolean(tokenFile) === fromStdin) {
    invalidUsage(context, "Supply exactly one of --from-file or --from-stdin.");
    return;
  }
  if (context.flags.has("dry-run") && action !== "apply") {
    invalidUsage(context, "--dry-run is supported only for provisioner apply.");
    return;
  }

  const accountId = context.values.get("account-id");
  const configPath = context.values.get("config-out");
  const plan = await createMeshProvisionerDeploymentPlan({
    provisionerDir,
    workerName,
    mode,
    stage: context.values.get("stage") ?? "production",
    testDeployment: context.flags.has("test-deployment"),
    ...(accountId ? { accountId } : {}),
    ...(configPath ? { configPath } : {}),
    authentication: context.flags.has("temporary") ? "temporary" : "permanent",
  });

  if (action === "plan") {
    const ok = !plan.diagnostics.some((item) => item.severity === "block");
    const written =
      ok && context.flags.has("write")
        ? await writeMeshProvisionerWranglerConfig(plan)
        : undefined;
    report(
      context,
      { ok, command: "mesh provisioner plan", plan, ...written },
      [
        `Provisioner ${workerName}: ${ok ? "ready to review" : "blocked"}`,
        `Config: ${plan.config.path}`,
        ...plan.diagnostics.map((item) => `${item.code}: ${item.message}`),
      ].join("\n"),
    );
    if (!ok) process.exitCode = 4;
    return;
  }

  const reference = context.values.get("evidence");
  const options = {
    plan,
    ...(reference ? { evidence: { reference } } : {}),
  };
  const result =
    action === "apply"
      ? await applyMeshProvisionerDeployment({
          ...options,
          dryRun: context.flags.has("dry-run"),
        })
      : action === "remove"
        ? await removeMeshProvisionerDeployment(options)
        : await provisionMeshProvisionerToken({
            ...options,
            ...(tokenFile ? { tokenFile } : { stdin: process.stdin }),
          });
  report(
    context,
    { ok: result.ok, command: `mesh provisioner ${action}`, result },
    [
      `Provisioner ${action}: ${result.ok ? "complete" : "failed"}`,
      ...result.diagnostics.map((item) => `${item.code}: ${item.message}`),
      result.stdout ?? "",
      result.stderr ?? "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  if (!result.ok) process.exitCode = result.gated ? 2 : 5;
}

function invalidUsage(
  context: ProvisionerCommandContext,
  message: string,
): void {
  report(
    context,
    { ok: false, errors: [{ code: "INVALID_USAGE", message }] },
    message,
  );
  process.exitCode = 2;
}

function report(
  context: ProvisionerCommandContext,
  payload: unknown,
  human: string,
): void {
  process.stdout.write(
    `${context.flags.has("json") || context.flags.has("agent") ? JSON.stringify(payload) : human}\n`,
  );
}
