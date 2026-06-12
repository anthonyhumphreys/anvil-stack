import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@anvilstack/config";
import {
  BullMqJobQueue,
  MemoryJobQueue,
  SqsJobQueue,
  connectionFromRedisUrl,
  createJobQueue,
  createSqsAnalysisWorker,
  type SqsAnalysisWorker,
  type SqsClientLike
} from "./index.js";

describe("queue factory", () => {
  it("uses memory queue by default", () => {
    expect(createJobQueue(loadConfig({ ...process.env, QUEUE_DRIVER: "memory" }))).toBeInstanceOf(MemoryJobQueue);
  });

  it("uses BullMQ queue when configured", async () => {
    const queue = createJobQueue(loadConfig({ ...process.env, QUEUE_DRIVER: "bullmq", REDIS_URL: "redis://localhost:6379" }));
    expect(queue).toBeInstanceOf(BullMqJobQueue);
    await (queue as BullMqJobQueue).close();
  });

  it("uses SQS queue when configured", () => {
    const queue = createJobQueue(loadConfig({ ...process.env, QUEUE_DRIVER: "sqs", ANALYSIS_QUEUE_URL: "https://sqs.example.test/queue" }));
    expect(queue).toBeInstanceOf(SqsJobQueue);
    (queue as SqsJobQueue).close();
  });

  it("parses Redis URLs with credentials", () => {
    expect(connectionFromRedisUrl("redis://user:pass@redis.example.test:6380")).toEqual({
      host: "redis.example.test",
      port: 6380,
      username: "user",
      password: "pass"
    });
  });

  it("normalizes queued analysis jobs before storing them", async () => {
    const queue = new MemoryJobQueue();

    await queue.enqueueAnalysisJob({
      packageName: " pkg ",
      version: " 1.0.0 ",
      requestedBy: " reviewer ",
      reason: "metadata_request",
      priority: "normal",
      createdAt: " 2026-05-20T00:00:00.000Z "
    });

    const jobs: unknown[] = [];
    for await (const job of queue.receiveAnalysisJobs()) jobs.push(job);

    expect(jobs).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        packageName: "pkg",
        version: "1.0.0",
        requestedBy: "reviewer",
        reason: "metadata_request",
        priority: "normal",
        createdAt: "2026-05-20T00:00:00.000Z"
      })
    ]);
  });

  it("reports memory queue depth", async () => {
    const queue = new MemoryJobQueue();

    await queue.enqueueAnalysisJob({
      packageName: "pkg",
      version: "1.0.0",
      reason: "metadata_request",
      priority: "normal",
      createdAt: "2026-05-20T00:00:00.000Z"
    });

    expect(await queue.getStats()).toMatchObject({
      driver: "memory",
      waiting: 1,
      active: 0,
      delayed: 0,
      failed: 0,
      totalPending: 1,
      checkedAt: expect.any(String)
    });
  });

  it("rejects malformed analysis jobs before enqueueing them", async () => {
    const queue = new MemoryJobQueue();
    const malformedJob = {
      packageName: "pkg",
      version: "1.0.0",
      reason: "metadata_request",
      priority: "urgent",
      createdAt: "2026-05-20T00:00:00.000Z"
    } as unknown as Parameters<MemoryJobQueue["enqueueAnalysisJob"]>[0];

    await expect(queue.enqueueAnalysisJob(malformedJob)).rejects.toThrow();
  });

  it("sends analysis jobs to SQS", async () => {
    const client = new FakeSqsClient();
    const queue = new SqsJobQueue({ queueUrl: "https://sqs.example.test/queue", region: "us-east-1", client });

    await queue.enqueueAnalysisJob({
      packageName: "pkg",
      version: "1.0.0",
      reason: "metadata_request",
      priority: "normal",
      createdAt: "2026-05-20T00:00:00.000Z"
    });

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]?.constructor.name).toBe("SendMessageCommand");
    expect(client.commands[0]?.input).toMatchObject({ QueueUrl: "https://sqs.example.test/queue" });
    expect(JSON.parse(String(client.commands[0]?.input.MessageBody))).toMatchObject({ packageName: "pkg", version: "1.0.0" });
  });

  it("maps SQS approximate queue attributes into stats", async () => {
    const client = new FakeSqsClient();
    client.attributeResponse = {
      Attributes: {
        ApproximateNumberOfMessages: "3",
        ApproximateNumberOfMessagesNotVisible: "2",
        ApproximateNumberOfMessagesDelayed: "1"
      }
    };
    const queue = new SqsJobQueue({ queueUrl: "https://sqs.example.test/queue", region: "us-east-1", client });

    expect(await queue.getStats()).toMatchObject({
      driver: "sqs",
      waiting: 3,
      active: 2,
      delayed: 1,
      failed: 0,
      totalPending: 6
    });
    expect(client.commands[0]?.input).toMatchObject({
      QueueUrl: "https://sqs.example.test/queue",
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"]
    });
  });

  it("consumes SQS messages and deletes them after successful analysis", async () => {
    let sawDeleteMessage!: () => void;
    const deleteMessageSeen = new Promise<void>((resolve) => {
      sawDeleteMessage = resolve;
    });
    let worker: SqsAnalysisWorker;
    const client = new FakeSqsClient([
      {
        Messages: [
          {
            MessageId: "message-1",
            ReceiptHandle: "receipt-1",
            Body: JSON.stringify({
              packageName: "pkg",
              version: "1.0.0",
              reason: "metadata_request",
              priority: "normal",
              createdAt: "2026-05-20T00:00:00.000Z"
            })
          }
        ]
      }
    ]);
    client.onCommand = (commandName) => {
      if (commandName === "DeleteMessageCommand") {
        void worker.close();
        sawDeleteMessage();
      }
    };
    const handled = new Promise<void>((resolve) => {
      worker = createSqsAnalysisWorker({
        queueUrl: "https://sqs.example.test/queue",
        region: "us-east-1",
        waitTimeSeconds: 0,
        client,
        handler: async (job) => {
          expect(job).toMatchObject({ id: "message-1", packageName: "pkg", version: "1.0.0" });
          resolve();
        }
      });
    });

    await handled;
    await deleteMessageSeen;
    expect(client.commands.map((command) => command.constructor.name)).toContain("DeleteMessageCommand");
  });

  it("returns failed SQS messages to the queue for retry", async () => {
    let sawRetry!: () => void;
    const retrySeen = new Promise<void>((resolve) => {
      sawRetry = resolve;
    });
    let worker: SqsAnalysisWorker;
    const client = new FakeSqsClient([
      {
        Messages: [
          {
            MessageId: "message-1",
            ReceiptHandle: "receipt-1",
            Body: JSON.stringify({
              packageName: "pkg",
              version: "1.0.0",
              reason: "metadata_request",
              priority: "normal",
              createdAt: "2026-05-20T00:00:00.000Z"
            })
          }
        ]
      }
    ]);
    client.onCommand = (commandName) => {
      if (commandName === "ChangeMessageVisibilityCommand") {
        void worker.close();
        sawRetry();
      }
    };

    worker = createSqsAnalysisWorker({
      queueUrl: "https://sqs.example.test/queue",
      region: "us-east-1",
      waitTimeSeconds: 0,
      client,
      handler: async () => {
        throw new Error("analysis failed");
      }
    });

    await retrySeen;
    expect(client.commands.find((command) => command.constructor.name === "ChangeMessageVisibilityCommand")?.input).toMatchObject({
      QueueUrl: "https://sqs.example.test/queue",
      ReceiptHandle: "receipt-1",
      VisibilityTimeout: 0
    });
  });

  it("returns malformed SQS analysis jobs to the queue without calling the handler", async () => {
    let sawRetry!: () => void;
    const retrySeen = new Promise<void>((resolve) => {
      sawRetry = resolve;
    });
    let worker: SqsAnalysisWorker | undefined;
    const client = new FakeSqsClient([
      {
        Messages: [
          {
            MessageId: "message-1",
            ReceiptHandle: "receipt-1",
            Body: JSON.stringify({
              packageName: "pkg",
              version: "1.0.0",
              reason: "metadata_request",
              priority: "urgent",
              createdAt: "2026-05-20T00:00:00.000Z"
            })
          }
        ]
      }
    ]);
    client.onCommand = (commandName) => {
      if (commandName === "ChangeMessageVisibilityCommand") {
        client.destroy();
        void worker?.close();
        sawRetry();
      }
    };
    const handler = vi.fn(async () => {});

    worker = createSqsAnalysisWorker({
      queueUrl: "https://sqs.example.test/queue",
      region: "us-east-1",
      waitTimeSeconds: 0,
      client,
      handler
    });

    await retrySeen;
    expect(handler).not.toHaveBeenCalled();
    expect(client.commands.find((command) => command.constructor.name === "ChangeMessageVisibilityCommand")?.input).toMatchObject({
      QueueUrl: "https://sqs.example.test/queue",
      ReceiptHandle: "receipt-1",
      VisibilityTimeout: 0
    });
    expect(client.commands.map((command) => command.constructor.name)).not.toContain("DeleteMessageCommand");
  });

  it("continues polling SQS after transient receive failures", async () => {
    let sawDeleteMessage!: () => void;
    const deleteMessageSeen = new Promise<void>((resolve) => {
      sawDeleteMessage = resolve;
    });
    let worker: SqsAnalysisWorker;
    const client = new FakeSqsClient([
      new Error("receive throttled"),
      {
        Messages: [
          {
            MessageId: "message-1",
            ReceiptHandle: "receipt-1",
            Body: JSON.stringify({
              packageName: "pkg",
              version: "1.0.0",
              reason: "metadata_request",
              priority: "normal",
              createdAt: "2026-05-20T00:00:00.000Z"
            })
          }
        ]
      }
    ]);
    client.onCommand = (commandName) => {
      if (commandName === "DeleteMessageCommand") {
        void worker.close();
        sawDeleteMessage();
      }
    };
    const handler = vi.fn(async () => {});

    worker = createSqsAnalysisWorker({
      queueUrl: "https://sqs.example.test/queue",
      region: "us-east-1",
      waitTimeSeconds: 0,
      pollErrorDelayMs: 0,
      client,
      handler
    });

    await deleteMessageSeen;
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: "message-1", packageName: "pkg", version: "1.0.0" }));
    expect(client.commands.map((command) => command.constructor.name)).toEqual(
      expect.arrayContaining(["ReceiveMessageCommand", "DeleteMessageCommand"])
    );
  });

  it("continues polling SQS when returning a failed message for retry fails", async () => {
    let sawDeleteMessage!: () => void;
    const deleteMessageSeen = new Promise<void>((resolve) => {
      sawDeleteMessage = resolve;
    });
    let worker: SqsAnalysisWorker;
    const client = new FakeSqsClient([
      {
        Messages: [
          {
            MessageId: "message-1",
            ReceiptHandle: "receipt-1",
            Body: JSON.stringify({
              packageName: "pkg",
              version: "1.0.0",
              reason: "metadata_request",
              priority: "normal",
              createdAt: "2026-05-20T00:00:00.000Z"
            })
          }
        ]
      },
      {
        Messages: [
          {
            MessageId: "message-2",
            ReceiptHandle: "receipt-2",
            Body: JSON.stringify({
              packageName: "safe-pkg",
              version: "2.0.0",
              reason: "metadata_request",
              priority: "normal",
              createdAt: "2026-05-20T00:00:00.000Z"
            })
          }
        ]
      }
    ]);
    client.failOnce("ChangeMessageVisibilityCommand", new Error("visibility reset failed"));
    client.onCommand = (commandName) => {
      if (commandName === "DeleteMessageCommand") {
        void worker.close();
        sawDeleteMessage();
      }
    };
    const handler = vi.fn(async (job) => {
      if (job.packageName === "pkg") throw new Error("analysis failed");
    });

    worker = createSqsAnalysisWorker({
      queueUrl: "https://sqs.example.test/queue",
      region: "us-east-1",
      waitTimeSeconds: 0,
      pollErrorDelayMs: 0,
      client,
      handler
    });

    await deleteMessageSeen;
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: "message-1", packageName: "pkg" }));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: "message-2", packageName: "safe-pkg" }));
    expect(client.commands.map((command) => command.constructor.name)).toEqual(
      expect.arrayContaining(["ChangeMessageVisibilityCommand", "DeleteMessageCommand"])
    );
  });
});

