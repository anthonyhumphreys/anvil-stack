import type { CellManifest } from "@anvil-cloud/builder";

export type CloudflareAuthenticationMode = "permanent" | "temporary";

export type CloudflarePreviewDeploymentAdapterOptions = {
  authentication?: CloudflareAuthenticationMode;
};

export type CloudflarePreviewSupportDiagnostic = {
  code: "CLOUDFLARE_PREVIEW_UNSUPPORTED_FEATURE";
  feature:
    | "agentSandboxes"
    | "database"
    | "events"
    | "files"
    | "jobs"
    | "secrets"
    | "services"
    | "workflows";
  message: string;
  hint: string;
  names: string[];
};

export function checkCloudflarePreviewSupport(
  manifest: CellManifest,
  options: CloudflarePreviewDeploymentAdapterOptions = {},
): CloudflarePreviewSupportDiagnostic[] {
  const diagnostics: CloudflarePreviewSupportDiagnostic[] = [];
  const declaredSecrets = readStringArray(manifest.capabilities.secrets);
  const sandboxAgents = Object.values(manifest.agents ?? {}).filter(
    (agent) => agent.requires.sandbox,
  );

  if (manifest.capabilities.database === true) {
    diagnostics.push(
      unsupported(
        "database",
        Object.keys(manifest.schema.tables).sort(),
        "Cloudflare preview does not yet implement the Anvil database contract on D1.",
        "Use a stateless Cell for the live Worker smoke test until the D1 host passes database conformance.",
      ),
    );
  }
  if (manifest.capabilities.files) {
    diagnostics.push(
      unsupported(
        "files",
        [manifest.cell.name],
        options.authentication === "temporary"
          ? "Cloudflare Temporary Accounts do not currently list R2 as a supported resource, and the Anvil files host is not implemented."
          : "Cloudflare preview does not yet implement the Anvil files contract on R2.",
        options.authentication === "temporary"
          ? "Use a stateless Cell for this temporary preview."
          : "Use a Cell without file storage until the R2 host passes file conformance.",
      ),
    );
  }
  if (manifest.capabilities.events) {
    diagnostics.push(
      unsupported(
        "events",
        [manifest.cell.name],
        "Cloudflare preview does not yet implement the Anvil event contract on Queues.",
        "Use a Cell without events until the Queues host and consumer bridge pass conformance.",
      ),
    );
  }
  if (declaredSecrets.length > 0) {
    diagnostics.push(
      unsupported(
        "secrets",
        declaredSecrets,
        options.authentication === "temporary"
          ? "Cloudflare Temporary Accounts do not document secret-binding operations as supported, and Anvil secret provisioning is not implemented."
          : "Cloudflare preview does not yet manage Cell secret bindings.",
        "Use a Cell without secrets for the live smoke test until secret provisioning and redaction pass provider verification.",
      ),
    );
  }
  if (manifest.services.length > 0) {
    diagnostics.push(
      unsupported(
        "services",
        manifest.services.map((item) => item.name),
        "Cloudflare preview cannot execute long-running Cell services.",
        "Run services locally or move the handler behind a request or queue boundary.",
      ),
    );
  }
  if (manifest.workflows.length > 0) {
    diagnostics.push(
      unsupported(
        "workflows",
        manifest.workflows.map((item) => item.name),
        "Cloudflare preview does not yet implement the Anvil workflow durability contract.",
        "Run workflows locally until a durable Cloudflare workflow host passes conformance.",
      ),
    );
  }
  if (manifest.jobs.length > 0) {
    diagnostics.push(
      unsupported(
        "jobs",
        manifest.jobs.map((item) => item.name),
        "Cloudflare preview does not yet execute scheduled or queued jobs.",
        "Run jobs locally until Queues and Cron Trigger runtime bridges are implemented.",
      ),
    );
  }
  if (sandboxAgents.length > 0) {
    diagnostics.push(
      unsupported(
        "agentSandboxes",
        sandboxAgents.map((item) => item.name),
        "Cloudflare preview cannot provide Anvil Agent Sandbox isolation.",
        "Use an agent without required sandbox execution for this target.",
      ),
    );
  }

  return diagnostics;
}

function unsupported(
  feature: CloudflarePreviewSupportDiagnostic["feature"],
  names: string[],
  message: string,
  hint: string,
): CloudflarePreviewSupportDiagnostic {
  return {
    code: "CLOUDFLARE_PREVIEW_UNSUPPORTED_FEATURE",
    feature,
    message,
    hint,
    names,
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
