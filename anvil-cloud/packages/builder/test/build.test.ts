import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCell, checkCell } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("buildCell", () => {
  it("emits build artefacts, manifest, and generated client metadata", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, mutation, query, table, text, userId } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  schema: {",
        "    notes: table({ title: text().min(1), ownerId: userId() }),",
        "  },",
        "  capabilities: { database: true },",
        "  queries: {",
        "    listNotes: query({ handler: async () => [] }),",
        "  },",
        "  mutations: {",
        "    createNote: mutation({ handler: async () => ({ ok: true }) }),",
        "  },",
        "});",
        "",
      ].join("\n"),
      client: [
        'import { api } from "@anvil/generated/client";',
        "",
        "document.body.dataset.query = api.queries.listNotes.name;",
        "",
      ].join("\n"),
    });

    const result = await buildCell({ rootDir });

    expect(result.ok).toBe(true);
    expect(result.manifest).toMatchObject({
      schemaVersion: "0.1",
      cell: {
        name: "notes",
      },
      queries: ["listNotes"],
      mutations: ["createNote"],
      capabilities: {
        database: true,
      },
    });
    await expect(
      readText(path.join(rootDir, ".anvil/dist/server/index.mjs")),
    ).resolves.toContain("listNotes");
    await expect(
      readText(path.join(rootDir, ".anvil/generated/client.ts")),
    ).resolves.toContain("createNote");
    await expect(
      readText(path.join(rootDir, ".anvil/generated/client.ts")),
    ).resolves.toContain("export interface QueryTypes {}");
    await expect(
      readText(path.join(rootDir, ".anvil/generated/client.ts")),
    ).resolves.toContain(
      'import { createApiClient, createClient } from "@anvil-cloud/client";',
    );
    await expect(
      readText(path.join(rootDir, ".anvil/generated/client.ts")),
    ).resolves.toContain("export function createAnvilApiClient");
    await expect(
      readText(path.join(rootDir, ".anvil/generated/client.ts")),
    ).resolves.toContain(
      'listNotes: { kind: "query", name: "listNotes" } as TypedQuery<"listNotes">',
    );
    await expect(
      readText(path.join(rootDir, ".anvil/generated/client.ts")),
    ).resolves.toContain(
      [
        "  meta: {",
        '    schemaVersion: "0.1",',
        '    queries: ["listNotes"],',
        '    mutations: ["createNote"],',
        "    agents: [],",
        "  },",
      ].join("\n"),
    );
    await expect(
      readText(path.join(rootDir, ".anvil/dist/client/assets/cell.client.js")),
    ).resolves.toContain("listNotes");
  });

  it("builds a clean Cell whose client imports generated metadata", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  queries: {",
        "    listNotes: query({ handler: async () => [] }),",
        "  },",
        "});",
        "",
      ].join("\n"),
      client: [
        'import { api } from "@anvil/generated/client";',
        "",
        "document.body.dataset.query = api.queries.listNotes.name;",
        "",
      ].join("\n"),
    });
    await rm(path.join(rootDir, ".anvil"), { recursive: true, force: true });

    const result = await buildCell({ rootDir });

    expect(result.ok).toBe(true);
    await expect(
      readText(path.join(rootDir, ".anvil/generated/client.ts")),
    ).resolves.toContain("listNotes");
  });

  it("builds Expo Router client targets without emitting a Vite bundle", async () => {
    const rootDir = await createCell({
      clientKind: "expo-router",
      clientEntry: "app/index.tsx",
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  queries: {",
        "    listNotes: query({ handler: async () => [] }),",
        "  },",
        "});",
        "",
      ].join("\n"),
      client: [
        'import { createApiClient, createClient } from "@anvil-cloud/client";',
        'import { api } from "@anvil/generated/client";',
        "",
        "const client = createApiClient(createClient(), api);",
        "void client.queries.listNotes({});",
        "",
      ].join("\n"),
    });

    const result = await buildCell({ rootDir });

    expect(result.ok).toBe(true);
    expect(result.manifest).toMatchObject({
      client: {
        kind: "expo-router",
      },
      entrypoints: {
        client: "app/index.tsx",
      },
      queries: ["listNotes"],
    });
    await expect(
      readText(path.join(rootDir, ".anvil/generated/client.ts")),
    ).resolves.toContain("listNotes");
    await expect(
      fileExists(path.join(rootDir, ".anvil/dist/client/index.html")),
    ).resolves.toBe(false);
  });

  it("blocks public file access escalation compared with the previous build", async () => {
    const rootDir = await createCell({
      server: [
        'import { app } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: {",
        "    files: { publicRead: false },",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    await expect(buildCell({ rootDir })).resolves.toMatchObject({ ok: true });
    await writeFile(
      path.join(rootDir, "src/cell.server.ts"),
      [
        'import { app } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: {",
        "    files: { publicRead: true },",
        "  },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await buildCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "manifest",
      diagnostics: [
        {
          code: "PUBLIC_FILE_ACCESS_CHANGED",
          message:
            "capabilities.files.publicRead changed from false to true compared with the previous build.",
        },
      ],
    });
  });

  it("blocks destructive schema removals compared with the previous build", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, table, text } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  schema: {",
        "    notes: table({",
        "      title: text(),",
        "      body: text(),",
        "    }),",
        "  },",
        "  capabilities: { database: true },",
        "});",
        "",
      ].join("\n"),
    });

    await expect(buildCell({ rootDir })).resolves.toMatchObject({ ok: true });
    await writeFile(
      path.join(rootDir, "src/cell.server.ts"),
      [
        'import { app, table, text } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  schema: {",
        "    notes: table({",
        "      title: text(),",
        "    }),",
        "  },",
        "  capabilities: { database: true },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await buildCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "manifest",
      diagnostics: [
        {
          code: "DESTRUCTIVE_SCHEMA_CHANGE",
          message:
            "Schema field 'notes.body' was removed compared with the previous build.",
        },
      ],
    });
  });

  it("blocks destructive schema table removals compared with the previous build", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, table, text } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  schema: {",
        "    notes: table({ title: text() }),",
        "  },",
        "  capabilities: { database: true },",
        "});",
        "",
      ].join("\n"),
    });

    await expect(buildCell({ rootDir })).resolves.toMatchObject({ ok: true });
    await writeFile(
      path.join(rootDir, "src/cell.server.ts"),
      [
        'import { app } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  schema: {},",
        "  capabilities: { database: true },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await buildCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "manifest",
      diagnostics: [
        {
          code: "DESTRUCTIVE_SCHEMA_CHANGE",
          message:
            "Schema table 'notes' was removed compared with the previous build.",
        },
      ],
    });
  });

  it("blocks destructive schema type changes compared with the previous build", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, table, text } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  schema: {",
        "    notes: table({",
        "      title: text(),",
        "    }),",
        "  },",
        "  capabilities: { database: true },",
        "});",
        "",
      ].join("\n"),
    });

    await expect(buildCell({ rootDir })).resolves.toMatchObject({ ok: true });
    await writeFile(
      path.join(rootDir, "src/cell.server.ts"),
      [
        'import { app, boolean, table } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  schema: {",
        "    notes: table({",
        "      title: boolean(),",
        "    }),",
        "  },",
        "  capabilities: { database: true },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await buildCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "manifest",
      diagnostics: [
        {
          code: "DESTRUCTIVE_SCHEMA_CHANGE",
          message:
            "Schema field 'notes.title' changed type from 'text' to 'boolean'.",
        },
      ],
    });
  });

  it("reports forbidden imports before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { S3Client } from "@aws-sdk/client-s3";',
        'import { app } from "@anvil-cloud/runtime";',
        "",
        "void S3Client;",
        "export default app({});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "FORBIDDEN_IMPORT",
        },
      ],
    });
  });

  it("reports provider infrastructure imports before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { TerraformStack } from "cdktf";',
        'import * as aws from "@pulumi/aws";',
        'import { app } from "@anvil-cloud/runtime";',
        "",
        "void TerraformStack;",
        "void aws;",
        "export default app({});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "FORBIDDEN_IMPORT",
          message: "Import 'cdktf' is not allowed in Cell server code.",
          hint: "Terraform/CDKTF authoring belongs inside deployment adapters.",
        }),
        expect.objectContaining({
          code: "FORBIDDEN_IMPORT",
          message: "Import '@pulumi/aws' is not allowed in Cell server code.",
          hint: "Provider infrastructure belongs inside deployment adapters.",
        }),
      ]),
    });
  });

  it("reports file-system imports before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { readFile } from "node:fs/promises";',
        'import { createWriteStream } from "fs";',
        'import { app } from "@anvil-cloud/runtime";',
        "",
        "void readFile;",
        "void createWriteStream;",
        "export default app({});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "FORBIDDEN_IMPORT",
          message:
            "Import 'node:fs/promises' is not allowed in Cell server code.",
          hint: "Use ctx.files for Cell-owned file storage.",
        }),
        expect.objectContaining({
          code: "FORBIDDEN_IMPORT",
          message: "Import 'fs' is not allowed in Cell server code.",
          hint: "Use ctx.files for Cell-owned file storage.",
        }),
      ]),
    });
  });

  it("reports direct network client imports before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { request } from "node:https";',
        'import axios from "axios";',
        'import { app } from "@anvil-cloud/runtime";',
        "",
        "void request;",
        "void axios;",
        "export default app({});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "FORBIDDEN_NETWORK_IMPORT",
          message: "Import 'node:https' is not allowed in Cell server code.",
          hint: "Use global fetch with capabilities.outboundFetch so outbound domains stay declarative.",
        }),
        expect.objectContaining({
          code: "FORBIDDEN_NETWORK_IMPORT",
          message: "Import 'axios' is not allowed in Cell server code.",
          hint: "Use global fetch with capabilities.outboundFetch so outbound domains stay declarative.",
        }),
      ]),
    });
  });

  it("reports CommonJS require bypasses before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { createRequire } from "node:module";',
        'import { app } from "@anvil-cloud/runtime";',
        "",
        "const require = createRequire(import.meta.url);",
        'const fs = require("fs/promises");',
        'const s3 = require("@aws-sdk/client-s3");',
        'const https = require("https");',
        "",
        "void fs;",
        "void s3;",
        "void https;",
        "export default app({});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "CREATE_REQUIRE_FORBIDDEN",
          message: "createRequire() is not allowed in Cell server code.",
        }),
        expect.objectContaining({
          code: "FORBIDDEN_IMPORT",
          message: "Import 'fs/promises' is not allowed in Cell server code.",
          hint: "Use ctx.files for Cell-owned file storage.",
        }),
        expect.objectContaining({
          code: "FORBIDDEN_IMPORT",
          message:
            "Import '@aws-sdk/client-s3' is not allowed in Cell server code.",
          hint: "Use declared Anvil capabilities such as ctx.db or ctx.files.",
        }),
        expect.objectContaining({
          code: "FORBIDDEN_NETWORK_IMPORT",
          message: "Import 'https' is not allowed in Cell server code.",
          hint: "Use global fetch with capabilities.outboundFetch so outbound domains stay declarative.",
        }),
      ]),
    });
  });

  it("reports aliased process.env access before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "const runtimeProcess = globalThis.process;",
        "const { env: runtimeEnv } = runtimeProcess;",
        'const globalProcess = globalThis["process"];',
        "",
        "export default app({",
        "  queries: {",
        "    config: query({",
        "      handler: async () => ({",
        "        region: runtimeProcess.env.AWS_REGION,",
        "        token: runtimeEnv.API_TOKEN,",
        "        mode: globalProcess.env.NODE_ENV,",
        "      }),",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "DIRECT_PROCESS_ENV",
          message:
            "Direct process.env access is not allowed in Cell server code.",
        }),
      ]),
    });
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === "DIRECT_PROCESS_ENV",
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("reports undeclared runtime capabilities before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  queries: {",
        "    listNotes: query({",
        "      handler: async (ctx) => ctx.db.notes.all(),",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "CAPABILITY_NOT_DECLARED",
          message: "ctx.db requires capabilities.database to be declared.",
        },
      ],
    });
  });

  it("reports computed ctx capability access before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  queries: {",
        "    listNotes: query({",
        '      handler: async (ctx) => ctx["db"].notes.all(),',
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "CAPABILITY_NOT_DECLARED",
          message: "ctx.db requires capabilities.database to be declared.",
        },
      ],
    });
  });

  it("reports destructured ctx capability access before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  queries: {",
        "    listNotes: query({",
        "      handler: async (ctx) => {",
        "        const { db: database } = ctx;",
        "        return database.notes.all();",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "CAPABILITY_NOT_DECLARED",
          message: "ctx.db requires capabilities.database to be declared.",
        },
      ],
    });
  });

  it("reports dynamic ctx capability property access before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: { database: true },",
        "  queries: {",
        "    listNotes: query({",
        "      handler: async (ctx, input: { capability: string }) => {",
        "        const scoped = ctx[input.capability];",
        "        return scoped.notes.all();",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "CTX_PROPERTY_NOT_STATIC",
          message:
            "Context capability access must use a static property name in Cell server code.",
        },
      ],
    });
  });

  it("reports destructured handler context parameters before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  queries: {",
        "    listNotes: query({",
        "      handler: async ({ db: database }) => database.notes.all(),",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "CAPABILITY_NOT_DECLARED",
          message: "ctx.db requires capabilities.database to be declared.",
        },
      ],
    });
  });

  it("reports non-static ctx destructuring before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  queries: {",
        "    listNotes: query({",
        "      handler: async (ctx) => {",
        "        const { ...scoped } = ctx;",
        "        return scoped.db.notes.all();",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "CTX_BINDING_NOT_STATIC",
          message:
            "Context destructuring must use static named properties in Cell server code.",
        },
      ],
    });
  });

  it("accepts declared runtime capabilities", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, job, mutation, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: {",
        "    database: true,",
        "    files: { publicRead: false },",
        "    outboundFetch: { allow: ['api.example.test'] },",
        "    scheduledJobs: true,",
        "  },",
        "  queries: {",
        "    listNotes: query({",
        "      handler: async (ctx) => ctx.db.notes.all(),",
        "    }),",
        "  },",
        "  mutations: {",
        "    uploadNote: mutation({",
        "      handler: async (ctx) => {",
        "        await ctx.files.put('notes/1.txt', new Uint8Array());",
        "        await fetch('https://api.example.test/notes');",
        "        return { ok: true };",
        "      },",
        "    }),",
        "  },",
        "  jobs: {",
        "    refreshNotes: job({",
        "      schedule: 'rate(1 hour)',",
        "      handler: async () => ({ ok: true }),",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result.ok).toBe(true);
  });

  it("reports outbound fetch hosts outside the declared allow list", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, mutation } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: {",
        "    outboundFetch: { allow: ['api.example.test'] },",
        "  },",
        "  mutations: {",
        "    syncNote: mutation({",
        "      handler: async () => {",
        "        await fetch('https://billing.example.test/notes');",
        "        return { ok: true };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "OUTBOUND_FETCH_NOT_ALLOWED",
          message:
            "Fetch host 'billing.example.test' is not declared in capabilities.outboundFetch.allow.",
        },
      ],
    });
  });

  it("reports aliased outbound fetch without the outbound capability", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, mutation } from "@anvil-cloud/runtime";',
        "",
        "const runtimeFetch = fetch;",
        "const globalFetch = globalThis.fetch;",
        "const { fetch: destructuredFetch } = globalThis;",
        "",
        "export default app({",
        "  mutations: {",
        "    syncNote: mutation({",
        "      handler: async () => {",
        "        await runtimeFetch('https://api.example.test/notes');",
        "        await globalFetch('https://api.example.test/notes');",
        "        await destructuredFetch('https://api.example.test/notes');",
        "        return { ok: true };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "CAPABILITY_NOT_DECLARED",
          message:
            "Global fetch requires capabilities.outboundFetch to be declared.",
        }),
      ]),
    });
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === "CAPABILITY_NOT_DECLARED",
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("reports globalThis fetch hosts outside the declared allow list", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, mutation } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: {",
        "    outboundFetch: { allow: ['api.example.test'] },",
        "  },",
        "  mutations: {",
        "    syncNote: mutation({",
        "      handler: async () => {",
        "        await globalThis.fetch('https://billing.example.test/notes');",
        "        await globalThis['fetch']('https://billing.example.test/notes');",
        "        return { ok: true };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "OUTBOUND_FETCH_NOT_ALLOWED",
          message:
            "Fetch host 'billing.example.test' is not declared in capabilities.outboundFetch.allow.",
        }),
      ]),
    });
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === "OUTBOUND_FETCH_NOT_ALLOWED",
      ),
    ).toHaveLength(2);
  });

  it("reports outbound fetch URL objects outside the declared allow list", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, mutation } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: {",
        "    outboundFetch: { allow: ['api.example.test'] },",
        "  },",
        "  mutations: {",
        "    syncNote: mutation({",
        "      handler: async () => {",
        "        await fetch(new URL('https://billing.example.test/notes'));",
        "        return { ok: true };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "OUTBOUND_FETCH_NOT_ALLOWED",
          message:
            "Fetch host 'billing.example.test' is not declared in capabilities.outboundFetch.allow.",
        },
      ],
    });
  });

  it("reports outbound fetch targets that cannot be checked statically", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, mutation } from "@anvil-cloud/runtime";',
        "",
        "const target = 'https://api.example.test/notes';",
        "",
        "export default app({",
        "  capabilities: {",
        "    outboundFetch: { allow: ['api.example.test'] },",
        "  },",
        "  mutations: {",
        "    syncNote: mutation({",
        "      handler: async () => {",
        "        await fetch(target);",
        "        await fetch('/internal');",
        "        return { ok: true };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "OUTBOUND_FETCH_TARGET_NOT_STATIC",
          message:
            "Fetch target must be a static absolute http(s) URL in Cell server code.",
        }),
      ]),
    });
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === "OUTBOUND_FETCH_TARGET_NOT_STATIC",
      ),
    ).toHaveLength(2);
  });

  it("accepts outbound fetch hosts inside the declared allow list", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, mutation } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: {",
        "    outboundFetch: { allow: ['api.example.test'] },",
        "  },",
        "  mutations: {",
        "    syncNote: mutation({",
        "      handler: async () => {",
        "        await fetch('https://api.example.test/notes');",
        "        return { ok: true };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result.ok).toBe(true);
  });

  it("accepts aliased outbound fetch hosts inside the declared allow list", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, mutation } from "@anvil-cloud/runtime";',
        "",
        "const runtimeFetch = globalThis.fetch;",
        "",
        "export default app({",
        "  capabilities: {",
        "    outboundFetch: { allow: ['api.example.test'] },",
        "  },",
        "  mutations: {",
        "    syncNote: mutation({",
        "      handler: async () => {",
        "        await runtimeFetch('https://api.example.test/notes');",
        "        return { ok: true };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result.ok).toBe(true);
  });

  it("accepts outbound fetch URL objects inside the declared allow list", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, mutation } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: {",
        "    outboundFetch: { allow: ['api.example.test'] },",
        "  },",
        "  mutations: {",
        "    syncNote: mutation({",
        "      handler: async () => {",
        "        await fetch(new URL('https://api.example.test/notes'));",
        "        return { ok: true };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result.ok).toBe(true);
  });

  it("reports undeclared jobs capability before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, mutation } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  mutations: {",
        "    createNote: mutation({",
        "      handler: async (ctx) => {",
        "        await ctx.jobs.enqueue('summarizeNote', {});",
        "        return { ok: true };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "CAPABILITY_NOT_DECLARED",
          message: "ctx.jobs requires capabilities.jobs to be declared.",
        },
      ],
    });
  });

  it("accepts ctx.jobs with the jobs capability declared", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, mutation } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: { jobs: true },",
        "  mutations: {",
        "    createNote: mutation({",
        "      handler: async (ctx) => {",
        "        await ctx.jobs.enqueue('summarizeNote', {});",
        "        return { ok: true };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result.ok).toBe(true);
  });

  it("reports ctx.env reads without env declarations before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  queries: {",
        "    config: query({",
        "      handler: async (ctx) => ({",
        "        apiToken: ctx.env.require('API_TOKEN'),",
        "        region: ctx.env.get('AWS_REGION'),",
        "      }),",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "ENV_NOT_DECLARED",
          message:
            "ctx.env.require('API_TOKEN') requires 'API_TOKEN' to be declared in capabilities.env or capabilities.secrets.",
        }),
        expect.objectContaining({
          code: "ENV_NOT_DECLARED",
          message:
            "ctx.env.get('AWS_REGION') requires 'AWS_REGION' to be declared in capabilities.env or capabilities.secrets.",
        }),
      ]),
    });
  });

  it("reports computed ctx.env reads without env declarations before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  queries: {",
        "    config: query({",
        '      handler: async (ctx) => ctx["env"].require("API_TOKEN"),',
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "ENV_NOT_DECLARED",
          message:
            "ctx.env.require('API_TOKEN') requires 'API_TOKEN' to be declared in capabilities.env or capabilities.secrets.",
        },
      ],
    });
  });

  it("reports aliased ctx.env reads without env declarations before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  queries: {",
        "    config: query({",
        "      handler: async (ctx) => {",
        "        const envFromProperty = ctx.env;",
        "        const { env: envFromDestructure } = ctx;",
        "        return {",
        "          apiToken: envFromProperty.require('API_TOKEN'),",
        "          region: envFromDestructure.get('AWS_REGION'),",
        "        };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "ENV_NOT_DECLARED",
          message:
            "ctx.env.require('API_TOKEN') requires 'API_TOKEN' to be declared in capabilities.env or capabilities.secrets.",
        }),
        expect.objectContaining({
          code: "ENV_NOT_DECLARED",
          message:
            "ctx.env.get('AWS_REGION') requires 'AWS_REGION' to be declared in capabilities.env or capabilities.secrets.",
        }),
      ]),
    });
  });

  it("reports destructured handler context env parameters before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  queries: {",
        "    config: query({",
        "      handler: async ({ env }) => env.require('API_TOKEN'),",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "ENV_NOT_DECLARED",
          message:
            "ctx.env.require('API_TOKEN') requires 'API_TOKEN' to be declared in capabilities.env or capabilities.secrets.",
        },
      ],
    });
  });

  it("reports dynamic ctx.env names when declarations are static", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: { env: ['AWS_REGION'] },",
        "  queries: {",
        "    config: query({",
        "      handler: async (ctx, input: { name: string }) => ctx.env.get(input.name),",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "ENV_NAME_NOT_STATIC",
          message:
            "ctx.env names must be static string literals in Cell server code.",
        },
      ],
    });
  });

  it("reports dynamic ctx.env methods before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: { env: ['AWS_REGION'] },",
        "  queries: {",
        "    config: query({",
        "      handler: async (ctx, input: { method: 'get' | 'require' }) => ctx.env[input.method]('AWS_REGION'),",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "ENV_METHOD_NOT_STATIC",
          message:
            "ctx.env method access must use get or require statically in Cell server code.",
        },
      ],
    });
  });

  it("reports aliased dynamic ctx.env methods before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: { secrets: ['API_TOKEN'] },",
        "  queries: {",
        "    config: query({",
        "      handler: async (ctx, input: { method: 'get' | 'require' }) => {",
        "        const env = ctx.env;",
        "        const readEnv = env[input.method];",
        "        return readEnv('API_TOKEN');",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "ENV_METHOD_NOT_STATIC",
          message:
            "ctx.env method access must use get or require statically in Cell server code.",
        },
      ],
    });
  });

  it("reports computed ctx.env method destructuring before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: { secrets: ['API_TOKEN'] },",
        "  queries: {",
        "    config: query({",
        "      handler: async (ctx, input: { method: 'get' | 'require' }) => {",
        "        const { [input.method]: readEnv } = ctx.env;",
        "        return readEnv('API_TOKEN');",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "ENV_METHOD_NOT_STATIC",
          message:
            "ctx.env method destructuring must use get or require statically in Cell server code.",
        },
      ],
    });
  });

  it("reports aliased ctx.env method reads without env declarations before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  queries: {",
        "    config: query({",
        "      handler: async (ctx) => {",
        "        const requireEnv = ctx.env.require;",
        "        const env = ctx.env;",
        "        const { get: getEnv } = env;",
        "        return {",
        "          token: requireEnv('API_TOKEN'),",
        "          region: getEnv('AWS_REGION'),",
        "        };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "ENV_NOT_DECLARED",
          message:
            "ctx.env.require('API_TOKEN') requires 'API_TOKEN' to be declared in capabilities.env or capabilities.secrets.",
        }),
        expect.objectContaining({
          code: "ENV_NOT_DECLARED",
          message:
            "ctx.env.get('AWS_REGION') requires 'AWS_REGION' to be declared in capabilities.env or capabilities.secrets.",
        }),
      ]),
    });
  });

  it("reports bracket ctx.env method reads without env declarations before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  queries: {",
        "    config: query({",
        "      handler: async (ctx) => {",
        "        const requireEnv = ctx.env['require'];",
        "        const env = ctx['env'];",
        "        const getEnv = env['get'];",
        "        return {",
        "          token: requireEnv('API_TOKEN'),",
        "          region: ctx.env['get']('AWS_REGION'),",
        "          mode: getEnv('NODE_ENV'),",
        "        };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "ENV_NOT_DECLARED",
          message:
            "ctx.env.require('API_TOKEN') requires 'API_TOKEN' to be declared in capabilities.env or capabilities.secrets.",
        }),
        expect.objectContaining({
          code: "ENV_NOT_DECLARED",
          message:
            "ctx.env.get('AWS_REGION') requires 'AWS_REGION' to be declared in capabilities.env or capabilities.secrets.",
        }),
        expect.objectContaining({
          code: "ENV_NOT_DECLARED",
          message:
            "ctx.env.get('NODE_ENV') requires 'NODE_ENV' to be declared in capabilities.env or capabilities.secrets.",
        }),
      ]),
    });
  });

  it("accepts aliased ctx.env method reads when env names are declared", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: {",
        "    env: ['AWS_REGION'],",
        "    secrets: ['API_TOKEN'],",
        "  },",
        "  queries: {",
        "    config: query({",
        "      handler: async (ctx) => {",
        "        const requireEnv = ctx.env.require;",
        "        const { get: getEnv } = ctx.env;",
        "        return {",
        "          token: requireEnv('API_TOKEN'),",
        "          region: getEnv('AWS_REGION'),",
        "        };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result.ok).toBe(true);
  });

  it("accepts bracket ctx.env method reads when env names are declared", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: {",
        "    env: ['AWS_REGION', 'NODE_ENV'],",
        "    secrets: ['API_TOKEN'],",
        "  },",
        "  queries: {",
        "    config: query({",
        "      handler: async (ctx) => {",
        "        const requireEnv = ctx.env['require'];",
        "        const env = ctx['env'];",
        "        const getEnv = env['get'];",
        "        return {",
        "          token: requireEnv('API_TOKEN'),",
        "          region: ctx.env['get']('AWS_REGION'),",
        "          mode: getEnv('NODE_ENV'),",
        "        };",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result.ok).toBe(true);
  });

  it("accepts ctx.env reads declared as env config or secrets", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, query } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: {",
        "    env: ['AWS_REGION'],",
        "    secrets: { API_TOKEN: true },",
        "  },",
        "  queries: {",
        "    config: query({",
        "      handler: async (ctx) => ({",
        "        apiToken: ctx.env.require('API_TOKEN'),",
        "        region: ctx.env.get('AWS_REGION'),",
        "      }),",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result.ok).toBe(true);
  });

  it("reports undeclared workflow capability before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, workflow } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  workflows: {",
        "    syncNotes: workflow({",
        "      steps: [{ name: 'fetch', handler: async () => ({}) }],",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "CAPABILITY_NOT_DECLARED",
          message: "Workflows require capabilities.workflows to be declared.",
        },
      ],
    });
  });

  it("accepts workflows with the workflows capability declared", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, mutation, workflow } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: { workflows: true },",
        "  mutations: {",
        "    kickOff: mutation({",
        "      handler: async (ctx) => ctx.workflows.start('syncNotes', {}),",
        "    }),",
        "  },",
        "  workflows: {",
        "    syncNotes: workflow({",
        "      steps: [{ name: 'fetch', handler: async () => ({}) }],",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result.ok).toBe(true);
  });

  it("includes workflows in the built manifest", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, workflow } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: { workflows: true },",
        "  workflows: {",
        "    syncNotes: workflow({",
        "      steps: [",
        "        { name: 'fetch', handler: async () => ({}) },",
        "        { name: 'store', handler: async () => ({}) },",
        "      ],",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await buildCell({ rootDir });

    expect(result.ok).toBe(true);
    expect(result.manifest).toMatchObject({
      schemaVersion: "0.1",
      workflows: [{ name: "syncNotes", steps: ["fetch", "store"] }],
    });
  });

  it("reports undeclared service capability before bundling", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, service } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  services: {",
        "    heartbeat: service({",
        "      handler: async (ctx, controls) => {",
        "        while (!controls.stopping()) {",
        "          await new Promise((resolve) => setTimeout(resolve, 1000));",
        "        }",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await checkCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "import-policy",
      diagnostics: [
        {
          code: "CAPABILITY_NOT_DECLARED",
          message: "Services require capabilities.services to be declared.",
        },
      ],
    });
  });

  it("includes services in the built manifest", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, service } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  capabilities: { services: true },",
        "  services: {",
        "    heartbeat: service({",
        "      restart: 'always',",
        "      maxRestarts: 3,",
        "      handler: async (ctx, controls) => {",
        "        while (!controls.stopping()) {",
        "          await new Promise((resolve) => setTimeout(resolve, 1000));",
        "        }",
        "      },",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await buildCell({ rootDir });

    expect(result.ok).toBe(true);
    expect(result.manifest).toMatchObject({
      schemaVersion: "0.1",
      services: [{ name: "heartbeat", restart: "always", maxRestarts: 3 }],
    });
  });

  it("compiles Cell-mounted agents into the manifest", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, channel, defineAgent, endpoint } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  agents: {",
        "    support: defineAgent({",
        '      name: "support",',
        '      instructions: "Answer support questions using Cell context.",',
        "      model: { provider: 'local', model: 'stub' },",
        "      capabilities: { filesystem: 'none', secrets: 'none' },",
        "      approvals: { requiredFor: ['email.sendExternal'] },",
        "    }),",
        "  },",
        "  endpoints: {",
        "    chat: endpoint({",
        "      method: 'POST',",
        "      path: '/api/chat',",
        "      auth: 'public',",
        "      agent: 'support',",
        "      handler: async () => ({ ok: true }),",
        "    }),",
        "  },",
        "  channels: {",
        "    supportSlack: channel({",
        "      provider: 'slack',",
        "      agent: 'support',",
        "      sessionKey: 'sender-thread',",
        "      events: ['app_mention', 'message'],",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await buildCell({ rootDir });

    expect(result.ok).toBe(true);
    expect(result.manifest).toMatchObject({
      agents: {
        support: {
          kind: "anvil.agent",
          model: { provider: "local", model: "stub" },
          requires: {
            humanApproval: ["email.sendExternal"],
          },
        },
      },
      endpoints: [
        expect.objectContaining({
          name: "chat",
          agent: "support",
        }),
      ],
      channels: [
        {
          name: "supportSlack",
          provider: "slack",
          agent: "support",
          sessionKey: "sender-thread",
          events: ["app_mention", "message"],
        },
      ],
    });
  });

  it("fails validation when endpoints reference missing mounted agents", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, endpoint } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  endpoints: {",
        "    chat: endpoint({",
        "      method: 'POST',",
        "      path: '/api/chat',",
        "      auth: 'public',",
        "      agent: 'missing',",
        "      handler: async () => ({ ok: true }),",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await buildCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "manifest",
      diagnostics: [
        expect.objectContaining({
          code: "AGENT_ENDPOINT_REFERENCE_MISSING",
        }),
      ],
    });
  });

  it("fails validation when channels reference missing mounted agents", async () => {
    const rootDir = await createCell({
      server: [
        'import { app, channel } from "@anvil-cloud/runtime";',
        "",
        "export default app({",
        "  channels: {",
        "    supportSlack: channel({",
        "      provider: 'slack',",
        "      agent: 'missing',",
        "    }),",
        "  },",
        "});",
        "",
      ].join("\n"),
    });

    const result = await buildCell({ rootDir });

    expect(result).toMatchObject({
      ok: false,
      phase: "manifest",
      diagnostics: [
        expect.objectContaining({
          code: "AGENT_CHANNEL_REFERENCE_MISSING",
        }),
      ],
    });
  });
});