class FakeSqsClient implements SqsClientLike {
  readonly commands: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = [];
  onCommand?: (commandName: string) => void;
  attributeResponse?: unknown;
  private readonly commandFailures = new Map<string, Error[]>();
  private destroyed = false;

  constructor(private readonly receiveResponses: unknown[] = []) {}

  async send(command: Parameters<SqsClientLike["send"]>[0]): Promise<unknown> {
    if (this.destroyed) throw new Error("SQS client closed");
    const recorded = command as unknown as { constructor: { name: string }; input: Record<string, unknown> };
    this.commands.push(recorded);
    this.onCommand?.(recorded.constructor.name);
    const failures = this.commandFailures.get(recorded.constructor.name);
    const failure = failures?.shift();
    if (failure) throw failure;
    if (recorded.constructor.name === "ReceiveMessageCommand") {
      const response = this.receiveResponses.shift();
      if (response instanceof Error) throw response;
      return response ?? {};
    }
    if (recorded.constructor.name === "GetQueueAttributesCommand") return this.attributeResponse ?? {};
    return {};
  }

  destroy(): void {
    this.destroyed = true;
  }

  failOnce(commandName: string, error: Error): void {
    const failures = this.commandFailures.get(commandName) ?? [];
    failures.push(error);
    this.commandFailures.set(commandName, failures);
  }
}
