import {
  app,
  boolean,
  endpoint,
  job,
  mutation,
  query,
  service,
  table,
  text,
  userId,
  workflow,
} from "@anvil-cloud/runtime";

const seedTodos = [
  "Open Anvil Lens",
  "Create a local user",
  "Run the demo workflow",
];

export default app({
  schema: {
    todos: table({
      text: text().min(1).max(500),
      done: boolean().default(false),
      ownerId: userId(),
    }),
  },
  capabilities: {
    database: true,
    events: true,
    jobs: true,
    services: true,
    workflows: true,
  },
  queries: {
    status: query({
      auth: "public",
      handler: async () => ({
        message: "Lens demo cell is running",
        seededTodos: seedTodos.length,
      }),
    }),
    listTodos: query({
      handler: async (ctx) => {
        return ctx.db.todos.where("ownerId", "=", ctx.auth.requireUser()).all();
      },
    }),
  },
  mutations: {
    addTodo: mutation<{ text: string }>({
      handler: async (ctx, input) => {
        return ctx.db.todos.insert({
          text: input.text,
          done: false,
          ownerId: ctx.auth.requireUser(),
        });
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
        cell: "lens-demo",
      }),
    }),
  },
  jobs: {
    seedTodos: job({
      handler: async (ctx) => {
        const user = ctx.auth.identity?.userId ?? "local_demo";

        for (const text of seedTodos) {
          await ctx.db.todos.insert({
            text,
            done: false,
            ownerId: user,
          });
        }

        await ctx.log.info("Seeded demo todos", { count: seedTodos.length });

        return { count: seedTodos.length };
      },
    }),
  },
  workflows: {
    onboardUser: workflow({
      steps: [
        {
          name: "createWelcomeTodo",
          handler: async (ctx, state) => {
            const input = state.input as { userId?: string } | null;
            const ownerId = input?.userId ?? "local_demo";

            return ctx.db.todos.insert({
              text: "Review Lens tabs",
              done: false,
              ownerId,
            });
          },
        },
        {
          name: "publishEvent",
          handler: async (ctx, state) => {
            await ctx.events.publish("demo.onboarded", {
              todo: state.steps.createWelcomeTodo,
            });

            return { published: true };
          },
        },
      ],
    }),
  },
  services: {
    heartbeat: service({
      restart: "never",
      handler: async (ctx, controls) => {
        await ctx.log.info("Heartbeat service started");

        await new Promise<void>((resolve) => {
          if (controls.signal.aborted) {
            resolve();
            return;
          }

          controls.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      },
    }),
  },
});
