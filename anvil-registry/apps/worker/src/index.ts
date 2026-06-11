import { loadConfig } from "@anvilstack/config";
import { createLogger } from "@anvilstack/logger";
import { loadActivePopularPackageIndex } from "@anvilstack/name-squatting";
import { NpmDownloadsClient, NpmRegistryRouter } from "@anvilstack/npm-registry";
import { createObjectStore } from "@anvilstack/object-store";
import { createPersistence } from "@anvilstack/persistence";
import { createBullMqAnalysisWorker, createJobQueue, createSqsAnalysisWorker, type AnalysisWorkerHandle } from "@anvilstack/queue";
import type { AnalysisJob } from "@anvilstack/shared";
import { analyseAnalysisJob, analysePackageTarget } from "./analysis.js";

const logger = createLogger("anvil-worker");

export async function runWorkerCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const config = loadConfig();
    const registry = new NpmRegistryRouter(config.UPSTREAM_NPM_REGISTRIES);
    const downloadStats = new NpmDownloadsClient({ baseUrl: config.NPM_DOWNLOADS_API });
    const persistence = createPersistence(config);
    const command = argv[0];

    if (command === "--health-check") {
      await healthCheckWorkerDependencies(config);
      logger.info({ queueDriver: config.QUEUE_DRIVER }, "worker dependencies healthy");
      return 0;
    }

    if (command) {
      const objectStore = createObjectStore(config);
      const popularPackageIndex = await loadActivePopularPackageIndex({
        objectStore,
        objectKey: config.POPULAR_PACKAGE_INDEX_OBJECT_KEY,
        indexPath: config.POPULAR_PACKAGE_INDEX_PATH
      });
      const result = await analysePackageTarget(command, { config, registry, persistence, downloadStats, objectStore, popularPackageIndex });
      logger.info({ target: `${result.packageName}@${result.version}`, action: result.decision.action, score: result.decision.score }, "analysis complete");
      return 0;
    }

    await startWorker();
    return 0;
  } catch (error) {
    logger.error({ error }, "worker command failed");
    return 1;
  }
}

export async function startWorker(): Promise<AnalysisWorkerHandle | undefined> {
  const config = loadConfig();
  const registry = new NpmRegistryRouter(config.UPSTREAM_NPM_REGISTRIES);
  const downloadStats = new NpmDownloadsClient({ baseUrl: config.NPM_DOWNLOADS_API });
  const persistence = createPersistence(config);

  if (config.QUEUE_DRIVER === "memory") {
    logger.info("Worker started without external queue. Set QUEUE_DRIVER=bullmq or QUEUE_DRIVER=sqs to consume analysis jobs.");
    return undefined;
  }

  const objectStore = createObjectStore(config);
  const popularPackageIndex = await loadActivePopularPackageIndex({
    objectStore,
    objectKey: config.POPULAR_PACKAGE_INDEX_OBJECT_KEY,
    indexPath: config.POPULAR_PACKAGE_INDEX_PATH
  });

  const handler = async (job: AnalysisJob) => {
    const result = await analyseAnalysisJob(job, { config, registry, persistence, downloadStats, objectStore, popularPackageIndex });
    logger.info(
      {
        jobId: job.id,
        target: `${result.packageName}@${result.version}`,
        action: result.decision.action,
        score: result.decision.score
      },
      "analysis job complete"
    );
  };

  if (config.QUEUE_DRIVER === "bullmq") {
    const worker = await createBullMqAnalysisWorker({
      redisUrl: config.REDIS_URL,
      queueName: config.ANALYSIS_QUEUE_NAME,
      handler
    });

    logger.info({ queueName: config.ANALYSIS_QUEUE_NAME }, "Worker consuming BullMQ analysis queue");
    return worker;
  }

  if (!config.ANALYSIS_QUEUE_URL) throw new Error("ANALYSIS_QUEUE_URL is required when QUEUE_DRIVER=sqs");
  const worker = createSqsAnalysisWorker({
    queueUrl: config.ANALYSIS_QUEUE_URL,
    region: config.AWS_REGION,
    waitTimeSeconds: config.SQS_WAIT_TIME_SECONDS,
    visibilityTimeoutSeconds: config.SQS_VISIBILITY_TIMEOUT_SECONDS,
    handler
  });

  logger.info({ queueUrl: config.ANALYSIS_QUEUE_URL }, "Worker consuming SQS analysis queue");
  return worker;
}

export async function healthCheckWorkerDependencies(config = loadConfig()): Promise<void> {
  const persistence = createPersistence(config);
  const objectStore = createObjectStore(config);
  const queue = createJobQueue(config);

  try {
    await persistence.healthCheck?.();
    await objectStore.healthCheck?.();
    await queue.healthCheck?.();
  } finally {
    await closeIfSupported(persistence);
    await closeIfSupported(objectStore);
    await closeIfSupported(queue);
  }
}

async function closeIfSupported(resource: unknown): Promise<void> {
  const close = (resource as { close?: () => Promise<void> | void }).close;
  await close?.call(resource);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runWorkerCli();
}
