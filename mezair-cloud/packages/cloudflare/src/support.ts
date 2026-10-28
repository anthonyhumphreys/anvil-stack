import type { CellManifest } from "@mezair-cloud/builder";

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
        "The D1 runtime is implemented, but automatic resource provisioning and live deployment verification are incomplete.",
        "Supply existing D1 resources to the experimental artifact builder and apply its migration before testing. Normal CLI deployment remains gated.",
      ),
    );
  }
  if (manifest.capabilities.files) {
    diagnostics.push(
      unsupported(
        "files",
        [manifest.cell.name],
        options.authentication === "temporary"
          ? "Cloudflare Temporary Accounts do not currently list R2 as a supported resource, and the Mezair files host is not implemented."
          : "The private R2 runtime is implemented, but automatic resource provisioning and live deployment verification are incomplete.",
        options.authentication === "temporary"
          ? "Use a stateless Cell for this temporary preview."
          : "Supply an existing private R2 bucket to the experimental artifact builder. Normal CLI deployment remains gated.",
      ),
    );
  }
  if (manifest.capabilities.events) {
    diagnostics.push(
      unsupported(
        "events",
        [manifest.cell.name],
        "Cloudflare preview does not yet implement the Mezair event contract on Queues.",
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
          ? "Cloudflare Temporary Accounts do not document secret-binding operations as supported, and Mezair secret provisioning is not implemented."
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
        "Cloudflare preview does not yet implement the Mezair workflow durability contract.",
        "Run workflows locally until a durable Cloudflare workflow host passes conformance.",
      ),
    );
  }
  if (manifest.jobs.length > 0) {
    diagnostics.push(
      unsupported(
        "jobs",
        manifest.jobs.map((item) => item.name),
        "Queue consumers and Cron Trigger bridges are implemented, but automatic resource provisioning and live deployment verification are incomplete.",
        "Supply an existing queue and dead-letter queue to the experimental artifact builder. Use five-field UTC cron expressions.",
      ),
    );
  }
  if (sandboxAgents.length > 0) {
    diagnostics.push(
      unsupported(
        "agentSandboxes",
        sandboxAgents.map((item) => item.name),
        "Cloudflare preview cannot provide Mezair Agent Sandbox isolation.",
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
