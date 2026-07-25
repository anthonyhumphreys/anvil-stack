import {
  app,
  boolean,
  endpoint,
  job,
  mutation,
  query,
  table,
  text,
  userId,
  workflow,
} from "@anvil-cloud/runtime";

export type Note = {
  id?: string;
  title: string;
  body: string;
  archived: boolean;
  ownerId: string;
};

export default app({
  schema: {
    notes: table({
      title: text().min(1).max(120),
      body: text().max(2000).optional(),
      archived: boolean().default(false),
      ownerId: userId(),
    }),
  },
  capabilities: {
    database: true,
    jobs: true,
    workflows: true,
  },
  queries: {
    status: query({
      auth: "public",
      handler: async (ctx) => {
        await ctx.log.info("Notes status requested");

        return {
          ok: true,
          cell: "notes",
          requestId: ctx.request.id,
        };
      },
    }),
    listNotes: query<unknown, Note[]>({
      auth: "required",
      handler: async (ctx) => {
        const ownerId = ctx.auth.requireUser();
        const rows = await ctx.db.notes.where("ownerId", "=", ownerId).all();

        return rows
          .filter((row) => row.archived !== true)
          .map(toNote)
          .reverse();
      },
    }),
  },
  mutations: {
    createNote: mutation<{ title: string; body?: string }, Note>({
      auth: "required",
      handler: async (ctx, input) => {
        const title = input.title.trim();

        if (!title) {
          throw new Error("Note title is required.");
        }

        const ownerId = ctx.auth.requireUser();
        const note = toNote(
          await ctx.db.notes.insert({
            title,
            body: input.body?.trim() ?? "",
            archived: false,
            ownerId,
          }),
        );

        await ctx.jobs.enqueue("summarizeNote", {
          noteId: note.id,
          title: note.title,
        });
        await ctx.log.info("Note created", {
          noteId: note.id ?? "unknown",
        });

        return note;
      },
    }),
    archiveNote: mutation<{ noteId: string }, { archived: boolean }>({
      auth: "required",
      handler: async (ctx, input) => {
        const existing = await ctx.db.notes.get(input.noteId);

        if (!existing || existing.ownerId !== ctx.auth.requireUser()) {
          return { archived: false };
        }

        await ctx.db.notes.update(input.noteId, {
          archived: true,
        });
        await ctx.log.info("Note archived", {
          noteId: input.noteId,
        });

        return { archived: true };
      },
    }),
  },
  endpoints: {
    health: endpoint({
      method: "GET",
      path: "/api/health",
      auth: "none",
      handler: async () => ({
        ok: true,
        cell: "notes",
      }),
    }),
  },
  jobs: {
    summarizeNote: job<{ noteId?: string; title?: string }>({
      handler: async (ctx, payload) => {
        await ctx.log.info("Summarize note job received", {
          noteId: payload.noteId ?? "unknown",
          title: payload.title ?? "",
        });

        return {
          summarized: true,
          noteId: payload.noteId ?? null,
        };
      },
    }),
  },
  workflows: {
    onboardUser: workflow({
      steps: [
        {
          name: "seedWelcomeNote",
          handler: async (ctx, state) => {
            const input =
              typeof state.input === "object" && state.input !== null
                ? (state.input as { userId?: unknown })
                : {};
            const ownerId =
              typeof input.userId === "string" && input.userId.length > 0
                ? input.userId
                : "workflow";

            return ctx.db.notes.insert({
              title: "Welcome to Anvil Notes",
              body: "This note was created by a local workflow.",
              archived: false,
              ownerId,
            });
          },
        },
      ],
    }),
  },
});

function toNote(record: Record<string, unknown>): Note {
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    title: typeof record.title === "string" ? record.title : "",
    body: typeof record.body === "string" ? record.body : "",
    archived: record.archived === true,
    ownerId: typeof record.ownerId === "string" ? record.ownerId : "",
  };
}
