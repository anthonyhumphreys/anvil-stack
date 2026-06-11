import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  RuntimeError,
  type AuthAdapter,
  type AuthIdentity,
  type DatabaseAdapter,
  type DatabaseInspection,
  type DatabaseQueryClient,
  type DatabaseRecord,
  type DatabaseTableClient,
  type DatabaseWhereOperator,
  type EnvAdapter,
  type EventAdapter,
  type FileAdapter,
  type JobAdapter,
  type LogAdapter,
  type LogEntry,
  type RuntimeHost,
} from "@anvil-cloud/runtime";

type DynamoDbSender = Pick<DynamoDBClient, "send">;
type S3Sender = Pick<S3Client, "send">;
type SqsSender = Pick<SQSClient, "send">;
type AwsRuntimeLogger = Pick<Console, "debug" | "error" | "info" | "warn">;
type DynamoDbItem = Record<string, AttributeValue>;

export type AwsRuntimeHostOptions = {
  dynamodb?: DynamoDbSender;
  s3?: S3Sender;
  sqs?: SqsSender;
  env?: Record<string, string | undefined>;
  logger?: AwsRuntimeLogger;
};

export function createAwsRuntimeHostFromEnv(
  options: AwsRuntimeHostOptions = {},
): RuntimeHost {
  const env = options.env ?? process.env;

  return {
    db: new AwsDynamoDbDatabaseAdapter({
      client: options.dynamodb ?? new DynamoDBClient({}),
      tableName: env.ANVIL_CELL_DATA_TABLE,
    }),
    files: new AwsS3FileAdapter({
      client: options.s3 ?? new S3Client({}),
      bucketName: env.ANVIL_FILES_BUCKET,
    }),
    env: new AwsEnvAdapter(env),
    auth: new AwsAuthAdapter(),
    logs: new AwsLogAdapter(options.logger ?? console),
    events: new UnsupportedAwsEventAdapter(),
    jobs: new AwsSqsJobAdapter({
      client: options.sqs ?? new SQSClient({}),
      queueUrl: env.ANVIL_JOB_QUEUE_URL,
    }),
  };
}

export class AwsDynamoDbDatabaseAdapter implements DatabaseAdapter {
  constructor(
    private readonly options: {
      client: DynamoDbSender;
      tableName: string | undefined;
    },
  ) {}

  table(name: string): DatabaseTableClient {
    return new AwsDynamoDbTableClient(name, this);
  }

  async inspect(): Promise<DatabaseInspection> {
    if (!this.options.tableName) {
      return { tables: {} };
    }

    const tables: DatabaseInspection["tables"] = {};

    for (const item of await this.scanItems()) {
      const tableName = stringAttribute(item.pk);

      if (!tableName) {
        continue;
      }

      tables[tableName] = {
        rows: (tables[tableName]?.rows ?? 0) + 1,
      };
    }

    return { tables };
  }

  async all(table: string): Promise<DatabaseRecord[]> {
    const responseItems = await this.queryItems(table);

    return responseItems.map(recordFromItem);
  }

  async get(table: string, id: string): Promise<DatabaseRecord | null> {
    const response = await this.options.client.send(
      new GetItemCommand({
        TableName: this.requireTableName(),
        Key: keyFor(table, id),
      }),
    );

    return response.Item ? recordFromItem(response.Item) : null;
  }

  async put(table: string, record: DatabaseRecord): Promise<DatabaseRecord> {
    const stored = prepareRecord(table, record);

    await this.options.client.send(
      new PutItemCommand({
        TableName: this.requireTableName(),
        Item: itemFor(table, stored),
      }),
    );

    return cloneRecord(stored);
  }

  async update(
    table: string,
    id: string,
    patch: DatabaseRecord,
  ): Promise<DatabaseRecord> {
    const existing = await this.get(table, id);

    if (!existing) {
      throw new RuntimeError(
        "NOT_FOUND",
        `Record '${id}' does not exist in table '${table}'.`,
        404,
        { table, id },
      );
    }

    const updated = {
      ...existing,
      ...cloneRecord(patch),
      id,
    };

    await this.options.client.send(
      new PutItemCommand({
        TableName: this.requireTableName(),
        Item: itemFor(table, updated),
      }),
    );

    return cloneRecord(updated);
  }

  async delete(table: string, id: string): Promise<boolean> {
    const existing = await this.get(table, id);

    if (!existing) {
      return false;
    }

    await this.options.client.send(
      new DeleteItemCommand({
        TableName: this.requireTableName(),
        Key: keyFor(table, id),
      }),
    );

    return true;
  }

