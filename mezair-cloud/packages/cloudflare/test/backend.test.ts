import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  CloudflareD1DatabaseAdapter,
  CLOUDFLARE_DATABASE_MIGRATION,
  CloudflareR2FileAdapter,
} from "../src/index.js";

const worker = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-08-01",
    d1Databases: ["MEZAIR_DB"],
    r2Buckets: ["MEZAIR_FILES"],
  }),
);
let database: CloudflareD1DatabaseAdapter;
beforeAll(async () => {
  const binding = await worker.getD1Database("MEZAIR_DB");
  await binding.exec(CLOUDFLARE_DATABASE_MIGRATION.replace(/\n/g, " "));
  database = new CloudflareD1DatabaseAdapter(binding);
});
afterAll(async () => worker.dispose());

describe("Cloudflare backend with real local bindings", () => {
  it("persists D1 records, paginates and rolls back all writes after a conflict", async () => {
    const table = database.table("items");
    await table.insert({ id: "a", count: 1 });
    await table.insert({ id: "b", count: 2 });
    await table.insert({ id: "c", count: 3 });
    expect(await table.page({ limit: 2 })).toEqual({
      records: [
        { id: "a", count: 1 },
        { id: "b", count: 2 },
      ],
      cursor: "b",
    });
    expect((await table.page({ cursor: "b", limit: 2 })).records).toEqual([
      { id: "c", count: 3 },
    ]);
    await database.commit([
      {
        table: "items",
        id: "a",
        expected: { count: 1, id: "a" },
        record: { id: "a", count: 2 },
      },
    ]);
    await expect(
      database.commit([
        { table: "other", id: "one", expected: null, record: { id: "one" } },
        {
          table: "items",
          id: "a",
          expected: { id: "a", count: 1 },
          record: null,
        },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await database.table("other").get("one")).toBeNull();
    expect(await table.get("a")).toEqual({ id: "a", count: 2 });
    expect(await table.update("a", { count: 4 })).toEqual({
      id: "a",
      count: 4,
    });
    expect(await table.where("count", ">", 2).count()).toBe(2);
    expect(await table.delete("a")).toBe(true);
    expect(await table.delete("a")).toBe(false);
  });

  it("allows one concurrent D1 claimant and the maximum portable commit size", async () => {
    const write = {
      table: "leases",
      id: "only",
      expected: null,
      record: { id: "only" },
    };
    const results = await Promise.allSettled([
      database.commit([write]),
      database.commit([write]),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    await database.commit(
      Array.from({ length: 25 }, (_, i) => ({
        table: "batch",
        id: String(i),
        expected: null,
        record: { id: String(i) },
      })),
    );
    expect(await database.table("batch").all()).toHaveLength(25);
  });

  it("stores and deletes private binary R2 files", async () => {
    const files = new CloudflareR2FileAdapter(
      await worker.getR2Bucket("MEZAIR_FILES"),
    );
    const body = new Uint8Array([0, 1, 255]);
    expect(await files.get("missing")).toBeNull();
    expect(await files.put("imports/batch", body)).toEqual({
      key: "imports/batch",
    });
    expect(await files.get("imports/batch")).toEqual(body);
    expect(await files.delete("imports/batch")).toBe(true);
    expect(await files.delete("imports/batch")).toBe(false);
  });
});
