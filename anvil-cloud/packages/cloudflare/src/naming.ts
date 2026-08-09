import { createHash } from "node:crypto";

export function createCloudflareWorkerName(
  cellName: string,
  environment: string,
): string {
  const input = `${cellName}:${environment}`;
  const normalized = `${slug(cellName)}-${slug(environment)}`;
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 8);
  const prefix = normalized.slice(0, 54).replace(/-+$/g, "") || "anvil";

  return `${prefix}-${hash}`;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "anvil"
  );
}
