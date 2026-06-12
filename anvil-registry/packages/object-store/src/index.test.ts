import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@anvilstack/config";
import { FileObjectStore, createObjectStore, S3ObjectStore } from "./index.js";

describe("FileObjectStore", () => {
  it("round-trips objects and sanitises traversal segments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "anvil-object-store-"));
    const store = new FileObjectStore(root);

    await store.put("../tarballs/pkg/1.0.0/test.tgz", new Uint8Array([1, 2, 3]));

    expect(Array.from((await store.get("../tarballs/pkg/1.0.0/test.tgz")) ?? [])).toEqual([1, 2, 3]);
    expect(await store.get("missing")).toBeUndefined();

    await rm(root, { recursive: true, force: true });
  });
});

describe("createObjectStore", () => {
  it("creates S3 stores when configured", () => {
    const store = createObjectStore(
      loadConfig({
        ...process.env,
        OBJECT_STORE_DRIVER: "s3",
        S3_BUCKET: "anvil-package-cache",
        S3_ENDPOINT: "http://localhost:9000",
        AWS_REGION: "us-east-1"
      })
    );

    expect(store).toBeInstanceOf(S3ObjectStore);
  });
});