async function createCell(options: {
  server: string;
  client?: string;
  clientEntry?: string;
  clientKind?: "vite-react" | "expo-router" | "headless";
}): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cell-"));
  const repoRoot = path.resolve(process.cwd(), "../..");

  tempDirs.push(rootDir);
  await mkdir(path.join(rootDir, "src"), { recursive: true });
  await mkdir(path.join(rootDir, "app"), { recursive: true });
  await mkdir(path.join(rootDir, ".anvil/generated"), { recursive: true });
  const clientEntry = options.clientEntry ?? "src/cell.client.tsx";
  await writeFile(
    path.join(rootDir, "anvil.json"),
    JSON.stringify(
      {
        name: "notes",
        client: {
          kind: options.clientKind ?? "vite-react",
        },
        entrypoints: {
          server: "src/cell.server.ts",
          client: clientEntry,
        },
        runtime: "nodejs20",
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(rootDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          jsx: "react-jsx",
          baseUrl: ".",
          paths: {
            "@anvil-cloud/runtime": [
              toPosixPath(
                path.relative(
                  rootDir,
                  path.join(repoRoot, "packages/runtime/src/index.ts"),
                ),
              ),
            ],
            "@anvil-cloud/client": [
              toPosixPath(
                path.relative(
                  rootDir,
                  path.join(repoRoot, "packages/client/src/index.ts"),
                ),
              ),
            ],
            "@anvil/generated/client": [".anvil/generated/client.ts"],
          },
        },
        include: ["src/**/*.ts", "src/**/*.tsx", ".anvil/generated/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(rootDir, "src/cell.server.ts"),
    options.server,
    "utf8",
  );
  await writeFile(
    path.join(rootDir, ".anvil/generated/client.ts"),
    [
      'import type { GeneratedAnvilApi } from "@anvil-cloud/client";',
      "",
      "export const api = {",
      "  queries: {},",
      "  mutations: {},",
      "} as GeneratedAnvilApi;",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(path.dirname(path.join(rootDir, clientEntry)), {
    recursive: true,
  });
  await writeFile(
    path.join(rootDir, clientEntry),
    options.client ?? "console.log('client ready');\n",
    "utf8",
  );

  return rootDir;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readText(filePath);
    return true;
  } catch {
    return false;
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function readText(filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");

  return readFile(filePath, "utf8");
}
