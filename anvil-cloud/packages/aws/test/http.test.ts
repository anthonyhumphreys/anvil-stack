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
    const handler = createAwsRuntimeHandler(cell, host);

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
        "content-type": "application/json",
      },
      isBase64Encoded: false,
    });
    expect(JSON.parse(response.body)).toEqual({
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });
  });
});
