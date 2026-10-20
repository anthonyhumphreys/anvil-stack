import { describe, expect, it } from "vitest";
import {
  createInMemoryRuntimeHost,
  jobOutboxWrite,
  dispatchJobOutbox,
  createRuntimeContext,
  databaseRecordJson,
} from "../src/index.js";

describe("portable conditional commits", () => {
  it("applies records across tables together and rejects stale or absent expectations", async () => {
    const host = createInMemoryRuntimeHost();
    await host.db.commit([
      {
        table: "quota",
        id: "user",
        expected: null,
        record: { id: "user", used: 1 },
      },
      jobOutboxWrite({ id: "job1", name: "import", payload: {} }),
    ]);
    await expect(
      host.db.commit([
        {
          table: "quota",
          id: "user",
          expected: { id: "user", used: 0 },
          record: { id: "user", used: 2 },
        },
        {
          table: "imports",
          id: "batch",
          expected: null,
          record: { id: "batch" },
        },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(await host.db.table("imports").get("batch")).toBeNull();
    expect(await host.db.table("quota").get("user")).toEqual({
      id: "user",
      used: 1,
    });
  });

  it("allows only one concurrent claimant and preserves non-JSON and size limits", async () => {
    const host = createInMemoryRuntimeHost();
    const write = {
      table: "leases",
      id: "one",
      expected: null,
      record: { id: "one" },
    };
    const result = await Promise.allSettled([
      host.db.commit([write]),
      host.db.commit([write]),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const bad of [
      undefined,
      NaN,
      new Date(),
      BigInt(1),
      { value: undefined },
    ])
      expect(() => databaseRecordJson(bad)).toThrow("JSON values");
    expect(() => databaseRecordJson({ b: 2, a: [1] })).not.toThrow();
    await expect(
      host.db.commit([
        {
          ...write,
          id: "big",
          record: { id: "big", data: "x".repeat(256 * 1024) },
        },
      ]),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects commits from queries", async () => {
    const context = await createRuntimeContext(
      createInMemoryRuntimeHost(),
      { kind: "query", name: "read", input: {}, auth: null, requestId: "test" },
      "read",
    );
    await expect(
      context.commit([
        { table: "x", id: "x", expected: null, record: { id: "x" } },
      ]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("paginates without duplicates and rejects invalid page limits", async () => {
    const table = createInMemoryRuntimeHost().db.table("items");
    for (const id of ["c", "a", "b"]) await table.insert({ id });
    const first = await table.page({ limit: 2 });
    expect(first).toEqual({ records: [{ id: "a" }, { id: "b" }], cursor: "b" });
    expect(await table.page({ limit: 2, cursor: first.cursor! })).toEqual({
      records: [{ id: "c" }],
      cursor: null,
    });
    await expect(table.page({ limit: 101 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

it("orders Unicode ids consistently with provider storage", async () => {
  const table = createInMemoryRuntimeHost().db.table("unicode");
  for (const id of ["𐀀", "é", "a", ""]) await table.insert({ id });
  const page = await table.page({ limit: 3 });
  expect(page.records.map((record) => record.id)).toEqual(["a", "é", ""]);
  expect((await table.page({ cursor: page.cursor! })).records).toEqual([
    { id: "𐀀" },
  ]);
});

describe("durable job outbox", () => {
  it("lets a scheduled Cell job publish pending work without accessing a provider host", async () => {
    const host = createInMemoryRuntimeHost();
    await host.db.commit([
      jobOutboxWrite({ id: "portable", name: "refresh", payload: {} }),
    ]);
    const context = await createRuntimeContext(
      host,
      { kind: "job", name: "recover", payload: {}, requestId: "recovery" },
      "recover",
    );
    expect(await context.dispatchPendingJobs()).toMatchObject({ published: 1 });
    const read = await createRuntimeContext(
      host,
      {
        kind: "query",
        name: "read",
        input: {},
        auth: null,
        requestId: "query",
      },
      "read",
    );
    await expect(read.dispatchPendingJobs()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("claims once, recovers failed publications after the lease and retains the logical id", async () => {
    const host = createInMemoryRuntimeHost();
    await host.db.commit([
      jobOutboxWrite({
        id: "delivery1",
        name: "refresh",
        payload: { batch: 1 },
      }),
    ]);
    let attempts = 0;
    const enqueue = host.jobs.enqueue.bind(host.jobs);
    host.jobs.enqueue = async (...args) => {
      attempts++;
      if (attempts === 1) throw new Error("queue unavailable");
      return enqueue(...args);
    };
    expect(
      await dispatchJobOutbox(host, { now: 1000, leaseMs: 1000 }),
    ).toMatchObject({ failed: 1, published: 0 });
    expect(await dispatchJobOutbox(host, { now: 1500 })).toMatchObject({
      published: 0,
    });
    const results = await Promise.all([
      dispatchJobOutbox(host, { now: 2001 }),
      dispatchJobOutbox(host, { now: 2001 }),
    ]);
    expect(results.reduce((n, result) => n + result.published, 0)).toBe(1);
    expect(host.jobs.entries).toEqual([
      { id: "delivery1", name: "refresh", payload: { batch: 1 } },
    ]);
    expect(await host.db.table("__anvil_job_outbox").all()).toEqual([]);
  });

  it("rejects oversized job messages before a domain commit", () => {
    expect(() =>
      jobOutboxWrite({
        id: "large",
        name: "refresh",
        payload: "x".repeat(64 * 1024),
      }),
    ).toThrow("64 KiB");
  });

  it("retains a final expired claim after a worker crash without exceeding the attempt limit", async () => {
    const host = createInMemoryRuntimeHost();
    const write = jobOutboxWrite({
      id: "crashed",
      name: "refresh",
      payload: {},
    });
    await host.db.commit([
      {
        ...write,
        record: {
          ...write.record,
          state: "publishing",
          attempts: 5,
          leaseUntil: 10,
        },
      },
    ]);
    expect(await dispatchJobOutbox(host, { now: 11 })).toMatchObject({
      failed: 1,
      published: 0,
    });
    expect(host.jobs.entries).toHaveLength(0);
    expect(
      await host.db.table("__anvil_job_outbox").get("crashed"),
    ).toMatchObject({ state: "failed", attempts: 5 });
  });

  it("retains exhausted publications for inspection", async () => {
    const host = createInMemoryRuntimeHost();
    await host.db.commit([
      jobOutboxWrite({ id: "failed", name: "refresh", payload: {} }),
    ]);
    host.jobs.enqueue = async () => {
      throw new Error("secret-bearing provider detail");
    };
    await dispatchJobOutbox(host, { now: 1, maxAttempts: 1 });
    await dispatchJobOutbox(host, { now: 100000 });
    expect(
      await host.db.table("__anvil_job_outbox").get("failed"),
    ).toMatchObject({ state: "failed", attempts: 1 });
    expect(
      JSON.stringify(await host.db.table("__anvil_job_outbox").all()),
    ).not.toContain("secret-bearing");
  });
});
