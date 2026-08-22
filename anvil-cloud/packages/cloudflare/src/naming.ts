import { createHash } from "node:crypto";

export function createCloudflareWorkerName(
  cellName: string,
  environment: string,
): string {
  const input = `${cellName}:${environment}`;
  const normalized = `${slug(cellName)}-${slug(environment)}`;
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 8);
  const shortened = normalized.slice(0, 54);
  let prefixEnd = shortened.length;
  while (prefixEnd > 0 && shortened[prefixEnd - 1] === "-") prefixEnd -= 1;
  const prefix = shortened.slice(0, prefixEnd) || "anvil";

  return `${prefix}-${hash}`;
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === "-") start += 1;
  while (end > start && normalized[end - 1] === "-") end -= 1;

  return normalized.slice(start, end) || "anvil";
}