  private async queryItems(table: string): Promise<DynamoDbItem[]> {
    const items: DynamoDbItem[] = [];
    let exclusiveStartKey: DynamoDbItem | undefined;

    do {
      const input: {
        TableName: string;
        KeyConditionExpression: string;
        ExpressionAttributeValues: Record<string, AttributeValue>;
        ExclusiveStartKey?: DynamoDbItem;
      } = {
        TableName: this.requireTableName(),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": { S: table },
        },
      };

      if (exclusiveStartKey !== undefined) {
        input.ExclusiveStartKey = exclusiveStartKey;
      }

      const response = await this.options.client.send(new QueryCommand(input));

      items.push(...(response.Items ?? []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return items;
  }

  private async scanItems(): Promise<DynamoDbItem[]> {
    const items: DynamoDbItem[] = [];
    let exclusiveStartKey: DynamoDbItem | undefined;

    do {
      const input: {
        TableName: string;
        ProjectionExpression: string;
        ExclusiveStartKey?: DynamoDbItem;
      } = {
        TableName: this.requireTableName(),
        ProjectionExpression: "pk",
      };

      if (exclusiveStartKey !== undefined) {
        input.ExclusiveStartKey = exclusiveStartKey;
      }

      const response = await this.options.client.send(new ScanCommand(input));

      items.push(...(response.Items ?? []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return items;
  }

  private requireTableName(): string {
    if (!this.options.tableName) {
      throw new RuntimeError(
        "CAPABILITY_NOT_DECLARED",
        "Database capability is not configured for this AWS runtime.",
        403,
        { env: "ANVIL_CELL_DATA_TABLE" },
      );
    }

    return this.options.tableName;
  }
}

class AwsDynamoDbTableClient implements DatabaseTableClient {
  constructor(
    private readonly name: string,
    private readonly adapter: AwsDynamoDbDatabaseAdapter,
  ) {}

  async all(): Promise<DatabaseRecord[]> {
    return this.adapter.all(this.name);
  }

  async get(id: string): Promise<DatabaseRecord | null> {
    return this.adapter.get(this.name, id);
  }

  async insert(record: DatabaseRecord): Promise<DatabaseRecord> {
    return this.adapter.put(this.name, record);
  }

  async update(id: string, patch: DatabaseRecord): Promise<DatabaseRecord> {
    return this.adapter.update(this.name, id, patch);
  }

  async delete(id: string): Promise<boolean> {
    return this.adapter.delete(this.name, id);
  }

  where(
    field: string,
    operator: DatabaseWhereOperator,
    value: unknown,
  ): DatabaseQueryClient {
    return {
      all: async () => this.matching(field, operator, value),
      first: async () => {
        const [first] = await this.matching(field, operator, value);

        return first ?? null;
      },
      count: async () => {
        return (await this.matching(field, operator, value)).length;
      },
    };
  }

  private async matching(
    field: string,
    operator: DatabaseWhereOperator,
    value: unknown,
  ): Promise<DatabaseRecord[]> {
    return (await this.all()).filter((record) =>
      compare(record[field], operator, value),
    );
  }
}

export class AwsS3FileAdapter implements FileAdapter {
  constructor(
    private readonly options: {
      client: S3Sender;
      bucketName: string | undefined;
    },
  ) {}

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const response = await this.options.client.send(
        new GetObjectCommand({
          Bucket: this.requireBucketName(),
          Key: key,
        }),
      );

      if (!response.Body) {
        return null;
      }

      return readBody(response.Body);
    } catch (error) {
      if (isMissingAwsObject(error)) {
        return null;
      }

      throw error;
    }
  }

  async put(key: string, body: Uint8Array): Promise<{ key: string }> {
    await this.options.client.send(
      new PutObjectCommand({
        Bucket: this.requireBucketName(),
        Key: key,
        Body: Buffer.from(body),
      }),
    );

    return { key };
  }

  async delete(key: string): Promise<boolean> {
    const existing = await this.get(key);

    if (!existing) {
      return false;
    }

    await this.options.client.send(
      new DeleteObjectCommand({
        Bucket: this.requireBucketName(),
        Key: key,
      }),
    );

    return true;
  }

  private requireBucketName(): string {
    if (!this.options.bucketName) {
      throw new RuntimeError(
        "CAPABILITY_NOT_DECLARED",
        "File capability is not configured for this AWS runtime.",
        403,
        { env: "ANVIL_FILES_BUCKET" },
      );
    }

    return this.options.bucketName;
  }
}

class AwsEnvAdapter implements EnvAdapter {
  constructor(private readonly values: Record<string, string | undefined>) {}

  get(name: string): string | undefined {
    return this.values[name];
  }
}

class AwsAuthAdapter implements AuthAdapter {
  async current(): Promise<AuthIdentity | null> {
    return null;
  }
}

class AwsLogAdapter implements LogAdapter {
  constructor(private readonly logger: AwsRuntimeLogger) {}

  async write(entry: LogEntry): Promise<void> {
    this.logger[entry.level](JSON.stringify(entry));
  }
}

class UnsupportedAwsEventAdapter implements EventAdapter {
  async publish(name: string, payload: unknown): Promise<void> {
    void payload;
    throw unsupportedAdapterError("Event publishing", name);
  }
}

class AwsSqsJobAdapter implements JobAdapter {
  constructor(
    private readonly options: {
      client: SqsSender;
      queueUrl: string | undefined;
    },
  ) {}

  async enqueue(name: string, payload: unknown): Promise<{ id: string }> {
    const response = await this.options.client.send(
      new SendMessageCommand({
        QueueUrl: this.requireQueueUrl(),
        MessageBody: JSON.stringify({
          name,
          payload,
        }),
      }),
    );

    return {
      id:
        typeof response.MessageId === "string"
          ? response.MessageId
          : `job_${randomUUID()}`,
    };
  }

  private requireQueueUrl(): string {
    if (!this.options.queueUrl) {
      throw new RuntimeError(
        "CAPABILITY_NOT_DECLARED",
        "Job capability is not configured for this AWS runtime.",
        403,
        { env: "ANVIL_JOB_QUEUE_URL" },
      );
    }

    return this.options.queueUrl;
  }
}

function prepareRecord(
  table: string,
  record: DatabaseRecord,
): DatabaseRecord & { id: string } {
  const cloned = cloneRecord(record);
  const id =
    cloned.id === undefined ? `${table}_${randomUUID()}` : String(cloned.id);

  return {
    ...cloned,
    id,
  };
}

function keyFor(table: string, id: string): DynamoDbItem {
  return {
    pk: { S: table },
    sk: { S: id },
  };
}

function itemFor(table: string, record: DatabaseRecord): DynamoDbItem {
  const id = String(record.id);

  return {
    ...keyFor(table, id),
    data: {
      S: JSON.stringify(record),
    },
  };
}

function recordFromItem(item: DynamoDbItem): DatabaseRecord {
  const data = stringAttribute(item.data);

  if (!data) {
    throw new RuntimeError(
      "ADAPTER_ERROR",
      "DynamoDB record is missing its JSON data attribute.",
      500,
    );
  }

  const parsed = JSON.parse(data) as unknown;

  if (!isRecord(parsed)) {
    throw new RuntimeError(
      "ADAPTER_ERROR",
      "DynamoDB record data is not a JSON object.",
      500,
    );
  }

  return parsed;
}

function stringAttribute(attribute: AttributeValue | undefined): string | null {
  if (attribute && "S" in attribute && typeof attribute.S === "string") {
    return attribute.S;
  }

  return null;
}

async function readBody(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return new Uint8Array(body);
  }

  if (typeof body === "string") {
    return new Uint8Array(Buffer.from(body, "utf8"));
  }

  if (body instanceof Readable) {
    const chunks: Buffer[] = [];

    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return new Uint8Array(Buffer.concat(chunks));
  }

  if (
    isObject(body) &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    return new Uint8Array(await body.transformToByteArray());
  }

  throw new RuntimeError(
    "ADAPTER_ERROR",
    "S3 object body could not be converted to bytes.",
    500,
  );
}

function cloneRecord(record: DatabaseRecord): DatabaseRecord {
  return structuredClone(record) as DatabaseRecord;
}

function compare(
  left: unknown,
  operator: DatabaseWhereOperator,
  right: unknown,
): boolean {
  switch (operator) {
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return (
        typeof left === "number" && typeof right === "number" && left > right
      );
    case ">=":
      return (
        typeof left === "number" && typeof right === "number" && left >= right
      );
    case "<":
      return (
        typeof left === "number" && typeof right === "number" && left < right
      );
    case "<=":
      return (
        typeof left === "number" && typeof right === "number" && left <= right
      );
  }
}

function unsupportedAdapterError(action: string, name: string): RuntimeError {
  return new RuntimeError(
    "ADAPTER_ERROR",
    `${action} is not implemented by the AWS preview runtime yet.`,
    501,
    { name },
  );
}

function isMissingAwsObject(error: unknown): boolean {
  const metadata = isObject(error) ? error.$metadata : undefined;

  return (
    isObject(error) &&
    (error.name === "NoSuchKey" ||
      error.name === "NotFound" ||
      (isObject(metadata) && metadata.httpStatusCode === 404))
  );
}

function isRecord(value: unknown): value is DatabaseRecord {
  return isObject(value) && !Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
