import {
  app,
  endpoint,
  job,
  jobOutboxWrite,
  query,
  RuntimeError,
  table,
  text,
  type DatabaseWrite,
  type EndpointRuntimeRequest,
  type RuntimeContext,
} from "@mezair-cloud/runtime";

type ImportInput = {
  batchId: string;
  source: string;
  expectedQuota: Record<string, unknown> | null;
};

type CatalogueRow = {
  id: string;
  name: string;
};

type BatchMessage = {
  batchId: string;
  batchRecordId: string;
  sourceKey: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default app({
  schema: {
    quotas: table({
      used: text(),
    }),
    batches: table({
      ownerId: text(),
      sourceKey: text(),
      state: text(),
      importedCount: text().optional(),
      failureCode: text().optional(),
    }),
    catalogue: table({
      batchId: text(),
      ownerId: text(),
      name: text(),
    }),
    receipts: table({
      batchId: text(),
      importedCount: text(),
    }),
  },
  capabilities: {
    database: true,
    files: { publicRead: false },
    jobs: true,
    scheduledJobs: true,
  },
  queries: {
    quota: query({
      auth: "required",
      handler: async (ctx) => {
        const userId = ctx.auth.requireUser();

        return ctx.db.quotas!.get(userId);
      },
    }),
    batch: query<{ batchId: string }>({
      auth: "required",
      handler: async (ctx, input) => {
        const userId = ctx.auth.requireUser();
        const recordId = batchRecordId(userId, input.batchId);
        const record = await ctx.db.batches!.get(recordId);

        return record?.ownerId === userId ? record : null;
      },
    }),
    catalogue: query({
      auth: "required",
      handler: async (ctx) => {
        const ownerId = ctx.auth.requireUser();

        return ctx.db.catalogue!.where("ownerId", "=", ownerId).all();
      },
    }),
  },
  endpoints: {
    importCatalogue: endpoint({
      method: "POST",
      path: "/api/catalogue/import",
      auth: "required",
      handler: async (ctx, request) => {
        const input = readJsonBody<ImportInput>(request);
        const result = await ctx.db.quotas!.get(ctx.auth.requireUser());
        const expectedQuota = normalizeExpectedQuota(
          ctx.auth.requireUser(),
          input.expectedQuota,
        );

        if (!sameRecord(result, expectedQuota)) {
          throw new RuntimeError(
            "CONFLICT",
            "Quota changed. Read it again before retrying.",
            409,
          );
        }

        const batch = await importCatalogue(ctx, input);

        return batch;
      },
    }),
    privateSource: endpoint({
      method: "GET",
      path: "/api/catalogue/source",
      auth: "required",
      handler: async (ctx, request) => {
        const ownerId = ctx.auth.requireUser();
        const batchId = request.headers["x-batch-id"];

        if (!batchId) {
          throw new RuntimeError(
            "VALIDATION_ERROR",
            "The x-batch-id header is required.",
            400,
          );
        }

        const batch = await ctx.db.batches!.get(
          batchRecordId(ownerId, batchId),
        );

        if (!batch || batch.ownerId !== ownerId) {
          throw new RuntimeError("NOT_FOUND", "Import batch not found.", 404);
        }

        const bytes = await ctx.files.get(String(batch.sourceKey));

        if (!bytes) {
          throw new RuntimeError("NOT_FOUND", "Source file not found.", 404);
        }

        return { source: decoder.decode(bytes) };
      },
    }),
  },
  jobs: {
    recoverPendingImports: job({
      schedule: "rate(1 day)",
      handler: async (ctx) => ctx.dispatchPendingJobs({ limit: 10 }),
    }),
    processCatalogueBatch: job<BatchMessage>({
      handler: async (ctx, message) => {
        const receipt = await ctx.db.receipts!.get(ctx.request.id);

        if (receipt) {
          return {
            duplicate: true,
            importedCount: Number(receipt.importedCount ?? 0),
          };
        }

        const batch = await ctx.db.batches!.get(message.batchRecordId);

        if (!batch || batch.sourceKey !== message.sourceKey) {
          throw new RuntimeError("NOT_FOUND", "Import batch not found.", 404);
        }

        const bytes = await ctx.files.get(message.sourceKey);

        if (!bytes) {
          return markPoisonedBatch(ctx, message, batch, "SOURCE_MISSING");
        }

        let rows: CatalogueRow[];

        try {
          rows = parseCatalogue(decoder.decode(bytes));
        } catch {
          return markPoisonedBatch(ctx, message, batch, "INVALID_SOURCE");
        }

        const writes: DatabaseWrite[] = rows.map((row) => ({
          table: "catalogue",
          id: `${message.batchRecordId}:${row.id}`,
          expected: null,
          record: {
            id: `${message.batchRecordId}:${row.id}`,
            batchId: message.batchId,
            ownerId: String(batch.ownerId),
            name: row.name,
          },
        }));
        writes.push({
          table: "receipts",
          id: ctx.request.id,
          expected: null,
          record: {
            id: ctx.request.id,
            batchId: message.batchId,
            importedCount: String(rows.length),
          },
        });
        writes.push({
          table: "batches",
          id: message.batchRecordId,
          expected: batch,
          record: {
            ...batch,
            state: "imported",
            importedCount: String(rows.length),
          },
        });

        try {
          await ctx.commit(writes);
        } catch (error) {
          if (error instanceof RuntimeError && error.code === "CONFLICT") {
            const completed = await ctx.db.receipts!.get(ctx.request.id);

            if (completed) {
              return {
                duplicate: true,
                importedCount: Number(completed.importedCount ?? 0),
              };
            }
          }

          throw error;
        }

        return { duplicate: false, importedCount: rows.length };
      },
    }),
  },
});

async function importCatalogue(ctx: RuntimeContext, input: ImportInput) {
  const ownerId = ctx.auth.requireUser();
  validateImportInput(input);
  const expectedQuota = normalizeExpectedQuota(ownerId, input.expectedQuota);
  const used = Number(expectedQuota?.used ?? 0);

  if (!Number.isSafeInteger(used) || used < 0 || used >= 5) {
    throw new RuntimeError(
      "VALIDATION_ERROR",
      "The import quota has been reached.",
      429,
    );
  }
  const recordId = batchRecordId(ownerId, input.batchId);
  const existing = await ctx.db.batches!.get(recordId);

  if (existing) {
    return { batchId: input.batchId, state: existing.state };
  }

  const sourceKey = `imports/${encodeURIComponent(ownerId)}/${encodeURIComponent(input.batchId)}/${crypto.randomUUID()}.json`;
  await ctx.files.put(sourceKey, encoder.encode(input.source));

  try {
    await ctx.commit([
      {
        table: "quotas",
        id: ownerId,
        expected: expectedQuota,
        record: { id: ownerId, used: String(used + 1) },
      },
      {
        table: "batches",
        id: recordId,
        expected: null,
        record: {
          id: recordId,
          batchId: input.batchId,
          ownerId,
          sourceKey,
          state: "queued",
        },
      },
      jobOutboxWrite({
        id: `catalogue:${recordId}`,
        name: "processCatalogueBatch",
        payload: {
          batchId: input.batchId,
          batchRecordId: recordId,
          sourceKey,
        } satisfies BatchMessage,
      }),
    ]);
  } catch (error) {
    await ctx.files.delete(sourceKey);
    throw error;
  }

  return { batchId: input.batchId, state: "queued" };
}

async function markPoisonedBatch(
  ctx: RuntimeContext,
  message: BatchMessage,
  batch: Record<string, unknown>,
  failureCode: string,
): Promise<never> {
  try {
    await ctx.commit([
      {
        table: "batches",
        id: message.batchRecordId,
        expected: batch,
        record: { ...batch, state: "failed", failureCode },
      },
    ]);
  } catch (error) {
    if (!(error instanceof RuntimeError && error.code === "CONFLICT")) {
      throw error;
    }
  }

  throw new RuntimeError(
    "VALIDATION_ERROR",
    `Catalogue batch failed with ${failureCode}.`,
    400,
  );
}

function validateImportInput(value: ImportInput): void {
  if (
    typeof value?.batchId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(value.batchId) ||
    typeof value.source !== "string" ||
    value.source.length === 0
  ) {
    throw new RuntimeError(
      "VALIDATION_ERROR",
      "batchId and source are required.",
      400,
    );
  }
}

function normalizeExpectedQuota(
  ownerId: string,
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    value.id !== ownerId ||
    typeof value.used !== "string" ||
    !Number.isSafeInteger(Number(value.used))
  ) {
    throw new RuntimeError(
      "VALIDATION_ERROR",
      "expectedQuota must be the quota record returned by the quota query, or null.",
      400,
    );
  }

  return value;
}

function sameRecord(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readJsonBody<T>(request: EndpointRuntimeRequest): T {
  try {
    const value: unknown = JSON.parse(
      decoder.decode(request.body ?? new Uint8Array()),
    );

    if (!value || typeof value !== "object") throw new Error("not an object");

    return value as T;
  } catch {
    throw new RuntimeError("VALIDATION_ERROR", "Expected a JSON object.", 400);
  }
}

function parseCatalogue(source: string): CatalogueRow[] {
  const value: unknown = JSON.parse(source);

  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error("Catalogue source must contain 1 to 20 rows.");
  }

  return value.map((row, index) => {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(row.id) ||
      typeof row.name !== "string" ||
      row.name.trim().length === 0
    ) {
      throw new Error(`Catalogue row ${index} is invalid.`);
    }

    return { id: row.id, name: row.name.trim() };
  });
}

function batchRecordId(ownerId: string, batchId: string): string {
  return `${ownerId}:${batchId}`;
}
