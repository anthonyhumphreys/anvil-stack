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
});

async function createCell(options: { server: string }): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cell-"));
  const repoRoot = path.resolve(process.cwd(), "../..");

  tempDirs.push(rootDir);
  await mkdir(path.join(rootDir, "src"), { recursive: true });
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
          },
        },
        include: ["src/**/*.ts", "src/**/*.tsx"],
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
    path.join(rootDir, "src/cell.client.tsx"),
    "console.log('client ready');\n",
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
