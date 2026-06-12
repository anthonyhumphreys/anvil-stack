import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient
} from "@aws-sdk/client-sqs";
import { Queue, type Job, type WorkerOptions } from "bullmq";
import type { AnvilConfig } from "@anvilstack/config";
import { analysisJobSchema, type AnalysisJob } from "@anvilstack/shared";

export type AnalysisQueueStats = {
  driver: "memory" | "bullmq" | "sqs";
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed?: number;
  totalPending: number;
  checkedAt: string;
};

export interface JobQueue {
  healthCheck?(): Promise<void>;
  getStats(): Promise<AnalysisQueueStats>;
  enqueueAnalysisJob(job: AnalysisJob): Promise<void>;
  receiveAnalysisJobs(): AsyncIterable<AnalysisJob>;
  acknowledge(jobId: string): Promise<void>;
  fail(jobId: string, reason: string): Promise<void>;
}

export class MemoryJobQueue implements JobQueue {
  private readonly jobs: AnalysisJob[] = [];

  async healthCheck(): Promise<void> {}

  async getStats(): Promise<AnalysisQueueStats> {
    return queueStats("memory", {
      waiting: this.jobs.length,
      active: 0,
      delayed: 0,
      failed: 0
    });
  }

  async enqueueAnalysisJob(job: AnalysisJob): Promise<void> {
    this.jobs.push(normalizeAnalysisJob(job, crypto.randomUUID()));
  }

  async *receiveAnalysisJobs(): AsyncIterable<AnalysisJob> {
    while (this.jobs.length > 0) {
      yield this.jobs.shift()!;
    }
  }

  async acknowledge(): Promise<void> {}

  async fail(_jobId: string, reason: string): Promise<void> {
    throw new Error(`Analysis job failed: ${reason}`);
  }
}

export class BullMqJobQueue implements JobQueue {
  private readonly queue: Queue<AnalysisJob>;

  constructor(options: { redisUrl: string; queueName: string }) {
    this.queue = new Queue<AnalysisJob>(options.queueName, {
      connection: connectionFromRedisUrl(options.redisUrl)
    });
  }

  async enqueueAnalysisJob(job: AnalysisJob): Promise<void> {
    const normalized = normalizeAnalysisJob(job, crypto.randomUUID());
    await this.queue.add("analysis", normalized, { priority: priorityValue(normalized.priority) });
  }

  async healthCheck(): Promise<void> {
    await this.queue.getJobCounts("waiting", "active", "delayed", "failed");
  }

  async getStats(): Promise<AnalysisQueueStats> {
    const counts = await this.queue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "prioritized", "waiting-children", "paused");
    const waiting = count(counts.waiting) + count(counts.prioritized) + count(counts["waiting-children"]) + count(counts.paused);
    const active = count(counts.active);
    const delayed = count(counts.delayed);
    const failed = count(counts.failed);
    return queueStats("bullmq", {
      waiting,
      active,
      delayed,
      failed,
      completed: count(counts.completed)
    });
  }

  receiveAnalysisJobs(): AsyncIterable<AnalysisJob> {
    throw new Error("BullMqJobQueue.receiveAnalysisJobs is not used directly; use createBullMqWorker for worker consumption.");
  }

  async acknowledge(): Promise<void> {}

  async fail(_jobId: string, reason: string): Promise<void> {
    throw new Error(`Analysis job failed: ${reason}`);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export class SqsJobQueue implements JobQueue {
  private readonly client: SqsClientLike;
  private readonly queueUrl: string;

  constructor(options: { queueUrl: string; region: string; client?: SqsClientLike }) {
    this.queueUrl = options.queueUrl;
    this.client = options.client ?? new SQSClient({ region: options.region });
  }

  async enqueueAnalysisJob(job: AnalysisJob): Promise<void> {
    const jobWithId = normalizeAnalysisJob(job, crypto.randomUUID());
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(jobWithId)
      })
    );
  }

  async healthCheck(): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: ["QueueArn"]
      })
    );
  }

  async getStats(): Promise<AnalysisQueueStats> {
    const response = (await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"]
      })
    )) as SqsAttributesResponse;
    const attributes = response.Attributes ?? {};
    return queueStats("sqs", {
      waiting: numberAttribute(attributes.ApproximateNumberOfMessages),
      active: numberAttribute(attributes.ApproximateNumberOfMessagesNotVisible),
      delayed: numberAttribute(attributes.ApproximateNumberOfMessagesDelayed),
      failed: 0
    });
  }

  receiveAnalysisJobs(): AsyncIterable<AnalysisJob> {
    throw new Error("SqsJobQueue.receiveAnalysisJobs is not used directly; use createSqsAnalysisWorker for worker consumption.");
  }

  async acknowledge(): Promise<void> {}

  async fail(_jobId: string, reason: string): Promise<void> {
    throw new Error(`Analysis job failed: ${reason}`);
  }

  close(): void {
    this.client.destroy?.();
  }
}

export type AnalysisWorkerHandle = {
  close(): Promise<void>;
};

export type BullMqAnalysisWorker = AnalysisWorkerHandle;
export type SqsAnalysisWorker = AnalysisWorkerHandle;

