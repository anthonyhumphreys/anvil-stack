import { describe, expect, it } from "vitest";

import { RuntimeError } from "@anvil-cloud/runtime";
import { createAwsRuntimeHostFromEnv } from "../src/index.js";

describe("createAwsRuntimeHostFromEnv", () => {
  it("persists database records through the DynamoDB adapter", async () => {
    const dynamodb = new FakeDynamoDbClient();
    const host = createAwsRuntimeHostFromEnv({
      dynamodb,
      s3: new FakeS3Client(),
      sqs: new FakeSqsClient(),
      env: {
        ANVIL_CELL_DATA_TABLE: "cell-data",
      },
    });
    const notes = host.db.table("notes");

    const inserted = await notes.insert({
      title: "First",
      count: 1,
    });

    expect(inserted).toMatchObject({
      id: expect.stringMatching(/^notes_/),
      title: "First",
      count: 1,
    });
    await expect(notes.get(String(inserted.id))).resolves.toEqual(inserted);
    await expect(notes.where("count", ">=", 1).count()).resolves.toBe(1);
    await expect(notes.where("title", "=", "First").first()).resolves.toEqual(
      inserted,
    );

    const updated = await notes.update(String(inserted.id), {
      count: 2,
    });

    expect(updated).toMatchObject({
      id: inserted.id,
      count: 2,
    });
    await expect(host.db.inspect?.()).resolves.toEqual({
      tables: {
        notes: {
          rows: 1,
        },
      },
    });
    await expect(notes.delete(String(inserted.id))).resolves.toBe(true);
    await expect(notes.get(String(inserted.id))).resolves.toBeNull();
  });

  it("stores files through the S3 adapter", async () => {
    const s3 = new FakeS3Client();
    const host = createAwsRuntimeHostFromEnv({
      dynamodb: new FakeDynamoDbClient(),
      s3,
      sqs: new FakeSqsClient(),
      env: {
        ANVIL_FILES_BUCKET: "cell-files",
      },
    });

    await expect(
      host.files.put("notes/first.txt", new TextEncoder().encode("hello")),
    ).resolves.toEqual({ key: "notes/first.txt" });
    expect(s3.commands[0]?.input).toMatchObject({
      Bucket: "cell-files",
      Key: "notes/first.txt",
      ServerSideEncryption: "AES256",
    });
    await expect(host.files.get("notes/first.txt")).resolves.toEqual(
      new TextEncoder().encode("hello"),
    );
    await expect(host.files.delete("notes/first.txt")).resolves.toBe(true);
    await expect(host.files.get("notes/first.txt")).resolves.toBeNull();
  });

  it("fails clearly when undeclared capabilities are used", async () => {
    const host = createAwsRuntimeHostFromEnv({
      dynamodb: new FakeDynamoDbClient(),
      s3: new FakeS3Client(),
      sqs: new FakeSqsClient(),
      env: {},
    });

    await expect(host.db.table("notes").all()).rejects.toBeInstanceOf(
      RuntimeError,
    );
    await expect(host.files.get("missing.txt")).rejects.toBeInstanceOf(
      RuntimeError,
    );
    await expect(host.jobs.enqueue("refresh", {})).rejects.toBeInstanceOf(
      RuntimeError,
    );
    await expect(host.events.publish("note.created", {})).rejects.toMatchObject(
      {
        code: "CAPABILITY_NOT_DECLARED",
        details: {
          env: "ANVIL_EVENT_BUS_NAME",
        },
      },
    );
  });

  it("enqueues jobs through the SQS adapter", async () => {
    const sqs = new FakeSqsClient();
    const host = createAwsRuntimeHostFromEnv({
      dynamodb: new FakeDynamoDbClient(),
      s3: new FakeS3Client(),
      sqs,
      env: {
        ANVIL_JOB_QUEUE_URL: "https://sqs.example.test/jobs",
      },
    });

    await expect(
      host.jobs.enqueue("refreshNotes", { force: true }),
    ).resolves.toEqual({
      id: "msg_1",
    });
    expect(sqs.commands[0]?.input).toMatchObject({
      QueueUrl: "https://sqs.example.test/jobs",
      MessageBody: JSON.stringify({
        name: "refreshNotes",
        payload: {
          force: true,
        },
      }),
    });
  });

  it("writes structured logs to the supplied logger", async () => {
    const messages: string[] = [];
    const host = createAwsRuntimeHostFromEnv({
      dynamodb: new FakeDynamoDbClient(),
      s3: new FakeS3Client(),
      sqs: new FakeSqsClient(),
      env: {},
      logger: {
        debug: (message) => messages.push(message),
        error: (message) => messages.push(message),
        info: (message) => messages.push(message),
        warn: (message) => messages.push(message),
      },
    });

    await host.logs.write({
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "info",
      requestId: "req_1",
      kind: "query",
      handler: "listNotes",
      message: "Loaded notes",
      meta: {
        count: 1,
      },
    });

    expect(JSON.parse(messages[0] ?? "{}")).toMatchObject({
      level: "info",
      requestId: "req_1",
      message: "Loaded notes",
      meta: {
        count: 1,
      },
    });
  });
});

