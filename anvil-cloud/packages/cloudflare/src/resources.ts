import type { CellManifest } from "@anvil-cloud/builder";
import type { CloudflarePreviewSupportDiagnostic } from "./support.js";

/** Existing, stage-specific resources. Creating these remains an explicit deployment step. */
export type CloudflareRuntimeResources = {
  database?: { name: string; id: string };
  files?: { bucketName: string };
  jobs?: { queueName: string; deadLetterQueueName: string };
  auth?: { issuer: string; audience: string; jwksUri?: string };
  /** Names already installed with Wrangler secrets. Values never enter generated artifacts. */
  secrets?: string[];
};

export function hasCloudflareRuntimeResource(
  feature: CloudflarePreviewSupportDiagnostic["feature"],
  resources: CloudflareRuntimeResources,
): boolean {
  switch (feature) {
    case "database":
      return resources.database !== undefined;
    case "files":
      return resources.files !== undefined;
    case "jobs":
      return resources.jobs !== undefined;
    case "secrets":
      return false; // Checked by name in artifacts.ts.
    default:
      return false;
  }
}

export function cloudflareResourceConfig(
  manifest: CellManifest,
  resources: CloudflareRuntimeResources,
): Record<string, unknown> {
  if (
    resources.auth &&
    (!resources.auth.audience || !resources.auth.issuer.startsWith("https://"))
  ) {
    throw new Error(
      "Cloudflare OIDC requires an HTTPS issuer and an audience.",
    );
  }
  const crons = [
    ...new Set(
      manifest.jobs.flatMap((job) => (job.schedule ? [job.schedule] : [])),
    ),
  ];
  if (crons.some((cron) => cron.trim().split(/\s+/).length !== 5)) {
    throw new Error(
      "Cloudflare schedules require five-field cron expressions in UTC.",
    );
  }
  return {
    observability: { enabled: true },
    ...(resources.database
      ? {
          d1_databases: [
            {
              binding: "ANVIL_DB",
              database_name: resources.database.name,
              database_id: resources.database.id,
              migrations_dir: "./migrations",
            },
          ],
        }
      : {}),
    ...(resources.files
      ? {
          r2_buckets: [
            { binding: "ANVIL_FILES", bucket_name: resources.files.bucketName },
          ],
        }
      : {}),
    ...(resources.jobs
      ? {
          queues: {
            producers: [
              { binding: "ANVIL_JOBS", queue: resources.jobs.queueName },
            ],
            consumers: [
              {
                queue: resources.jobs.queueName,
                max_batch_size: 10,
                max_retries: 5,
                retry_delay: 60,
                dead_letter_queue: resources.jobs.deadLetterQueueName,
              },
            ],
          },
          ...(crons.length > 0 ? { triggers: { crons } } : {}),
        }
      : {}),
    ...(resources.auth
      ? {
          vars: {
            ANVIL_AUTH_ISSUER: resources.auth.issuer,
            ANVIL_AUTH_AUDIENCE: resources.auth.audience,
            ...(resources.auth.jwksUri
              ? { ANVIL_AUTH_JWKS_URI: resources.auth.jwksUri }
              : {}),
          },
        }
      : {}),
  };
}
