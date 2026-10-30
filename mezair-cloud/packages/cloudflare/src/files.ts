import type { R2Bucket } from "@cloudflare/workers-types";
import type { FileAdapter } from "@mezair-cloud/runtime";

/** The bucket stays private. Applications authorize access before returning bytes. */
export class CloudflareR2FileAdapter implements FileAdapter {
  constructor(private readonly bucket: R2Bucket) {}

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }

  async put(key: string, body: Uint8Array): Promise<{ key: string }> {
    await this.bucket.put(key, body);
    return { key };
  }

  async delete(key: string): Promise<boolean> {
    if (!(await this.bucket.head(key))) return false;
    await this.bucket.delete(key);
    return true;
  }
}
