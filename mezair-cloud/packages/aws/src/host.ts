import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  OidcTokenVerifier,
  type ClaimsMapping,
  type OidcVerifierOptions,
  type TokenVerifier,
} from "@mezair-cloud/auth";
import {
  RuntimeError,
  databaseConflict,
  databaseRecordJson,
  databasePageLimit,
  validateDatabaseWrites,
  type AuthAdapter,
  type AuthIdentity,
  type DatabaseAdapter,
  type DatabaseInspection,
  type DatabaseQueryClient,
  type DatabaseRecord,
  type DatabaseTableClient,
  type DatabasePageOptions,
  type DatabaseWhereOperator,
  type DatabaseWrite,
  type EnvAdapter,
  type EventAdapter,
  type FileAdapter,
  type JobAdapter,
  type LogAdapter,
  type LogEntry,
  type RuntimeHost,
  type WorkflowAdapter,
} from "@mezair-cloud/runtime";

type DynamoDbSender = Pick<DynamoDBClient, "send">;
type S3Sender = Pick<S3Client, "send">;
type SqsSender = Pick<SQSClient, "send">;
type EventBridgeSender = Pick<EventBridgeClient, "send">;
type StepFunctionsSender = Pick<SFNClient, "send">;
type AwsRuntimeLogger = Pick<Console, "debug" | "error" | "info" | "warn">;
type DynamoDbItem = Record<string, AttributeValue>;

