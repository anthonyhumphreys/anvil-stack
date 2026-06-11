import { Resource } from "sst";
import { task } from "sst/aws/task";

if (process.argv.includes("--dry-run")) {
  console.log("[anvil] Dry run: would run Resource.DatabaseMigration and wait for the ECS task to stop");
  process.exit(0);
}

const migrationResource = (Resource as unknown as { DatabaseMigration?: task.Resource }).DatabaseMigration;

if (!migrationResource) {
  throw new Error("Resource.DatabaseMigration is not available. Run this through SST after deploying the DatabaseMigration task.");
}

const timeoutMs = readPositiveInteger("ANVIL_MIGRATION_TIMEOUT_MS", 10 * 60 * 1000);
const pollMs = readPositiveInteger("ANVIL_MIGRATION_POLL_MS", 5000);
const startedAt = Date.now();

const started = await task.run(migrationResource);
console.log(`[anvil] Started DatabaseMigration task ${started.arn} (${started.status})`);

while (Date.now() - startedAt < timeoutMs) {
  await delay(pollMs);
  const described = await task.describe(migrationResource, started.arn);
  console.log(`[anvil] DatabaseMigration task ${described.arn} is ${described.status}`);

  if (described.status === "STOPPED") {
    const exitCode = getFirstContainerExitCode(described.response);
    if (exitCode === 0) {
      console.log("[anvil] Database migrations completed successfully");
      process.exit(0);
    }

    const reason = getFirstContainerReason(described.response);
    throw new Error(`DatabaseMigration task stopped with exit code ${exitCode ?? "unknown"}${reason ? `: ${reason}` : ""}`);
  }
}

throw new Error(`DatabaseMigration task ${started.arn} did not stop within ${timeoutMs}ms`);

function readPositiveInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getFirstContainerExitCode(response: unknown): number | undefined {
  const container = firstContainer(response);
  return typeof container?.exitCode === "number" ? container.exitCode : undefined;
}

function getFirstContainerReason(response: unknown): string | undefined {
  const container = firstContainer(response);
  return typeof container?.reason === "string" ? container.reason : undefined;
}

function firstContainer(response: unknown): { exitCode?: unknown; reason?: unknown } | undefined {
  if (!response || typeof response !== "object") return undefined;
  const tasks = (response as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return undefined;
  const [ecsTask] = tasks;
  if (!ecsTask || typeof ecsTask !== "object") return undefined;
  const containers = (ecsTask as { containers?: unknown }).containers;
  if (!Array.isArray(containers)) return undefined;
  const [container] = containers;
  return container && typeof container === "object" ? (container as { exitCode?: unknown; reason?: unknown }) : undefined;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
