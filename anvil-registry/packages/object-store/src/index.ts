import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import type { AnvilConfig } from "@anvilstack/config";

export interface ObjectStore {
  healthCheck?(): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: Uint8Array): Promise<void>;
}

export class FileObjectStore implements ObjectStore {
  constructor(private readonly rootDir: string) {}

  async healthCheck(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(this.pathForKey(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const filePath = this.pathForKey(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
  }

  private pathForKey(key: string): string {
    const safeKey = key.replace(/^\/+/, "").replace(/\.\./g, "__");
    return path.join(this.rootDir, safeKey);
  }
}

export type S3ObjectStoreOptions = {
  bucket: string;
  endpoint?: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
};

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(private readonly options: S3ObjectStoreOptions) {
    const clientConfig: S3ClientConfig = {
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint)
    };

    if (options.accessKeyId && options.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
      };
    }

    this.client = new S3Client(clientConfig);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: normaliseObjectKey(key)
        })
      );

      if (!response.Body) return undefined;
      return await response.Body.transformToByteArray();
    } catch (error) {
      if (isMissingS3Object(error)) return undefined;
      throw error;
    }
  }

  async healthCheck(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: normaliseObjectKey(key),
        Body: body
      })
    );
  }
}

export function createObjectStore(config: AnvilConfig): ObjectStore {
  if (config.OBJECT_STORE_DRIVER === "s3") {
    return new S3ObjectStore({
      bucket: config.S3_BUCKET,
      endpoint: config.S3_ENDPOINT,
      region: config.AWS_REGION,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY
    });
  }

  return new FileObjectStore(`${config.CACHE_DIR}/objects`);
}

function normaliseObjectKey(key: string): string {
  return key.replace(/^\/+/, "").replace(/\.\./g, "__");
}

function isMissingS3Object(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "NoSuchKey" || error.name === "NotFound";
}
