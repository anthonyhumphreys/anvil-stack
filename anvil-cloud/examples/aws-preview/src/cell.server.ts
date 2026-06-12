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
} from "@anvil-cloud/runtime";

const encoder = new TextEncoder();

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
    events: true,
    files: {
      publicRead: false,
    },
  },
  queries: {
    status: query({
      auth: "public",
      handler: async (ctx) => {
        await ctx.log.info("AWS preview status requested");

        return {
          ok: true,
          cell: "aws-preview",
          requestId: ctx.request.id,
        };
      },
    }),
    listNotes: query({
      handler: async (ctx) => {
        return ctx.db.notes.where("ownerId", "=", ctx.auth.requireUser()).all();
      },
    }),
  },
  mutations: {
    createNote: mutation<{ title: string; body?: string }>({
      handler: async (ctx, input) => {
        const ownerId = ctx.auth.requireUser();
        const note = await ctx.db.notes.insert({
          title: input.title,
          body: input.body ?? "",
          archived: false,
          ownerId,
        });

        await ctx.files.put(
          `notes/${String(note.id ?? "latest")}.json`,
          encoder.encode(JSON.stringify(note)),
        );
        await ctx.events.publish("note.created", {
          noteId: note.id,
          ownerId,
        });
        await ctx.jobs.enqueue("indexNote", {
          noteId: note.id,
        });

        return note;
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
        cell: "aws-preview",
      }),
    }),
  },
  jobs: {
    indexNote: job<{ noteId?: string }>({
      handler: async (ctx, payload) => {
        await ctx.log.info("Index note job received", {
          noteId: payload.noteId ?? "unknown",
        });

        return {
          indexed: true,
          noteId: payload.noteId ?? null,
        };
      },
    }),
  },
});