class FakeDynamoDbClient {
  private readonly items = new Map<string, DynamoDbItem>();

  async send(command: { input: unknown; constructor: { name: string } }) {
    const input = command.input as Record<string, unknown>;

    switch (command.constructor.name) {
      case "PutItemCommand": {
        const item = input.Item as DynamoDbItem;
        this.items.set(itemKey(item), cloneItem(item));

        return {};
      }
      case "GetItemCommand": {
        const item = this.items.get(
          keyFromParts(input.Key as DynamoDbKeyParts),
        );

        return item ? { Item: cloneItem(item) } : {};
      }
      case "DeleteItemCommand": {
        this.items.delete(keyFromParts(input.Key as DynamoDbKeyParts));

        return {};
      }
      case "QueryCommand": {
        const expressionValues = input.ExpressionAttributeValues as Record<
          string,
          { S?: string }
        >;
        const pk = expressionValues[":pk"]?.S;

        return {
          Items: Array.from(this.items.values())
            .filter((item) => item.pk?.S === pk)
            .map(cloneItem),
        };
      }
      case "ScanCommand":
        return {
          Items: Array.from(this.items.values()).map((item) => ({
            pk: {
              S: item.pk?.S,
            },
          })),
        };
      default:
        throw new Error(`Unhandled command ${command.constructor.name}`);
    }
  }
}

class FakeS3Client {
  readonly commands: Array<{ name: string; input: unknown }> = [];
  private readonly objects = new Map<string, Uint8Array>();

  async send(command: { input: unknown; constructor: { name: string } }) {
    this.commands.push({
      name: command.constructor.name,
      input: command.input,
    });

    const input = command.input as Record<string, unknown>;
    const key = `${String(input.Bucket)}/${String(input.Key)}`;

    switch (command.constructor.name) {
      case "PutObjectCommand":
        this.objects.set(key, new Uint8Array(input.Body as Uint8Array));

        return {};
      case "GetObjectCommand": {
        const body = this.objects.get(key);

        return body ? { Body: new Uint8Array(body) } : {};
      }
      case "DeleteObjectCommand":
        this.objects.delete(key);

        return {};
      default:
        throw new Error(`Unhandled command ${command.constructor.name}`);
    }
  }
}

class FakeSqsClient {
  readonly commands: Array<{ name: string; input: unknown }> = [];

  async send(command: { input: unknown; constructor: { name: string } }) {
    this.commands.push({
      name: command.constructor.name,
      input: command.input,
    });

    if (command.constructor.name !== "SendMessageCommand") {
      throw new Error(`Unhandled command ${command.constructor.name}`);
    }

    return {
      MessageId: `msg_${this.commands.length}`,
    };
  }
}

type DynamoDbItem = Record<string, { S?: string }>;

type DynamoDbKeyParts = {
  pk: {
    S: string;
  };
  sk: {
    S: string;
  };
};

function itemKey(item: DynamoDbItem): string {
  return `${item.pk?.S ?? ""}/${item.sk?.S ?? ""}`;
}

function keyFromParts(key: DynamoDbKeyParts): string {
  return `${key.pk.S}/${key.sk.S}`;
}

function cloneItem(item: DynamoDbItem): DynamoDbItem {
  return structuredClone(item) as DynamoDbItem;
}
