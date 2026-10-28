import { describe, expect, it } from "vitest";

import {
  app,
  createInMemoryRuntimeHost,
  endpoint,
  mutation,
  job,
  query,
} from "@mezair-cloud/runtime";
import {
  cloudflareRequestToRuntimeRequest,
  createCloudflareWorkerHandler,
} from "../src/index.js";

const cell = app({
  queries: {
    ping: query<{ value: string }>({
      auth: "public",
      handler: async (_ctx, input) => ({ pong: input.value }),
    }),
  },
  mutations: {
    echo: mutation<{ value: string }>({
      auth: "public",
      handler: async (_ctx, input) => input,
    }),
  },
  endpoints: {
    status: endpoint({
      method: "GET",
      path: "/api/status",
      auth: "none",
      handler: async () => ({ ok: true }),
    }),
    binary: endpoint({
      method: "GET",
      path: "/api/binary",
      auth: "none",
      handler: async () =>
        new Response(new Uint8Array([0, 1, 2, 255]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    }),
  },
});

const context = {
  waitUntil() {},
};

describe("Cloudflare Worker HTTP bridge", () => {
  it("translates query requests without accepting body identity", async () => {
    const request = await cloudflareRequestToRuntimeRequest(
      new Request("https://cell.example/_mezair/query/ping", {
        method: "POST",
        body: JSON.stringify({
          input: { value: "hello" },
          auth: { userId: "smuggled" },
        }),
      }),
      "request_1",
    );

    expect(request).toEqual({
      kind: "query",
      name: "ping",
      input: { value: "hello" },
      auth: null,
      requestId: "request_1",
    });
  });

  it("serves health, queries, endpoints, and asset fallback", async () => {
    const handler = createCloudflareWorkerHandler(cell, {
      createHost: () => createInMemoryRuntimeHost(),
    });
    const env = {
      MEZAIR_ASSETS: {
        fetch: async () => new Response("asset", { status: 200 }),
      },
    };

    const health = await handler.fetch(
      new Request("https://cell.example/_mezair/health"),
      env,
      context,
    );
    expect(await health.json()).toEqual({
      ok: true,
      runtime: "cloudflare-preview",
    });

    const queryResponse = await handler.fetch(
      new Request("https://cell.example/_mezair/query/ping", {
        method: "POST",
        body: JSON.stringify({ input: { value: "hello" } }),
      }),
      env,
      context,
    );
    expect(await queryResponse.json()).toEqual({
      ok: true,
      result: { pong: "hello" },
    });
    expect(queryResponse.headers.get("x-mezair-request-id")).toBeTruthy();

    const mutationResponse = await handler.fetch(
      new Request("https://cell.example/_mezair/mutation/echo", {
        method: "POST",
        body: JSON.stringify({ input: { value: "changed" } }),
      }),
      env,
      context,
    );
    expect(await mutationResponse.json()).toEqual({
      ok: true,
      result: { value: "changed" },
    });

    const endpointResponse = await handler.fetch(
      new Request("https://cell.example/api/status"),
      env,
      context,
    );
    expect(await endpointResponse.json()).toEqual({
      ok: true,
      result: { ok: true },
    });

    const assetResponse = await handler.fetch(
      new Request("https://cell.example/index.html"),
      env,
      context,
    );
    expect(await assetResponse.text()).toBe("asset");

    const binaryResponse = await handler.fetch(
      new Request("https://cell.example/api/binary"),
      env,
      context,
    );
    expect(binaryResponse.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Uint8Array(await binaryResponse.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2, 255]),
    );
  });

  it("answers CORS preflight without invoking the Cell", async () => {
    const handler = createCloudflareWorkerHandler(cell, {
      createHost: () => createInMemoryRuntimeHost(),
    });
    const response = await handler.fetch(
      new Request("https://cell.example/api/status", { method: "OPTIONS" }),
      {},
      context,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
  });

  it("returns stable JSON for malformed query input", async () => {
    const handler = createCloudflareWorkerHandler(cell, {
      createHost: () => createInMemoryRuntimeHost(),
    });
    const response = await handler.fetch(
      new Request("https://cell.example/_mezair/query/ping", {
        method: "POST",
        body: "{",
      }),
      {},
      context,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "INVALID_JSON" },
    });
  });
});

it("uses verified bearer identity and rejects invalid credentials and oversized bodies", async () => {
  const host = createInMemoryRuntimeHost();
  host.auth.verifyToken = async (token) => {
    if (token !== "valid") throw new Error("invalid");
    return { userId: "verified" };
  };
  const secured = app({
    queries: {
      me: query({ auth: "required", handler: async (ctx) => ctx.auth.userId }),
    },
  });
  const handler = createCloudflareWorkerHandler(secured, {
    createHost: () => host,
  });
  const call = (token: string, body = "{}") =>
    handler.fetch(
      new Request("https://cell.example/_mezair/query/me", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body,
      }),
      {},
      context,
    );
  expect(
    await (
      await call("valid", JSON.stringify({ auth: { userId: "forged" } }))
    ).json(),
  ).toMatchObject({ result: "verified" });
  expect((await call("invalid")).status).toBe(401);
  expect((await call("valid", "x".repeat(1024 * 1024 + 1))).status).toBe(413);
});

it("acknowledges successful jobs, retries failures independently and queues matching cron jobs", async () => {
  const host = createInMemoryRuntimeHost();
  const cell = app({
    jobs: {
      refresh: job<{ fail?: boolean }>({
        schedule: "*/20 * * * *",
        handler: async (_ctx, payload) => {
          if (payload.fail) throw new Error("try again");
        },
      }),
    },
  });
  const handler = createCloudflareWorkerHandler(cell, {
    createHost: () => host,
  });
  const calls: string[] = [];
  const messages = [false, true].map((fail, i) => ({
    id: String(i),
    timestamp: new Date(),
    attempts: 1,
    body: {
      kind: "job",
      id: `logical-${i}`,
      name: "refresh",
      payload: { fail },
    },
    ack: () => {
      calls.push(`ack:${i}`);
    },
    retry: () => {
      calls.push(`retry:${i}`);
    },
  }));
  await handler.queue(
    { queue: "jobs", messages, ackAll() {}, retryAll() {} },
    {},
    context,
  );
  expect(calls).toEqual(["ack:0", "retry:1"]);
  await handler.scheduled(
    { cron: "*/20 * * * *", scheduledTime: 1234, noRetry() {} },
    {},
    context,
  );
  expect(host.jobs.entries).toEqual([
    { id: "refresh:1234", name: "refresh", payload: {} },
  ]);
});
