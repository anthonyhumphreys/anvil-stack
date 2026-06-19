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
        'import { app, defineAgent, endpoint } from "@anvil-cloud/runtime";',
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
});

async function createCell(options: {
  server: string;
  client?: string;
}): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cell-"));
  const repoRoot = path.resolve(process.cwd(), "../..");

  tempDirs.push(rootDir);
  await mkdir(path.join(rootDir, "src"), { recursive: true });
  await mkdir(path.join(rootDir, ".anvil/generated"), { recursive: true });
  await writeFile(
    path.join(rootDir, "anvil.json"),
    JSON.stringify(
      {
        name: "notes",
        entrypoints: {
          server: "src/cell.server.ts",
          client: "src/cell.client.tsx",
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
  await writeFile(
    path.join(rootDir, "src/cell.client.tsx"),
    options.client ?? "console.log('client ready');\n",
    "utf8",
  );

  return rootDir;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function readText(filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");

  return readFile(filePath, "utf8");
}
