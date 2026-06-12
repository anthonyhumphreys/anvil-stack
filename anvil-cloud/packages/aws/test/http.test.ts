import { describe, expect, it } from "vitest";

import {
  app,
  createInMemoryRuntimeHost,
  endpoint,
  mutation,
  query,
  table,
  text,
} from "@anvil-cloud/runtime";

import {
  awsHttpEventToRuntimeRequest,
  createAwsRuntimeHandler,
} from "../src/index.js";

describe("awsHttpEventToRuntimeRequest", () => {
  it("translates API Gateway v2 query events into runtime requests", () => {
    expect(
      awsHttpEventToRuntimeRequest({
        version: "2.0",
        rawPath: "/_anvil/query/listNotes",
        requestContext: {
          requestId: "aws_req_1",
          http: {
            method: "POST",
          },
        },
        body: JSON.stringify({
          input: { limit: 10 },
          auth: {
            userId: "user_1",
          },
        }),
      }),
    ).toEqual({
      kind: "query",
      name: "listNotes",
      input: { limit: 10 },
      auth: {
        userId: "user_1",
      },
      requestId: "aws_req_1",
    });
  });
});

describe("createAwsRuntimeHandler", () => {
  it("runs query and mutation requests through the shared runtime", async () => {
    const cell = app({
      schema: {
        notes: table({
          text: text().min(1),
        }),
      },
      capabilities: {
        database: true,
      },
      queries: {
        listNotes: query({
          handler: async (ctx) => {
            return ctx.db.notes
              .where("ownerId", "=", ctx.auth.requireUser())
              .all();
          },
        }),
      },
      mutations: {
        addNote: mutation<{ text: string }>({
          handler: async (ctx, input) => {
            return ctx.db.notes.insert({
              text: input.text,
              ownerId: ctx.auth.requireUser(),
            });
          },
        }),
      },
    });
    const host = createInMemoryRuntimeHost();
    const handler = createAwsRuntimeHandler(cell, host, {
      allowBodyIdentity: true,
    });

    const mutationResponse = await handler({
      rawPath: "/_anvil/mutation/addNote",
      requestContext: {
        requestId: "aws_mut_1",
        http: {
          method: "POST",
        },
      },
      body: JSON.stringify({
        input: {
          text: "AWS bridge",
        },
        auth: {
          userId: "aws_user",
        },
      }),
    });

    expect(mutationResponse).toMatchObject({
      statusCode: 200,
      headers: {
        "access-control-allow-origin": "*",
        "x-anvil-request-id": "aws_mut_1",
      },
      isBase64Encoded: false,
    });
    expect(JSON.parse(mutationResponse.body)).toMatchObject({
      ok: true,
      result: {
        text: "AWS bridge",
        ownerId: "aws_user",
      },
    });

    const queryResponse = await handler({
      rawPath: "/_anvil/query/listNotes",
      requestContext: {
        requestId: "aws_query_1",
        http: {
          method: "POST",
        },
      },
      body: JSON.stringify({
        input: {},
        auth: {
          userId: "aws_user",
        },
      }),
    });

    expect(JSON.parse(queryResponse.body)).toMatchObject({
      ok: true,
      result: [
        {
          text: "AWS bridge",
          ownerId: "aws_user",
        },
      ],
    });
  });

  it("runs declared HTTP endpoints through the shared runtime", async () => {
    const cell = app({
      endpoints: {
        webhook: endpoint({
          method: "POST",
          path: "/api/webhook",
          auth: "none",
          handler: async (_ctx, request) => {
            return Response.json(
              {
                method: request.method,
                body: request.body
                  ? Buffer.from(request.body).toString("utf8")
                  : null,
              },
              {
                status: 202,
              },
            );
          },
        }),
      },
    });
    const handler = createAwsRuntimeHandler(cell, createInMemoryRuntimeHost());
    const response = await handler({
      rawPath: "/api/webhook",
      requestContext: {
        requestId: "aws_endpoint_1",
        http: {
          method: "POST",
        },
      },
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ ok: true }),
    });

    expect(response).toMatchObject({
      statusCode: 202,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "application/json",
        "x-anvil-request-id": "aws_endpoint_1",
      },
      isBase64Encoded: false,
    });
    expect(JSON.parse(response.body)).toEqual({
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });
  });

  it("decodes base64 endpoint request bodies", async () => {
    const cell = app({
      endpoints: {
        upload: endpoint({
          method: "POST",
          path: "/api/upload",
          auth: "none",
          handler: async (_ctx, request) => {
            return Response.json({
              bytes: request.body ? Array.from(request.body) : [],
            });
          },
        }),
      },
    });
    const handler = createAwsRuntimeHandler(cell, createInMemoryRuntimeHost());
    const response = await handler({
      rawPath: "/api/upload",
      requestContext: {
        requestId: "aws_endpoint_upload",
        http: {
          method: "POST",
        },
      },
      body: Buffer.from(new Uint8Array([0, 255, 128])).toString("base64"),
      isBase64Encoded: true,
    });

    expect(response).toMatchObject({
      statusCode: 200,
      headers: {
        "x-anvil-request-id": "aws_endpoint_upload",
      },
      isBase64Encoded: false,
    });
    expect(JSON.parse(response.body)).toEqual({
      bytes: [0, 255, 128],
    });
  });

  it("returns binary endpoint responses as base64", async () => {
    const cell = app({
      endpoints: {
        download: endpoint({
          method: "GET",
          path: "/api/download",
          auth: "none",
          handler: async () => {
            return new Response(new Uint8Array([0, 255, 128]), {
              headers: {
                "content-type": "application/octet-stream",
              },
            });
          },
        }),
      },
    });
    const handler = createAwsRuntimeHandler(cell, createInMemoryRuntimeHost());
    const response = await handler({
      rawPath: "/api/download",
      requestContext: {
        requestId: "aws_endpoint_download",
        http: {
          method: "GET",
        },
      },
    });

    expect(response).toMatchObject({
      statusCode: 200,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "application/octet-stream",
        "x-anvil-request-id": "aws_endpoint_download",
      },
      body: Buffer.from(new Uint8Array([0, 255, 128])).toString("base64"),
      isBase64Encoded: true,
    });
  });

  it("responds to CORS preflight requests", async () => {
    const cell = app({});
    const handler = createAwsRuntimeHandler(cell, createInMemoryRuntimeHost());
    const response = await handler({
      rawPath: "/_anvil/query/listNotes",
      requestContext: {
        requestId: "aws_options_1",
        http: {
          method: "OPTIONS",
        },
      },
    });

    expect(response).toEqual({
      statusCode: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers":
          "authorization,content-type,x-anvil-request-id",
        "access-control-max-age": "600",
      },
      body: "",
      isBase64Encoded: false,
    });
  });

  it("returns a stable bad request response for malformed JSON runtime bodies", async () => {
    const cell = app({
      queries: {
        listNotes: query({
          handler: async () => [],
        }),
      },
    });
    const handler = createAwsRuntimeHandler(cell, createInMemoryRuntimeHost());
    const response = await handler({
      rawPath: "/_anvil/query/listNotes",
      requestContext: {
        requestId: "aws_bad_json",
        http: {
          method: "POST",
        },
      },
      headers: {
        "content-type": "application/json",
      },
      body: "{nope",
    });

    expect(response).toMatchObject({
      statusCode: 400,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "application/json",
        "x-anvil-request-id": "aws_bad_json",
      },
      isBase64Encoded: false,
    });
    expect(JSON.parse(response.body)).toEqual({
      ok: false,
      error: {
        code: "INVALID_JSON",
        message: "Request body must be valid JSON.",
      },
    });
  });

  it("responds to runtime health checks", async () => {
    const cell = app({});
    const handler = createAwsRuntimeHandler(cell, createInMemoryRuntimeHost());
    const response = await handler({
      rawPath: "/_anvil/health",
      requestContext: {
        requestId: "aws_health_1",
        http: {
          method: "GET",
        },
      },
    });

    expect(response).toMatchObject({
      statusCode: 200,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "application/json",
        "x-anvil-request-id": "aws_health_1",
      },
      isBase64Encoded: false,
    });
    expect(JSON.parse(response.body)).toEqual({
      ok: true,
      runtime: "aws-preview",
    });
  });

  it("ignores body-provided identity by default", async () => {
    const cell = app({
      capabilities: { database: true },
      schema: { notes: table({ text: text() }) },
      queries: {
        listNotes: query({
          handler: async (ctx) => {
            return ctx.db.notes
              .where("ownerId", "=", ctx.auth.requireUser())
              .all();
          },
        }),
      },
    });
    const handler = createAwsRuntimeHandler(cell, createInMemoryRuntimeHost());
    const response = await handler({
      rawPath: "/_anvil/query/listNotes",
      requestContext: { requestId: "aws_q", http: { method: "POST" } },
      body: JSON.stringify({ input: {}, auth: { userId: "smuggled_user" } }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers).toMatchObject({
      "access-control-allow-origin": "*",
      "x-anvil-request-id": "aws_q",
    });
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      error: { code: "AUTH_REQUIRED" },
    });
  });

  it("verifies bearer tokens through the host auth adapter", async () => {
    const cell = app({
      queries: {
        whoAmI: query({
          auth: "required",
          handler: async (ctx) => ({ userId: ctx.auth.requireUser() }),
        }),
      },
    });
    const host = createInMemoryRuntimeHost();

    host.auth.registerToken("good-token", { userId: "verified_user" });

    const handler = createAwsRuntimeHandler(cell, host);
    const response = await handler({
      rawPath: "/_anvil/query/whoAmI",
      requestContext: { requestId: "aws_q", http: { method: "POST" } },
      headers: { authorization: "Bearer good-token" },
      body: JSON.stringify({ input: {} }),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      result: { userId: "verified_user" },
    });
  });

  it("returns 401 when bearer token verification throws", async () => {
    const cell = app({
      queries: {
        whoAmI: query({
          handler: async (ctx) => ({ userId: ctx.auth.userId }),
        }),
      },
    });
    const host = createInMemoryRuntimeHost();
    const handler = createAwsRuntimeHandler(cell, host);
    const response = await handler({
      rawPath: "/_anvil/query/whoAmI",
      requestContext: { requestId: "aws_q", http: { method: "POST" } },
      headers: { authorization: "Bearer forged" },
      body: JSON.stringify({ input: {} }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers).toMatchObject({
      "x-anvil-request-id": "aws_q",
    });
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      error: { message: "Unknown test token 'forged'." },
    });
  });
});
