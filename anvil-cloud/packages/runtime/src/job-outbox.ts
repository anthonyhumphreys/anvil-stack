import { databaseRecordJson } from "./database-commit.js";
import { RuntimeError } from "./errors.js";
import type { DatabaseRecord, DatabaseWrite, RuntimeHost } from "./host.js";

export const JOB_OUTBOX_TABLE = "__anvil_job_outbox";

/** Include this write in ctx.commit alongside the records that require the job. */
export function jobOutboxWrite(input: {
  id: string;
  name: string;
  payload: unknown;
}): DatabaseWrite {
  if (
    typeof input.id !== "string" ||
    !input.id ||
    typeof input.name !== "string" ||
    !input.name
  )
    throw new RuntimeError(
      "VALIDATION_ERROR",
      "An outbox job needs an id and a handler name.",
      400,
    );
  if (new TextEncoder().encode(databaseRecordJson(input)).length > 64 * 1024) {
    throw new RuntimeError(
      "VALIDATION_ERROR",
      "Outbox job messages cannot exceed 64 KiB. Store large input in files and send its key.",
      400,
    );
  }
  return {
    table: JOB_OUTBOX_TABLE,
    id: input.id,
    expected: null,
    record: { ...input, state: "pending", attempts: 0, leaseUntil: 0 },
  };
}

export type JobOutboxDispatchOptions = {
  cursor?: string;
  limit?: number;
  now?: number;
  leaseMs?: number;
  maxAttempts?: number;
};

/** One bounded recovery pass. Invoke periodically and keep the returned cursor for the next pass. */
export async function dispatchJobOutbox(
  host: RuntimeHost,
  options: JobOutboxDispatchOptions = {},
): Promise<{ cursor: string | null; published: number; failed: number }> {
  if (!host.db.commit)
    throw new RuntimeError(
      "ADAPTER_ERROR",
      "Job outbox requires conditional database commits.",
      501,
    );
  const leaseMs = options.leaseMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 5;
  if (
    !Number.isFinite(leaseMs) ||
    leaseMs < 1000 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 100
  ) {
    throw new RuntimeError(
      "VALIDATION_ERROR",
      "Outbox lease must be at least 1000 ms and attempts must be 1 to 100.",
      400,
    );
  }
  const page = await host.db.table(JOB_OUTBOX_TABLE).page({
    limit: options.limit ?? 25,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
  let published = 0;
  let failed = 0;
  for (const record of page.records) {
    const now = options.now ?? Date.now();
    if (record.state === "failed" || Number(record.leaseUntil) > now) continue;
    const id = String(record.id);
    if (Number(record.attempts) >= maxAttempts) {
      try {
        await host.db.commit([
          {
            table: JOB_OUTBOX_TABLE,
            id,
            expected: record,
            record: { ...record, state: "failed" },
          },
        ]);
        failed += 1;
      } catch (error) {
        if (!(error instanceof RuntimeError && error.code === "CONFLICT"))
          throw error;
      }
      continue;
    }
    const claimed: DatabaseRecord = {
      ...record,
      state: "publishing",
      attempts: Number(record.attempts) + 1,
      leaseUntil: now + leaseMs,
      token: crypto.randomUUID(),
    };
    try {
      await host.db.commit([
        { table: JOB_OUTBOX_TABLE, id, expected: record, record: claimed },
      ]);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "CONFLICT") continue;
      throw error;
    }
    try {
      await host.jobs.enqueue(String(claimed.name), claimed.payload, { id });
      await host.db.commit([
        { table: JOB_OUTBOX_TABLE, id, expected: claimed, record: null },
      ]);
      published += 1;
    } catch {
      // A publish may have succeeded. Retries deliberately retain the same logical job id.
      const exhausted = Number(claimed.attempts) >= maxAttempts;
      try {
        await host.db.commit([
          {
            table: JOB_OUTBOX_TABLE,
            id,
            expected: claimed,
            record: { ...claimed, state: exhausted ? "failed" : "pending" },
          },
        ]);
      } catch (error) {
        if (!(error instanceof RuntimeError && error.code === "CONFLICT"))
          throw error;
      }
      failed += 1;
    }
  }
  return { cursor: page.cursor, published, failed };
}
