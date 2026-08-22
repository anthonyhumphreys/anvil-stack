import { app, endpoint, query } from "@anvil-cloud/runtime";

export default app({
  queries: {
    ping: query<{ value: string }>({
      auth: "public",
      handler: async (ctx, input) => {
        await ctx.log.info("Cloudflare smoke query", {
          requestId: ctx.request.id,
        });

        return { pong: input.value };
      },
    }),
  },
  endpoints: {
    status: endpoint({
      method: "GET",
      path: "/api/status",
      auth: "none",
      handler: async () => ({ ok: true, cell: "cloudflare-smoke" }),
    }),
  },
});