export async function createBullMqAnalysisWorker(options: {
  redisUrl: string;
  queueName: string;
  handler: (job: AnalysisJob) => Promise<void>;
  concurrency?: number;
}): Promise<BullMqAnalysisWorker> {
  const { Worker } = await import("bullmq");
  const workerOptions: WorkerOptions = {
    connection: connectionFromRedisUrl(options.redisUrl),
    concurrency: options.concurrency ?? 2
  };
  const worker = new Worker<AnalysisJob>(
    options.queueName,
    async (job: Job<AnalysisJob>) => {
      await options.handler(normalizeAnalysisJob(job.data, job.id));
    },
    workerOptions
  );

  return {
    close: () => worker.close()
  };
}

export function createSqsAnalysisWorker(options: {
  queueUrl: string;
  region: string;
  handler: (job: AnalysisJob) => Promise<void>;
  waitTimeSeconds?: number;
  visibilityTimeoutSeconds?: number;
  pollErrorDelayMs?: number;
  client?: SqsClientLike;
}): SqsAnalysisWorker {
  const client = options.client ?? new SQSClient({ region: options.region });
  const pollErrorDelayMs = options.pollErrorDelayMs ?? 1000;
  let running = true;

  const loop = (async () => {
    while (running) {
      let response: SqsReceiveResponse;
      try {
        response = (await client.send(
          new ReceiveMessageCommand({
            QueueUrl: options.queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: options.waitTimeSeconds ?? 20,
            VisibilityTimeout: options.visibilityTimeoutSeconds ?? 300
          })
        )) as SqsReceiveResponse;
      } catch {
        if (!running) break;
        if (pollErrorDelayMs > 0) await sleep(pollErrorDelayMs);
        continue;
      }

      for (const message of response.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle) continue;

        try {
          const job = parseSqsAnalysisJob(message.Body, message.MessageId);
          await options.handler(job);
          await client.send(new DeleteMessageCommand({ QueueUrl: options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
        } catch {
          await returnSqsMessageForRetry(client, options.queueUrl, message.ReceiptHandle);
        }
      }
    }
  })().catch(() => undefined);

  return {
    async close() {
      running = false;
      void loop;
      client.destroy?.();
    }
  };
}

async function returnSqsMessageForRetry(client: SqsClientLike, queueUrl: string, receiptHandle: string): Promise<void> {
  try {
    await client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: 0
      })
    );
  } catch {
    // If the visibility reset fails, SQS will still retry after the original timeout.
    // Keep polling so one AWS hiccup does not retire the worker.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createJobQueue(config: AnvilConfig): JobQueue {
  if (config.QUEUE_DRIVER === "bullmq") {
    return new BullMqJobQueue({
      redisUrl: config.REDIS_URL,
      queueName: config.ANALYSIS_QUEUE_NAME
    });
  }

  if (config.QUEUE_DRIVER === "sqs") {
    if (!config.ANALYSIS_QUEUE_URL) throw new Error("ANALYSIS_QUEUE_URL is required when QUEUE_DRIVER=sqs");
    return new SqsJobQueue({
      queueUrl: config.ANALYSIS_QUEUE_URL,
      region: config.AWS_REGION
    });
  }

  return new MemoryJobQueue();
}

export function connectionFromRedisUrl(redisUrl: string): { host: string; port: number; password?: string; username?: string } {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username || undefined,
    password: url.password || undefined
  };
}

function priorityValue(priority: AnalysisJob["priority"]): number {
  if (priority === "high") return 1;
  if (priority === "normal") return 5;
  return 10;
}

function parseSqsAnalysisJob(body: string, messageId?: string): AnalysisJob {
  return normalizeAnalysisJob(JSON.parse(body), messageId);
}

function normalizeAnalysisJob(job: unknown, fallbackId?: string): AnalysisJob {
  const candidate = typeof job === "object" && job ? { ...job, id: (job as AnalysisJob).id ?? fallbackId } : job;
  return analysisJobSchema.parse(candidate);
}

function queueStats(driver: AnalysisQueueStats["driver"], counts: Omit<AnalysisQueueStats, "driver" | "totalPending" | "checkedAt">): AnalysisQueueStats {
  return {
    driver,
    ...counts,
    totalPending: counts.waiting + counts.active + counts.delayed,
    checkedAt: new Date().toISOString()
  };
}

function count(value: number | undefined): number {
  return typeof value === "number" ? value : 0;
}

function numberAttribute(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type SqsClientLike = {
  send(command: SendMessageCommand | ReceiveMessageCommand | DeleteMessageCommand | ChangeMessageVisibilityCommand | GetQueueAttributesCommand): Promise<unknown>;
  destroy?: () => void;
};

type SqsAttributesResponse = {
  Attributes?: {
    ApproximateNumberOfMessages?: string;
    ApproximateNumberOfMessagesNotVisible?: string;
    ApproximateNumberOfMessagesDelayed?: string;
  };
};

type SqsReceiveResponse = {
  Messages?: Array<{
    MessageId?: string;
    ReceiptHandle?: string;
    Body?: string;
  }>;
};
