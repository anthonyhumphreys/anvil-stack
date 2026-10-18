import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { JsonDatabaseAdapter } from "../src/index.js";

it("serializes writers from different local adapter instances and commits atomically", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "anvil-commit-"));
  try {
    const db = new JsonDatabaseAdapter(path.join(dir, "db.json"));
    const other = new JsonDatabaseAdapter(path.join(dir, "db.json"));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? db : other).table("items").insert({ id: String(i) }),
      ),
    );
    expect(await db.table("items").all()).toHaveLength(20);
    const outcomes = await Promise.allSettled(
      [db, other].map((adapter) =>
        adapter.commit([
          {
            table: "leases",
            id: "claim",
            expected: null,
            record: { id: "claim" },
          },
        ]),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    await expect(
      db.commit([
        { table: "items", id: "new", expected: null, record: { id: "new" } },
        {
          table: "leases",
          id: "claim",
          expected: null,
          record: { id: "claim" },
        },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await other.table("items").get("new")).toBeNull();
    expect(
      (await other.table("items").page({ limit: 3 })).records,
    ).toHaveLength(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
