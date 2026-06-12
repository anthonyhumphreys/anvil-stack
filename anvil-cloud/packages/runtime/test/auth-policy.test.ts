import { describe, expect, it } from "vitest";
import {
  app,
  createInMemoryRuntimeHost,
  endpoint,
  handleRuntimeRequest,
  mutation,
  query,
} from "../src/index.js";

const adminUser = { userId: "admin_1", roles: ["admin"] };
const plainUser = { userId: "user_1", roles: [] };

const cell = app({
  queries: {
    publicStats: query({
      auth: "public",
      handler: async () => ({ visitors: 42 }),
    }),
    myProfile: query({
      auth: "required",
      handler: async (ctx) => ({ userId: ctx.auth.requireUser() }),
    }),
  },
  mutations: {
    adminReset: mutation({
      auth: { roles: ["admin"] },
      handler: async () => ({ reset: true }),
    }),
  },
  endpoints: {
    securePing: endpoint({
      method: "GET",
      path: "/api/ping",
      handler: async () => ({ pong: true }),
    }),
    openPing: endpoint({
      method: "GET",
      path: "/api/open-ping",
      auth: "none",
      handler: async () => ({ pong: true }),
    }),
  },
});

describe("declarative auth enforcement", () => {
  it("allows public queries without identity", async () => {
    const response = await handleRuntimeRequest(
      cell,
      createInMemoryRuntimeHost(),
      {
        kind: "query",
        name: "publicStats",
        input: {},
        auth: null,
        requestId: "req_1",
      },
    );

    expect(response).toMatchObject({ ok: true, status: 200 });
  });

  it("rejects required queries without identity", async () => {
    const response = await handleRuntimeRequest(
      cell,
      createInMemoryRuntimeHost(),
      {
        kind: "query",
        name: "myProfile",
        input: {},
        auth: null,
        requestId: "req_2",
      },
    );

    expect(response).toMatchObject({ ok: false, status: 401 });
    expect(response.error).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("rejects role-gated mutations for users without the role", async () => {
    const response = await handleRuntimeRequest(
      cell,
      createInMemoryRuntimeHost(),
      {
        kind: "mutation",
        name: "adminReset",
        input: {},
        auth: plainUser,
        requestId: "req_3",
      },
    );

    expect(response).toMatchObject({ ok: false, status: 403 });
    expect(response.error).toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows role-gated mutations for users with the role", async () => {
    const response = await handleRuntimeRequest(
      cell,
      createInMemoryRuntimeHost(),
      {
        kind: "mutation",
        name: "adminReset",
        input: {},
        auth: adminUser,
        requestId: "req_4",
      },
    );

    expect(response).toMatchObject({ ok: true, status: 200 });
  });

  it("enforces the endpoint default of required auth", async () => {
    const response = await handleRuntimeRequest(
      cell,
      createInMemoryRuntimeHost(),
      {
        kind: "endpoint",
        method: "GET",
        path: "/api/ping",
        headers: {},
        body: null,
        auth: null,
        requestId: "req_5",
      },
    );

    expect(response).toMatchObject({ ok: false, status: 401 });
  });

  it("allows endpoints declared with auth none", async () => {
    const response = await handleRuntimeRequest(
      cell,
      createInMemoryRuntimeHost(),
      {
        kind: "endpoint",
        method: "GET",
        path: "/api/open-ping",
        headers: {},
        body: null,
        auth: null,
        requestId: "req_6",
      },
    );

    expect(response).toMatchObject({ ok: true, status: 200 });
  });
});