export type AwsRuntimeHostOptions = {
  dynamodb?: DynamoDbSender;
  s3?: S3Sender;
  sqs?: SqsSender;
  eventbridge?: EventBridgeSender;
  stepfunctions?: StepFunctionsSender;
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
      tableName: env.MEZAIR_CELL_DATA_TABLE,
    }),
    files: new AwsS3FileAdapter({
      client: options.s3 ?? new S3Client({}),
      bucketName: env.MEZAIR_FILES_BUCKET,
    }),
    env: new AwsEnvAdapter(env),
    auth: new AwsOidcAuthAdapter(env),
    logs: new AwsLogAdapter(options.logger ?? console),
    events: env.MEZAIR_EVENT_BUS_NAME
      ? new AwsEventBridgeEventAdapter({
          client: options.eventbridge ?? new EventBridgeClient({}),
          eventBusName: env.MEZAIR_EVENT_BUS_NAME,
          source: `mezair.cell.${env.MEZAIR_CELL ?? "cell"}`,
        })
      : new UnconfiguredAwsEventAdapter(),
    jobs: new AwsSqsJobAdapter({
      client: options.sqs ?? new SQSClient({}),
      queueUrl: env.MEZAIR_JOB_QUEUE_URL,
    }),
    workflows: new AwsStepFunctionsWorkflowAdapter({
      client: options.stepfunctions ?? new SFNClient({}),
      stateMachines: parseWorkflowStateMachines(
        env.MEZAIR_WORKFLOW_STATE_MACHINES,
      ),
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

  async commit(writes: readonly DatabaseWrite[]): Promise<void> {
    validateDatabaseWrites(writes);
    writes = structuredClone(writes);
    const tableName = this.requireTableName();
    // Preserve the exact stored JSON in DynamoDB conditions, including legacy key order.
    const conditions = await Promise.all(
      writes.map(async (write) => {
        const current = await this.options.client.send(
          new GetItemCommand({
            TableName: tableName,
            Key: keyFor(write.table, write.id),
            ConsistentRead: true,
          }),
        );
        if (
          databaseRecordJson(
            current.Item ? recordFromItem(current.Item) : null,
          ) !== databaseRecordJson(write.expected)
        )
          throw databaseConflict();
        return current.Item ? stringAttribute(current.Item.data) : null;
      }),
    );
    try {
      await this.options.client.send(
        new TransactWriteItemsCommand({
          TransactItems: writes.map((write, index) => {
            const condition =
              conditions[index] === null
                ? { ConditionExpression: "attribute_not_exists(pk)" }
                : {
                    ConditionExpression: "#data = :expected",
                    ExpressionAttributeNames: { "#data": "data" },
                    ExpressionAttributeValues: {
                      ":expected": { S: conditions[index]! },
                    },
                  };
            return write.record === null
              ? {
                  Delete: {
                    TableName: tableName,
                    Key: keyFor(write.table, write.id),
                    ...condition,
                  },
                }
              : {
                  Put: {
                    TableName: tableName,
                    Item: itemFor(write.table, write.record),
                    ...condition,
                  },
                };
          }),
        }),
      );
    } catch (error) {
      const reasons = isRecord(error) ? error.CancellationReasons : undefined;
      if (
        Array.isArray(reasons) &&
        reasons.some(
          (reason: unknown) =>
            isRecord(reason) && reason.Code === "ConditionalCheckFailed",
        )
      )
        throw databaseConflict();
      throw error;
    }
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

  async page(table: string, options: DatabasePageOptions = {}) {
    const limit = databasePageLimit(options);
    const response = await this.options.client.send(
      new QueryCommand({
        TableName: this.requireTableName(),
        ConsistentRead: true,
        Limit: limit,
        KeyConditionExpression:
          options.cursor === undefined
            ? "pk = :pk"
            : "pk = :pk AND sk > :cursor",
        ExpressionAttributeValues: {
          ":pk": { S: table },
          ...(options.cursor === undefined
            ? {}
            : { ":cursor": { S: options.cursor } }),
        },
      }),
    );
    const records = (response.Items ?? []).map(recordFromItem);
    return {
      records,
      cursor: response.LastEvaluatedKey
        ? stringAttribute(response.LastEvaluatedKey.sk)
        : null,
    };
  }

  async get(table: string, id: string): Promise<DatabaseRecord | null> {
    const response = await this.options.client.send(
      new GetItemCommand({
        TableName: this.requireTableName(),
        Key: keyFor(table, id),
        ConsistentRead: true,
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
        { env: "MEZAIR_CELL_DATA_TABLE" },
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

  async page(options: DatabasePageOptions = {}) {
    return this.adapter.page(this.name, options);
  }

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
        ServerSideEncryption: "AES256",
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
        { env: "MEZAIR_FILES_BUCKET" },
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

export class AwsOidcAuthAdapter implements AuthAdapter {
  private readonly verifier: TokenVerifier | undefined;

  constructor(env: Record<string, string | undefined>) {
    const issuer = env.MEZAIR_AUTH_ISSUER;

    if (!issuer) {
      return;
    }

    const options: OidcVerifierOptions = { issuer };

    if (env.MEZAIR_AUTH_AUDIENCE) {
      options.audience = env.MEZAIR_AUTH_AUDIENCE;
    }

    if (env.MEZAIR_AUTH_JWKS_URI) {
      options.jwksUri = env.MEZAIR_AUTH_JWKS_URI;
    }

    const claims: ClaimsMapping = {};

    if (env.MEZAIR_AUTH_USER_ID_CLAIM) {
      claims.userId = env.MEZAIR_AUTH_USER_ID_CLAIM;
    }

    if (env.MEZAIR_AUTH_EMAIL_CLAIM) {
      claims.email = env.MEZAIR_AUTH_EMAIL_CLAIM;
    }

    if (env.MEZAIR_AUTH_ROLES_CLAIM) {
      claims.roles = env.MEZAIR_AUTH_ROLES_CLAIM;
    }

    if (Object.keys(claims).length > 0) {
      options.claims = claims;
    }

    this.verifier = new OidcTokenVerifier(options);
  }

  get configured(): boolean {
    return this.verifier !== undefined;
  }

  async current(): Promise<AuthIdentity | null> {
    return null;
  }

  async verifyToken(token: string): Promise<AuthIdentity | null> {
    if (!this.verifier) {
      return null;
    }

    const verified = await this.verifier.verifyToken(token);

    return verified.identity;
  }
}

class AwsLogAdapter implements LogAdapter {
  constructor(private readonly logger: AwsRuntimeLogger) {}

  async write(entry: LogEntry): Promise<void> {
    this.logger[entry.level](JSON.stringify(entry));
  }
}

export class AwsEventBridgeEventAdapter implements EventAdapter {
  constructor(
    private readonly options: {
      client: EventBridgeSender;
      eventBusName: string;
      source: string;
    },
  ) {}

  async publish(name: string, payload: unknown): Promise<void> {
    const result = await this.options.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.options.eventBusName,
            Source: this.options.source,
            DetailType: name,
            Detail: JSON.stringify(payload ?? null),
          },
        ],
      }),
    );

    if ((result.FailedEntryCount ?? 0) > 0) {
      const failure = result.Entries?.find((entry) => entry.ErrorCode);

      throw new RuntimeError(
        "ADAPTER_ERROR",
        `Event publish failed: ${failure?.ErrorCode ?? "unknown"} ${failure?.ErrorMessage ?? ""}`.trim(),
        502,
        {
          name,
          errorCode: failure?.ErrorCode ?? "unknown",
          errorMessage: failure?.ErrorMessage ?? "",
        },
      );
    }
  }
}

class UnconfiguredAwsEventAdapter implements EventAdapter {
  async publish(name: string, payload: unknown): Promise<void> {
    void name;
    void payload;
    throw new RuntimeError(
      "CAPABILITY_NOT_DECLARED",
      "Event capability is not configured for this AWS runtime.",
      403,
      { env: "MEZAIR_EVENT_BUS_NAME" },
    );
  }
}

class AwsStepFunctionsWorkflowAdapter implements WorkflowAdapter {
  constructor(
    private readonly options: {
      client: StepFunctionsSender;
      stateMachines: Record<string, string>;
    },
  ) {}

  async start(name: string, input: unknown): Promise<{ runId: string }> {
    const stateMachineArn = this.options.stateMachines[name];

    if (!stateMachineArn) {
      throw new RuntimeError(
        "CAPABILITY_NOT_DECLARED",
        `Workflow '${name}' is not configured for this AWS runtime.`,
        403,
        {
          env: "MEZAIR_WORKFLOW_STATE_MACHINES",
          workflow: name,
        },
      );
    }

    const runId = `run_${randomUUID()}`;
    await this.options.client.send(
      new StartExecutionCommand({
        stateMachineArn,
        name: runId,
        input: JSON.stringify({
          runId,
          input,
          steps: {},
        }),
      }),
    );

    return {
      runId,
    };
  }
}

function parseWorkflowStateMachines(
  raw: string | undefined,
): Record<string, string> {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!isRecordOfStrings(parsed)) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

class AwsSqsJobAdapter implements JobAdapter {
  constructor(
    private readonly options: {
      client: SqsSender;
      queueUrl: string | undefined;
    },
  ) {}

  async enqueue(
    name: string,
    payload: unknown,
    options?: { id: string },
  ): Promise<{ id: string }> {
    const response = await this.options.client.send(
      new SendMessageCommand({
        QueueUrl: this.requireQueueUrl(),
        MessageBody: JSON.stringify({
          ...(options ? { id: options.id } : {}),
          name,
          payload,
        }),
      }),
    );

    return {
      id:
        options?.id ??
        (typeof response.MessageId === "string"
          ? response.MessageId
          : `job_${randomUUID()}`),
    };
  }

  private requireQueueUrl(): string {
    if (!this.options.queueUrl) {
      throw new RuntimeError(
        "CAPABILITY_NOT_DECLARED",
        "Job capability is not configured for this AWS runtime.",
        403,
        { env: "MEZAIR_JOB_QUEUE_URL" },
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

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return (
    isObject(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
