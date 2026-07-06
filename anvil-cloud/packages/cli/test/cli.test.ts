import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isPnpmVersionSupported,
  main,
  parsePositiveIntegerOption,
  parsePositiveNumberOption,
  parseSinceOption,
  waitForRemoteRuntime,
} from "../src/index.js";

const testCwd = process.cwd();

afterEach(() => {
  process.chdir(testCwd);
});

describe("main", () => {
  it("prints help output", async () => {
    const output = await captureStdout(() => main(["help"]));

    expect(output).toContain("Anvil Cloud CLI");
    expect(output).toContain("anvil-cloud check");
    expect(output).toContain("anvil-cloud doctor");
    expect(output).toContain("anvil-cloud manifest diff");
    expect(output).toContain(
      "anvil-cloud destroy --preview --app <name> --yes",
    );
  });

  it("checks the supported pnpm version floor", () => {
    expect(isPnpmVersionSupported("8.15.9")).toBe(false);
    expect(isPnpmVersionSupported("9.0.0")).toBe(true);
    expect(isPnpmVersionSupported("10.1.0")).toBe(true);
  });

  it("emits doctor diagnostics as stable JSON", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-doctor-"));
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    const env = snapshotEnv([
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "ANVIL_AWS_ARTIFACT_BUCKET",
      "ANVIL_AWS_DEPLOYMENT_METADATA_TABLE",
      "ANVIL_AUTH_ISSUER",
      "ANVIL_AUTH_AUDIENCE",
      "ANVIL_AUTH_JWKS_URI",
      "ANVIL_AUTH_USER_ID_CLAIM",
      "ANVIL_AUTH_EMAIL_CLAIM",
      "ANVIL_AUTH_ROLES_CLAIM",
      "ANVIL_AWS_SMOKE_TOKEN",
      "ANVIL_AWS_EXPIRED_SMOKE_TOKEN",
      "ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN",
      "ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN",
    ]);

    try {
      process.exitCode = undefined;
      process.chdir(rootDir);
      process.env.AWS_REGION = "eu-west-2";
      process.env.ANVIL_AWS_ARTIFACT_BUCKET = "artifact-bucket";
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE = "deployments";
      process.env.ANVIL_AUTH_ISSUER = "https://issuer.example.test/";
      process.env.ANVIL_AUTH_AUDIENCE = "anvil-cloud";
      process.env.ANVIL_AUTH_USER_ID_CLAIM = "uid";
      process.env.ANVIL_AUTH_EMAIL_CLAIM = "mail";
      process.env.ANVIL_AUTH_ROLES_CLAIM = "scp";
      process.env.ANVIL_AWS_SMOKE_TOKEN = "test-token";
      process.env.ANVIL_AWS_EXPIRED_SMOKE_TOKEN = "expired-test-token";
      process.env.ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN = "wrong-issuer-token";
      process.env.ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN = "wrong-audience-token";
      delete process.env.AWS_DEFAULT_REGION;
      delete process.env.ANVIL_AUTH_JWKS_URI;

      await writeFile(
        path.join(rootDir, "anvil.json"),
        JSON.stringify({ name: "notes" }),
        "utf8",
      );
      await mkdir(path.join(rootDir, ".anvil/dist"), { recursive: true });
      await writeFile(
        path.join(rootDir, ".anvil/dist/manifest.json"),
        JSON.stringify({ cell: { name: "notes" } }),
        "utf8",
      );
      await mkdir(path.join(rootDir, ".anvil/generated"), { recursive: true });
      await writeFile(
        path.join(rootDir, ".anvil/generated/client.ts"),
        "export const api = { queries: {}, mutations: {} };\n",
        "utf8",
      );
      await mkdir(path.join(rootDir, ".anvil/local/auth"), {
        recursive: true,
      });
      await writeFile(
        path.join(rootDir, ".anvil/local/auth/users.json"),
        "[]",
        "utf8",
      );
      await writeFile(path.join(rootDir, ".anvil/local/dev.db"), "{}", "utf8");
      await writeFile(
        path.join(rootDir, ".anvil/local/workflows.json"),
        "[]",
        "utf8",
      );
      await writeFile(
        path.join(rootDir, ".anvil/local/services.json"),
        JSON.stringify({ services: [] }),
        "utf8",
      );

      const output = await captureStdout(() =>
        main(["doctor", "--json", "--port", "65431", "--client-port", "65432"]),
      );
      const payload = JSON.parse(output) as {
        ok: boolean;
        summary: { info: number; errors: number };
        checks: Array<{ id: string; status: string; details?: unknown }>;
      };
      const checks = new Map(payload.checks.map((check) => [check.id, check]));

      expect(payload.ok).toBe(true);
      expect(payload.summary.info).toBe(0);
      expect(payload.summary.errors).toBe(0);
      expect(checks.get("node.version")).toMatchObject({ status: "ok" });
      expect(checks.get("packages.publicBoundary")).toMatchObject({
        status: "ok",
        details: {
          publicPackages: ["@anvilstack/cloud-cli"],
          candidatePublicApis: ["@anvil-cloud/runtime", "@anvil-cloud/client"],
          violations: [],
        },
      });
      expect(checks.get("project.config")).toMatchObject({ status: "ok" });
      expect(checks.get("project.build")).toMatchObject({ status: "ok" });
      expect(checks.get("project.generatedClient")).toMatchObject({
        status: "ok",
      });
      expect(checks.get("local.state")).toMatchObject({
        status: "ok",
        details: {
          files: {
            authUsers: true,
            authKeys: false,
            database: true,
            logs: false,
            jobs: false,
            workflows: true,
            services: true,
          },
        },
      });
      expect(checks.get("local.runtime")?.status).toMatch(/ok|warning/);
      expect(checks.get("aws.artifactBucket")).toMatchObject({
        status: "ok",
      });
      expect(checks.get("auth.oidc")).toMatchObject({
        status: "ok",
        details: {
          claims: {
            userId: {
              env: "ANVIL_AUTH_USER_ID_CLAIM",
              claim: "uid",
              configured: true,
            },
            email: {
              env: "ANVIL_AUTH_EMAIL_CLAIM",
              claim: "mail",
              configured: true,
            },
            roles: {
              env: "ANVIL_AUTH_ROLES_CLAIM",
              claim: "scp",
              configured: true,
            },
          },
        },
      });
      expect(checks.get("auth.smokeToken")).toMatchObject({
        status: "ok",
        details: {
          ANVIL_AWS_SMOKE_TOKEN: true,
        },
      });
      expect(checks.get("auth.expiredSmokeToken")).toMatchObject({
        status: "ok",
        details: {
          ANVIL_AWS_EXPIRED_SMOKE_TOKEN: true,
        },
      });
      expect(checks.get("auth.wrongIssuerSmokeToken")).toMatchObject({
        status: "ok",
        details: {
          ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN: true,
        },
      });
      expect(checks.get("auth.wrongAudienceSmokeToken")).toMatchObject({
        status: "ok",
        details: {
          ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN: true,
        },
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      restoreEnvSnapshot(env);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports default OIDC claim mapping in doctor diagnostics", async () => {
    const originalExitCode = process.exitCode;
    const env = snapshotEnv([
      "ANVIL_AUTH_ISSUER",
      "ANVIL_AUTH_AUDIENCE",
      "ANVIL_AUTH_JWKS_URI",
      "ANVIL_AUTH_USER_ID_CLAIM",
      "ANVIL_AUTH_EMAIL_CLAIM",
      "ANVIL_AUTH_ROLES_CLAIM",
    ]);

    try {
      process.exitCode = undefined;
      delete process.env.ANVIL_AUTH_ISSUER;
      delete process.env.ANVIL_AUTH_AUDIENCE;
      delete process.env.ANVIL_AUTH_JWKS_URI;
      delete process.env.ANVIL_AUTH_USER_ID_CLAIM;
      delete process.env.ANVIL_AUTH_EMAIL_CLAIM;
      delete process.env.ANVIL_AUTH_ROLES_CLAIM;

      const output = await captureStdout(() =>
        main(["doctor", "--json", "--port", "65441", "--client-port", "65442"]),
      );
      const payload = JSON.parse(output) as {
        checks: Array<{
          id: string;
          status: string;
          details?: unknown;
        }>;
      };
      const oidc = payload.checks.find((check) => check.id === "auth.oidc");

      expect(oidc).toMatchObject({
        status: "warning",
        details: {
          claims: {
            userId: {
              env: "ANVIL_AUTH_USER_ID_CLAIM",
              claim: "sub",
              configured: false,
            },
            email: {
              env: "ANVIL_AUTH_EMAIL_CLAIM",
              claim: "email",
              configured: false,
            },
            roles: {
              env: "ANVIL_AUTH_ROLES_CLAIM",
              claim: "roles",
              configured: false,
            },
          },
        },
      });
    } finally {
      process.exitCode = originalExitCode;
      restoreEnvSnapshot(env);
    }
  });

  it("reports invalid local runtime health JSON with diagnostic details", async () => {
    const originalExitCode = process.exitCode;
    const server = await startDoctorHealthServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<html>not anvil</html>");
    });

    try {
      process.exitCode = undefined;
      const output = await captureStdout(() =>
        main([
          "doctor",
          "--json",
          "--port",
          String(server.port),
          "--client-port",
          "65448",
        ]),
      );
      const payload = JSON.parse(output) as {
        ok: boolean;
        checks: Array<{
          id: string;
          status: string;
          message?: string;
          details?: Record<string, unknown>;
        }>;
      };
      const runtime = payload.checks.find(
        (check) => check.id === "local.runtime",
      );

      expect(payload.ok).toBe(true);
      expect(runtime).toMatchObject({
        status: "warning",
        message: `Runtime health endpoint did not return JSON at http://localhost:${server.port}.`,
        details: {
          reason: "invalid-json",
          status: 200,
          contentType: "text/html",
          body: "<html>not anvil</html>",
        },
      });
    } finally {
      process.exitCode = originalExitCode;
      await server.close();
    }
  });

  it("reports non-Anvil local runtime health payloads", async () => {
    const originalExitCode = process.exitCode;
    const server = await startDoctorHealthServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: false, service: "other" }));
    });

    try {
      process.exitCode = undefined;
      const output = await captureStdout(() =>
        main([
          "doctor",
          "--json",
          "--port",
          String(server.port),
          "--client-port",
          "65449",
        ]),
      );
      const payload = JSON.parse(output) as {
        ok: boolean;
        checks: Array<{
          id: string;
          status: string;
          details?: Record<string, unknown>;
        }>;
      };
      const runtime = payload.checks.find(
        (check) => check.id === "local.runtime",
      );

      expect(payload.ok).toBe(true);
      expect(runtime).toMatchObject({
        status: "warning",
        details: {
          reason: "not-anvil-health",
          status: 200,
          payload: {
            ok: false,
            service: "other",
          },
        },
      });
    } finally {
      process.exitCode = originalExitCode;
      await server.close();
    }
  });

  it("warns when generated client metadata is missing", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-doctor-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(rootDir);
      await writeFile(
        path.join(rootDir, "anvil.json"),
        JSON.stringify({ name: "notes" }),
        "utf8",
      );
      await mkdir(path.join(rootDir, ".anvil/dist"), { recursive: true });
      await writeFile(
        path.join(rootDir, ".anvil/dist/manifest.json"),
        JSON.stringify({ cell: { name: "notes" } }),
        "utf8",
      );

      const output = await captureStdout(() =>
        main(["doctor", "--json", "--port", "65435", "--client-port", "65436"]),
      );
      const payload = JSON.parse(output) as {
        ok: boolean;
        checks: Array<{
          id: string;
          status: string;
          hint?: string;
        }>;
      };
      const generatedClient = payload.checks.find(
        (check) => check.id === "project.generatedClient",
      );

      expect(payload.ok).toBe(true);
      expect(generatedClient).toMatchObject({
        status: "warning",
        message: "Generated client metadata was not found.",
        hint: "Run anvil-cloud build --json so @anvil/generated/client imports resolve.",
      });
    } finally {
      process.chdir(originalCwd);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("warns when generated client metadata is stale", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-doctor-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(rootDir);
      await writeFile(
        path.join(rootDir, "anvil.json"),
        JSON.stringify({ name: "notes" }),
        "utf8",
      );
      await mkdir(path.join(rootDir, ".anvil/dist"), { recursive: true });
      await writeFile(
        path.join(rootDir, ".anvil/dist/manifest.json"),
        JSON.stringify({
          cell: { name: "notes" },
          queries: ["listNotes"],
          mutations: ["createNote"],
        }),
        "utf8",
      );
      await mkdir(path.join(rootDir, ".anvil/generated"), { recursive: true });
      await writeFile(
        path.join(rootDir, ".anvil/generated/client.ts"),
        [
          "export const api = {",
          "  queries: {",
          '    staleQuery: { kind: "query", name: "staleQuery" },',
          "  },",
          "  mutations: {},",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const output = await captureStdout(() =>
        main(["doctor", "--json", "--port", "65437", "--client-port", "65438"]),
      );
      const payload = JSON.parse(output) as {
        ok: boolean;
        checks: Array<{
          id: string;
          status: string;
          hint?: string;
          details?: unknown;
        }>;
      };
      const generatedClient = payload.checks.find(
        (check) => check.id === "project.generatedClient",
      );

      expect(payload.ok).toBe(true);
      expect(generatedClient).toMatchObject({
        status: "warning",
        message: "Generated client metadata does not match the built manifest.",
        hint: "Run anvil-cloud build --json to refresh @anvil/generated/client.",
        details: {
          queries: {
            manifest: ["listNotes"],
            generated: ["staleQuery"],
            missing: ["listNotes"],
            stale: ["staleQuery"],
          },
          mutations: {
            manifest: ["createNote"],
            generated: [],
            missing: ["createNote"],
            stale: [],
          },
        },
      });
    } finally {
      process.chdir(originalCwd);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("uses stable generated client metadata for doctor freshness checks", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-doctor-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(rootDir);
      await writeFile(
        path.join(rootDir, "anvil.json"),
        JSON.stringify({ name: "notes" }),
        "utf8",
      );
      await mkdir(path.join(rootDir, ".anvil/dist"), { recursive: true });
      await writeFile(
        path.join(rootDir, ".anvil/dist/manifest.json"),
        JSON.stringify({
          cell: { name: "notes" },
          queries: ["listNotes"],
          mutations: ["createNote"],
        }),
        "utf8",
      );
      await mkdir(path.join(rootDir, ".anvil/generated"), { recursive: true });
      await writeFile(
        path.join(rootDir, ".anvil/generated/client.ts"),
        [
          "export const api = {",
          "  queries: {",
          '    staleQuery: { kind: "query", name: "staleQuery" },',
          "  },",
          "  mutations: {},",
          "  meta: {",
          '    schemaVersion: "0.1",',
          '    queries: ["listNotes"],',
          '    mutations: ["createNote"],',
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const output = await captureStdout(() =>
        main(["doctor", "--json", "--port", "65439", "--client-port", "65440"]),
      );
      const payload = JSON.parse(output) as {
        checks: Array<{
          id: string;
          status: string;
          message: string;
          details?: unknown;
        }>;
      };
      const generatedClient = payload.checks.find(
        (check) => check.id === "project.generatedClient",
      );

      expect(generatedClient).toMatchObject({
        status: "ok",
        message: "Generated client metadata matches the built manifest.",
        details: {
          queries: {
            manifest: ["listNotes"],
            generated: ["listNotes"],
            missing: [],
            stale: [],
          },
          mutations: {
            manifest: ["createNote"],
            generated: ["createNote"],
            missing: [],
            stale: [],
          },
        },
      });
    } finally {
      process.chdir(originalCwd);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("warns when the AWS preview smoke token is missing", async () => {
    const originalExitCode = process.exitCode;
    const env = snapshotEnv(["ANVIL_AWS_SMOKE_TOKEN"]);

    try {
      process.exitCode = undefined;
      delete process.env.ANVIL_AWS_SMOKE_TOKEN;

      const output = await captureStdout(() =>
        main(["doctor", "--json", "--port", "65433", "--client-port", "65434"]),
      );
      const payload = JSON.parse(output) as {
        ok: boolean;
        checks: Array<{
          id: string;
          status: string;
          hint?: string;
          details?: unknown;
        }>;
      };
      const smokeToken = payload.checks.find(
        (check) => check.id === "auth.smokeToken",
      );

      expect(payload.ok).toBe(true);
      expect(smokeToken).toMatchObject({
        status: "warning",
        message: "No AWS preview smoke token is configured.",
        hint: "Set ANVIL_AWS_SMOKE_TOKEN to exercise authenticated AWS preview query and mutation calls.",
        details: {
          ANVIL_AWS_SMOKE_TOKEN: false,
        },
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = originalExitCode;
      restoreEnvSnapshot(env);
    }
  });

  it("reports the optional expired AWS preview smoke token as info when missing", async () => {
    const originalExitCode = process.exitCode;
    const env = snapshotEnv(["ANVIL_AWS_EXPIRED_SMOKE_TOKEN"]);

    try {
      process.exitCode = undefined;
      delete process.env.ANVIL_AWS_EXPIRED_SMOKE_TOKEN;

      const output = await captureStdout(() =>
        main(["doctor", "--json", "--port", "65443", "--client-port", "65444"]),
      );
      const payload = JSON.parse(output) as {
        ok: boolean;
        summary: { info: number; errors: number };
        checks: Array<{
          id: string;
          status: string;
          hint?: string;
          details?: unknown;
        }>;
      };
      const expiredSmokeToken = payload.checks.find(
        (check) => check.id === "auth.expiredSmokeToken",
      );

      expect(payload.ok).toBe(true);
      expect(payload.summary.info).toBeGreaterThanOrEqual(1);
      expect(expiredSmokeToken).toMatchObject({
        status: "info",
        message: "No expired AWS preview smoke token is configured.",
        hint: "Set ANVIL_AWS_EXPIRED_SMOKE_TOKEN when you want verify:aws-preview to prove expired-token rejection.",
        details: {
          ANVIL_AWS_EXPIRED_SMOKE_TOKEN: false,
        },
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = originalExitCode;
      restoreEnvSnapshot(env);
    }
  });

  it("reports optional OIDC negative smoke tokens as info when missing", async () => {
    const originalExitCode = process.exitCode;
    const env = snapshotEnv([
      "ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN",
      "ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN",
    ]);

    try {
      process.exitCode = undefined;
      delete process.env.ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN;
      delete process.env.ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN;

      const output = await captureStdout(() =>
        main(["doctor", "--json", "--port", "65445", "--client-port", "65446"]),
      );
      const payload = JSON.parse(output) as {
        ok: boolean;
        summary: { info: number; errors: number };
        checks: Array<{
          id: string;
          status: string;
          hint?: string;
          details?: unknown;
        }>;
      };
      const wrongIssuer = payload.checks.find(
        (check) => check.id === "auth.wrongIssuerSmokeToken",
      );
      const wrongAudience = payload.checks.find(
        (check) => check.id === "auth.wrongAudienceSmokeToken",
      );

      expect(payload.ok).toBe(true);
      expect(payload.summary.info).toBeGreaterThanOrEqual(2);
      expect(wrongIssuer).toMatchObject({
        status: "info",
        message: "No wrong-issuer AWS preview smoke token is configured.",
        hint: "Set ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN when you want verify:aws-preview to prove issuer rejection.",
        details: {
          ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN: false,
        },
      });
      expect(wrongAudience).toMatchObject({
        status: "info",
        message: "No wrong-audience AWS preview smoke token is configured.",
        hint: "Set ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN when you want verify:aws-preview to prove audience rejection.",
        details: {
          ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN: false,
        },
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = originalExitCode;
      restoreEnvSnapshot(env);
    }
  });

  it("diffs the previous built manifest against the current Cell source", async () => {
    const rootDir = await createManifestDiffCell([
      'import { app, query, table, text } from "@anvil-cloud/runtime";',
      "",
      "export default app({",
      "  schema: { notes: table({ title: text(), body: text() }) },",
      "  capabilities: { database: true, files: { publicRead: false } },",
      "  queries: { listNotes: query({ handler: async () => [] }) },",
      "});",
      "",
    ]);
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      process.chdir(rootDir);
      await captureStdout(() => main(["build", "--json"]));
      await writeFile(
        path.join(rootDir, "src/cell.server.ts"),
        [
          'import { app, query, table, text } from "@anvil-cloud/runtime";',
          "",
          "export default app({",
          "  schema: { notes: table({ title: text() }) },",
          "  capabilities: { database: true, files: { publicRead: true } },",
          "  queries: { searchNotes: query({ handler: async () => [] }) },",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const output = await captureStdout(() =>
        main(["manifest", "diff", "--json"]),
      );
      const payload = JSON.parse(output) as {
        ok: boolean;
        status: string;
        summary: { errors: number; warnings: number };
        changes: Array<{
          id: string;
          severity: string;
          action: string;
          path: string;
        }>;
      };

      expect(payload.ok).toBe(false);
      expect(payload.status).toBe("block");
      expect(payload.summary).toMatchObject({ errors: 2, warnings: 1 });
      expect(payload.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "capabilities.files.changed",
            severity: "error",
          }),
          expect.objectContaining({
            id: "schema.tables.notes.fields.body.removed",
            severity: "error",
          }),
          expect.objectContaining({
            id: "queries.listNotes.removed",
            severity: "warning",
          }),
          expect.objectContaining({
            id: "queries.searchNotes.added",
            severity: "info",
          }),
        ]),
      );
      expect(process.exitCode).toBe(5);
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("diffs explicit manifest paths without building source", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-manifest-"));
    const originalExitCode = process.exitCode;
    const previous = createTestManifest({ queries: ["listNotes"] });
    const next = createTestManifest({
      queries: ["listNotes", "searchNotes"],
    });

    try {
      process.exitCode = undefined;
      await writeFile(
        path.join(rootDir, "previous.json"),
        `${JSON.stringify(previous)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(rootDir, "next.json"),
        `${JSON.stringify(next)}\n`,
        "utf8",
      );

      const output = await captureStdout(() =>
        main([
          "manifest",
          "diff",
          "--json",
          "--from",
          path.join(rootDir, "previous.json"),
          "--to",
          path.join(rootDir, "next.json"),
        ]),
      );
      const payload = JSON.parse(output) as {
        ok: boolean;
        status: string;
        changes: Array<{ id: string; action: string }>;
      };

      expect(payload.ok).toBe(true);
      expect(payload.status).toBe("changed");
      expect(payload.changes).toEqual([
        expect.objectContaining({
          id: "queries.searchNotes.added",
          action: "add",
        }),
      ]);
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = originalExitCode;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("scaffolds a Vite React client by default", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(rootDir);
      const output = await captureStdout(() =>
        main(["new", "react-notes", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;
      const cellDir = path.join(rootDir, "react-notes");
      const anvilConfig = JSON.parse(
        await readFile(path.join(cellDir, "anvil.json"), "utf8"),
      ) as { client: { kind: string }; entrypoints: { client: string } };
      const packageJson = JSON.parse(
        await readFile(path.join(cellDir, "package.json"), "utf8"),
      ) as {
        scripts?: Record<string, string>;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };

      expect(payload).toMatchObject({
        ok: true,
        cell: "react-notes",
        client: {
          kind: "vite-react",
        },
      });
      expect(anvilConfig.client.kind).toBe("vite-react");
      expect(anvilConfig.entrypoints.client).toBe("src/client/main.tsx");
      expect(packageJson.scripts).toMatchObject({
        check: "anvil-cloud check --json",
        build: "anvil-cloud build --json",
        "manifest:diff": "anvil-cloud manifest diff --json",
        dev: "anvil-cloud dev --json",
        "inspect:local": "anvil-cloud inspect --local --json",
        "logs:local": "anvil-cloud logs --local --json",
        "deploy:preview:gate": "anvil-cloud deploy --preview --wait --json",
        "destroy:preview:dry-run":
          "anvil-cloud destroy --preview --app react-notes --yes --dry-run --json",
      });
      expect(packageJson.dependencies).toMatchObject({
        "@anvil-cloud/client": "workspace:*",
        "@vitejs/plugin-react": expect.any(String),
        react: expect.any(String),
        "react-dom": expect.any(String),
        vite: expect.any(String),
      });
      expect(packageJson.devDependencies).toMatchObject({
        "@types/react": expect.any(String),
        "@types/react-dom": expect.any(String),
        typescript: expect.any(String),
      });
      await expect(
        readFile(path.join(cellDir, "src/client/App.tsx"), "utf8"),
      ).resolves.toContain('import { api } from "@anvil/generated/client";');
      await expect(
        readFile(path.join(cellDir, "src/anvil-api.d.ts"), "utf8"),
      ).resolves.toContain("interface QueryTypes");
      await expect(
        readFile(path.join(cellDir, "vite.config.ts"), "utf8"),
      ).resolves.toContain("@vitejs/plugin-react");
      await expect(
        readFile(path.join(cellDir, "index.html"), "utf8"),
      ).resolves.toContain("/src/client/main.tsx");
    } finally {
      process.chdir(originalCwd);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("scaffolds an Expo Router client target", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(rootDir);
      const output = await captureStdout(() =>
        main(["new", "native-notes", "--client", "expo-router", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;
      const cellDir = path.join(rootDir, "native-notes");
      const anvilConfig = JSON.parse(
        await readFile(path.join(cellDir, "anvil.json"), "utf8"),
      ) as { client: { kind: string }; entrypoints: { client: string } };
      const packageJson = JSON.parse(
        await readFile(path.join(cellDir, "package.json"), "utf8"),
      ) as {
        scripts?: Record<string, string>;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      const tsconfig = JSON.parse(
        await readFile(path.join(cellDir, "tsconfig.json"), "utf8"),
      ) as { extends?: string; include: string[] };

      expect(payload).toMatchObject({
        ok: true,
        cell: "native-notes",
        client: {
          kind: "expo-router",
        },
      });
      expect(anvilConfig.client.kind).toBe("expo-router");
      expect(anvilConfig.entrypoints.client).toBe("app/index.tsx");
      expect(packageJson.scripts).toMatchObject({
        check: "anvil-cloud check --json",
        build: "anvil-cloud build --json",
        "manifest:diff": "anvil-cloud manifest diff --json",
        dev: "anvil-cloud dev --json",
        "inspect:local": "anvil-cloud inspect --local --json",
        "logs:local": "anvil-cloud logs --local --json",
        "deploy:preview:gate": "anvil-cloud deploy --preview --wait --json",
        "destroy:preview:dry-run":
          "anvil-cloud destroy --preview --app native-notes --yes --dry-run --json",
        start: "expo start",
      });
      expect(packageJson.dependencies).toMatchObject({
        "@anvil-cloud/client": "workspace:*",
        "@anvil-cloud/runtime": "workspace:*",
        expo: expect.any(String),
        "expo-router": expect.any(String),
        react: expect.any(String),
        "react-native": expect.any(String),
      });
      expect(packageJson.devDependencies).toMatchObject({
        "@types/react": expect.any(String),
        typescript: expect.any(String),
      });
      expect(tsconfig.extends).toBe("expo/tsconfig.base");
      expect(tsconfig.include).toContain("app/**/*.tsx");
      await expect(
        readFile(path.join(cellDir, "app", "_layout.tsx"), "utf8"),
      ).resolves.toContain('import { Stack } from "expo-router/stack";');
      await expect(
        readFile(path.join(cellDir, "app", "index.tsx"), "utf8"),
      ).resolves.toContain("EXPO_PUBLIC_ANVIL_RUNTIME_URL");
      await expect(
        readFile(path.join(cellDir, "app", "index.tsx"), "utf8"),
      ).resolves.toContain('Platform.OS === "android"');
      await expect(
        readFile(path.join(cellDir, "app", "index.tsx"), "utf8"),
      ).resolves.toContain("http://10.0.2.2:8787");
      await expect(
        readFile(path.join(cellDir, "src", "expo-env.d.ts"), "utf8"),
      ).resolves.toContain("EXPO_PUBLIC_ANVIL_RUNTIME_URL?: string");
      await expect(
        readFile(path.join(cellDir, "src/anvil-api.d.ts"), "utf8"),
      ).resolves.toContain("interface MutationTypes");
      await expect(
        readFile(path.join(cellDir, "vite.config.ts"), "utf8"),
      ).rejects.toThrow();
      await expect(
        readFile(path.join(cellDir, "index.html"), "utf8"),
      ).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown client targets when scaffolding", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      process.chdir(rootDir);
      const output = await captureStdout(() =>
        main(["new", "bad-client", "--client", "jquery-mobile", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
      await expect(
        readFile(path.join(rootDir, "bad-client", "anvil.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("prints check diagnostics as stable JSON", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      process.chdir(rootDir);
      await writeFile(
        path.join(rootDir, "anvil.json"),
        JSON.stringify({
          name: "bad-cell",
          runtime: "nodejs20",
          entrypoints: {
            server: "src/cell.server.ts",
            client: "src/client/main.tsx",
          },
        }),
        "utf8",
      );
      await mkdir(path.join(rootDir, "src"), { recursive: true });
      await mkdir(path.join(rootDir, "src/client"), { recursive: true });
      await writeFile(
        path.join(rootDir, "src/cell.server.ts"),
        [
          'import { readFileSync } from "node:fs";',
          'import { app } from "@anvil-cloud/runtime";',
          "",
          "void readFileSync;",
          "export default app({});",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(rootDir, "src/client/main.tsx"),
        "document.body.textContent = 'bad cell';\n",
        "utf8",
      );

      const output = await captureStdout(() => main(["check", "--json"]));
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        phase: "import-policy",
        diagnostics: [
          {
            code: "FORBIDDEN_IMPORT",
            file: "src/cell.server.ts",
            hint: "Use ctx.files for Cell-owned file storage.",
          },
        ],
        errors: [
          {
            code: "FORBIDDEN_IMPORT",
          },
        ],
      });
      expect(payload.diagnostics).toEqual(payload.errors);
      expect(process.exitCode).toBe(3);
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("emits reviewable deployment plan JSON", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      process.chdir(rootDir);
      await captureStdout(() =>
        main(["new", "plan-notes", "--client", "headless", "--json"]),
      );
      process.chdir(path.join(rootDir, "plan-notes"));

      const output = await captureStdout(() =>
        main(["plan", "--stage", "dev", "--adapter", "aws", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: true,
        graph: {
          appName: "plan-notes",
          tables: [
            {
              name: "todos",
            },
          ],
        },
        plan: {
          schemaVersion: "0.1",
          adapter: "aws",
          appName: "plan-notes",
          stage: "dev",
          review: {
            stableId: "aws:plan-notes:dev:deploy",
            operation: "deploy",
            capabilityDiffs: [
              expect.objectContaining({
                id: "cell:plan-notes",
                action: "add",
              }),
              expect.objectContaining({
                id: "table:todos",
                action: "add",
              }),
            ],
            approvalGates: [
              expect.objectContaining({
                id: "data-resource-review",
                required: true,
              }),
            ],
            cost: {
              drivers: expect.arrayContaining([
                expect.objectContaining({ id: "dynamodb" }),
              ]),
            },
          },
        },
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("aggregates Guard and preview plan review into a trust report", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      process.chdir(rootDir);
      await captureStdout(() =>
        main(["new", "review-notes", "--client", "headless", "--json"]),
      );
      process.chdir(path.join(rootDir, "review-notes"));

      const output = await captureStdout(() =>
        main(["review", "--adapter", "aws", "--env", "preview", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: true,
        schemaVersion: "0.1",
        command: "review",
        status: "review",
        target: {
          adapter: "aws",
          environment: "preview",
          cell: "review-notes",
        },
        summary: {
          guardErrors: 0,
          approvalRequired: 1,
          reviewGates: 1,
          blockingGates: 0,
          rollbackSupported: false,
        },
        guard: {
          ok: true,
          diagnostics: [],
        },
        manifest: {
          capabilities: {
            database: true,
          },
        },
        review: {
          stableId: "aws-preview:review-notes:preview:deploy",
          approvalGates: [
            expect.objectContaining({
              id: "data-resource-review",
              required: true,
              severity: "review",
            }),
          ],
          capabilityDiffs: expect.arrayContaining([
            expect.objectContaining({
              id: "database:review-notes-preview",
              action: "add",
            }),
          ]),
        },
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("blocks review reports when Guard diagnostics fail", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      process.chdir(rootDir);
      await writeFile(
        path.join(rootDir, "anvil.json"),
        JSON.stringify({
          name: "bad-review-cell",
          runtime: "nodejs20",
          entrypoints: {
            server: "src/cell.server.ts",
            client: "src/client/main.tsx",
          },
        }),
        "utf8",
      );
      await mkdir(path.join(rootDir, "src/client"), { recursive: true });
      await writeFile(
        path.join(rootDir, "src/cell.server.ts"),
        [
          'import { readFileSync } from "node:fs";',
          'import { app } from "@anvil-cloud/runtime";',
          "",
          "void readFileSync;",
          "export default app({});",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(rootDir, "src/client/main.tsx"),
        "document.body.textContent = 'bad review cell';\n",
        "utf8",
      );

      const output = await captureStdout(() => main(["review", "--json"]));
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        command: "review",
        status: "block",
        summary: {
          guardErrors: 1,
          blockingGates: 1,
        },
        guard: {
          ok: false,
          phase: "import-policy",
          diagnostics: [
            expect.objectContaining({
              code: "FORBIDDEN_IMPORT",
              file: "src/cell.server.ts",
            }),
          ],
        },
        manifest: null,
        review: null,
      });
      expect(process.exitCode).toBe(3);
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("validates, emits, and invokes mounted agents", async () => {
    const rootDir = await createAgentCell();
    const originalCwd = process.cwd();

    try {
      process.chdir(rootDir);

      const validateOutput = await captureStdout(() =>
        main(["agents", "validate", "--json"]),
      );
      const validatePayload = JSON.parse(validateOutput) as Record<
        string,
        unknown
      >;

      expect(validatePayload).toMatchObject({
        ok: true,
        agents: ["support"],
        providers: ["local"],
      });

      const manifestOutput = await captureStdout(() =>
        main(["agents", "manifest", "--json"]),
      );
      const manifestPayload = JSON.parse(manifestOutput) as Record<
        string,
        unknown
      >;

      expect(manifestPayload).toMatchObject({
        ok: true,
        agents: {
          support: {
            kind: "anvil.agent",
            name: "support",
          },
        },
      });

      await mkdir(path.join(rootDir, "agents", "guardian"), {
        recursive: true,
      });
      await writeFile(
        path.join(rootDir, "agents", "guardian", "instructions.md"),
        "Review Cell trust reports before deploy.\n",
        "utf8",
      );

      const discoverOutput = await captureStdout(() =>
        main(["agents", "discover", "--json"]),
      );
      const discoverPayload = JSON.parse(discoverOutput) as Record<
        string,
        unknown
      >;

      expect(discoverPayload).toMatchObject({
        ok: true,
        projectAgents: [
          {
            name: "guardian",
            path: "agents/guardian/instructions.md",
          },
        ],
        mountedAgents: [
          expect.objectContaining({
            name: "support",
            exposure: "cell",
          }),
        ],
      });

      const guardianOutput = await captureStdout(() =>
        main(["agents", "guardian", "--json"]),
      );
      const guardianPayload = JSON.parse(guardianOutput) as Record<
        string,
        unknown
      >;

      expect(guardianPayload).toMatchObject({
        ok: true,
        agent: {
          name: "guardian",
          exposure: "project",
        },
        report: {
          command: "review",
        },
        findings: expect.arrayContaining([
          expect.objectContaining({
            code: "ROLLBACK_MANUAL",
          }),
        ]),
      });

      const invokeOutput = await captureStdout(() =>
        main([
          "agents",
          "invoke",
          "support",
          "--input",
          "Review this Cell",
          "--json",
        ]),
      );
      const invokePayload = JSON.parse(invokeOutput) as Record<string, unknown>;

      expect(invokePayload).toMatchObject({
        ok: true,
        result: {
          agentName: "support",
          response: {
            role: "assistant",
            content: "Local stub response from Anvil Agent: Review this Cell",
          },
        },
      });
    } finally {
      process.chdir(originalCwd);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("emits lightweight AWS preview usage visibility", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      process.chdir(rootDir);
      await captureStdout(() =>
        main(["new", "usage-notes", "--client", "headless", "--json"]),
      );
      process.chdir(path.join(rootDir, "usage-notes"));

      const output = await captureStdout(() =>
        main(["usage", "--preview", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: true,
        schemaVersion: "0.1",
        target: {
          adapter: "aws",
          environment: "preview",
          cell: "usage-notes",
        },
        usage: {
          mode: "declared-preview",
          resources: {
            tables: 1,
          },
          cost: {
            billingMode: "usage-based-preview",
            drivers: expect.arrayContaining([
              "Lambda requests and duration",
              "DynamoDB Cell data table reads and writes",
            ]),
          },
        },
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports AWS Lambda MicroVM sandbox readiness for sandbox agents", async () => {
    const rootDir = await createAgentCell({
      modelProvider: "aws-bedrock",
      sandbox: "required",
    });
    const originalCwd = process.cwd();
    const env = snapshotEnv(["ANVIL_AWS_AGENT_SANDBOX_IMAGE"]);

    try {
      delete process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE;
      process.chdir(rootDir);

      const missingImageOutput = await captureStdout(() =>
        main(["agents", "sandboxes", "--json"]),
      );
      const missingImagePayload = JSON.parse(missingImageOutput) as Record<
        string,
        unknown
      >;

      expect(missingImagePayload).toMatchObject({
        ok: true,
        provider: "aws-lambda-microvm",
        imageConfigured: false,
        sandboxes: [
          {
            mount: "support",
            agent: "support",
            supported: false,
            imageConfigured: false,
          },
        ],
        warnings: [
          {
            code: "AWS_AGENT_SANDBOX_IMAGE_REQUIRED",
          },
        ],
      });

      process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE =
        "arn:aws:lambda-microvms:eu-west-1:123:image/anvil";
      const configuredOutput = await captureStdout(() =>
        main(["agents", "validate", "--json"]),
      );
      const configuredPayload = JSON.parse(configuredOutput) as Record<
        string,
        unknown
      >;

      expect(configuredPayload).toMatchObject({
        ok: true,
        aws: {
          support: {
            supported: true,
            sandboxProvider: "aws-lambda-microvm",
          },
        },
      });
    } finally {
      process.chdir(originalCwd);
      restoreEnvSnapshot(env);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("requires explicit confirmation before destroying AWS preview stacks", async () => {
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      const output = await captureStdout(() =>
        main(["destroy", "--preview", "--app", "notes", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "CONFIRMATION_REQUIRED",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("emits AWS preview rollback dry-run intent JSON", async () => {
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      const output = await captureStdout(() =>
        main([
          "rollback",
          "--preview",
          "--app",
          "notes",
          "--to-deployment",
          "dep_previous",
          "--dry-run",
          "--json",
        ]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: true,
        schemaVersion: "0.1",
        target: {
          adapter: "aws",
          environment: "preview",
          cell: "notes",
          deploymentId: "dep_previous",
        },
        rollback: {
          mode: "dry-run",
          strategy: "redeploy-previous-artifact",
          supported: false,
          commands: [
            "anvil-cloud inspect --app notes --env preview --json",
            "anvil-cloud logs --app notes --env preview --since 10m --json",
            "anvil-cloud deploy --preview --json",
          ],
        },
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("requires an app name before destroying AWS preview stacks", async () => {
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      const output = await captureStdout(() =>
        main(["destroy", "--preview", "--yes", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("emits AWS preview destroy dry-run JSON without contacting AWS", async () => {
    const originalExitCode = process.exitCode;
    const env = snapshotEnv([
      "ANVIL_AWS_STACK_PREFIX",
      "ANVIL_AWS_DEPLOYMENT_METADATA_TABLE",
    ]);

    try {
      process.exitCode = undefined;
      process.env.ANVIL_AWS_STACK_PREFIX = "custom";
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE = "deployments";

      const output = await captureStdout(() =>
        main([
          "destroy",
          "--preview",
          "--app",
          "notes",
          "--yes",
          "--dry-run",
          "--json",
        ]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: true,
        adapter: "aws",
        cell: "notes",
        environment: "preview",
        dryRun: true,
        stackName: "custom-notes-preview",
        cleanup: {
          stack: {
            name: "custom-notes-preview",
            action: "delete",
          },
          stackOwnedBuckets: {
            action: "empty-before-delete",
          },
          deploymentMetadata: {
            action: "delete",
            table: "deployments",
            key: "deployment#notes#preview",
          },
        },
        next: ["anvil-cloud destroy --preview --app notes --yes --json"],
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = originalExitCode;
      restoreEnvSnapshot(env);
    }
  });

  it("rejects unsupported remote AWS inspect environments", async () => {
    const originalExitCode = process.exitCode;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;

    try {
      process.exitCode = undefined;
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE = "deployments";
      const output = await captureStdout(() =>
        main(["inspect", "--app", "notes", "--env", "production", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Only --env preview is supported in alpha.",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
    }
  });

  it("rejects unsupported remote AWS log environments", async () => {
    const originalExitCode = process.exitCode;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;

    try {
      process.exitCode = undefined;
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE = "deployments";
      const output = await captureStdout(() =>
        main(["logs", "--app", "notes", "--env", "production", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Only --env preview is supported in alpha.",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
    }
  });

  it("rejects invalid remote AWS log since filters", async () => {
    const originalExitCode = process.exitCode;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;

    try {
      process.exitCode = undefined;
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE = "deployments";
      const output = await captureStdout(() =>
        main([
          "logs",
          "--app",
          "notes",
          "--env",
          "preview",
          "--since",
          "last-week-ish",
          "--json",
        ]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
    }
  });

  it("rejects invalid remote AWS log limits", async () => {
    const originalExitCode = process.exitCode;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;

    try {
      process.exitCode = undefined;
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE = "deployments";
      const output = await captureStdout(() =>
        main([
          "logs",
          "--app",
          "notes",
          "--env",
          "preview",
          "--limit",
          "0",
          "--json",
        ]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Invalid --limit value. Use a positive whole number.",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
    }
  });

  it("rejects unsupported remote AWS destroy environments", async () => {
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      const output = await captureStdout(() =>
        main([
          "destroy",
          "--preview",
          "--app",
          "notes",
          "--env",
          "production",
          "--yes",
          "--json",
        ]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Only --env preview is supported in alpha.",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("rejects invalid AWS deploy wait timeouts", async () => {
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    const originalArtifactBucket = process.env.ANVIL_AWS_ARTIFACT_BUCKET;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));

    try {
      delete process.env.ANVIL_AWS_ARTIFACT_BUCKET;
      delete process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
      process.exitCode = undefined;
      process.chdir(tempDir);
      await captureStdout(() => main(["new", "notes", "--json"]));
      process.chdir(path.join(tempDir, "notes"));

      const output = await captureStdout(() =>
        main([
          "deploy",
          "--preview",
          "--wait",
          "--wait-timeout",
          "0",
          "--json",
        ]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message:
              "Invalid --wait-timeout value. Use a positive number of seconds.",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_ARTIFACT_BUCKET", originalArtifactBucket);
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("emits AWS preview workflow review gates for workflow-bearing Cells", async () => {
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    const originalArtifactBucket = process.env.ANVIL_AWS_ARTIFACT_BUCKET;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));

    try {
      delete process.env.ANVIL_AWS_ARTIFACT_BUCKET;
      delete process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
      process.exitCode = undefined;
      process.chdir(tempDir);
      await captureStdout(() =>
        main(["new", "notes", "--client", "headless", "--json"]),
      );
      await writeFile(
        path.join(tempDir, "notes", "src/cell.server.ts"),
        [
          'import { app, workflow } from "@anvil-cloud/runtime";',
          "",
          "export default app({",
          "  capabilities: { workflows: true },",
          "  workflows: {",
          "    syncNotes: workflow({",
          "      steps: [",
          "        {",
          "          name: 'fetch',",
          "          handler: async () => ({ ok: true }),",
          "        },",
          "      ],",
          "    }),",
          "  },",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );
      process.chdir(path.join(tempDir, "notes"));

      const output = await captureStdout(() =>
        main(["deploy", "--preview", "--wait", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        code: "AWS_PROVISIONER_NOT_CONFIGURED",
        plan: {
          review: {
            approvalGates: expect.arrayContaining([
              expect.objectContaining({
                id: "workflow-preview-review",
                severity: "review",
              }),
            ]),
          },
        },
      });
      expect(process.exitCode).toBe(6);
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_ARTIFACT_BUCKET", originalArtifactBucket);
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("emits AWS preview deployment plan and template JSON", async () => {
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    const originalArtifactBucket = process.env.ANVIL_AWS_ARTIFACT_BUCKET;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));

    try {
      delete process.env.ANVIL_AWS_ARTIFACT_BUCKET;
      delete process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
      process.chdir(tempDir);
      await captureStdout(() => main(["new", "notes", "--json"]));
      await writeFile(
        path.join(tempDir, "notes", "anvil.json"),
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
        path.join(tempDir, "notes", "src/cell.client.tsx"),
        "console.log('deploy fixture client');\n",
        "utf8",
      );
      const tsconfigPath = path.join(tempDir, "notes", "tsconfig.json");
      const tsconfig = JSON.parse(
        await readFile(tsconfigPath, "utf8"),
      ) as Record<string, unknown>;
      await writeFile(
        tsconfigPath,
        JSON.stringify(
          {
            ...tsconfig,
            include: ["src/cell.server.ts", "src/cell.client.tsx"],
          },
          null,
          2,
        ),
        "utf8",
      );
      process.chdir(path.join(tempDir, "notes"));

      const output = await captureStdout(() =>
        main(["deploy", "--preview", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        code: "AWS_PROVISIONER_NOT_CONFIGURED",
        plan: {
          cell: "notes",
        },
        template: {
          Resources: {
            RuntimeFunction: {
              Type: "AWS::Lambda::Function",
            },
          },
        },
      });
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_ARTIFACT_BUCKET", originalArtifactBucket);
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("waits for remote runtime health", async () => {
    const fetches: string[] = [];
    const result = await waitForRemoteRuntime("https://runtime.example.test", {
      intervalMs: 0,
      timeoutMs: 100,
      fetchImpl: async (url) => {
        fetches.push(String(url));

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    });

    expect(result).toEqual({
      ok: true,
      url: "https://runtime.example.test/_anvil/health",
      attempts: 1,
      status: 200,
    });
    expect(fetches).toEqual(["https://runtime.example.test/_anvil/health"]);
  });

  it("waits for remote runtime health when the runtime URL has a trailing slash", async () => {
    const fetches: string[] = [];
    const result = await waitForRemoteRuntime("https://runtime.example.test/", {
      intervalMs: 0,
      timeoutMs: 100,
      fetchImpl: async (url) => {
        fetches.push(String(url));

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    });

    expect(result).toEqual({
      ok: true,
      url: "https://runtime.example.test/_anvil/health",
      attempts: 1,
      status: 200,
    });
    expect(fetches).toEqual(["https://runtime.example.test/_anvil/health"]);
  });

  it("returns a stable unhealthy result when remote runtime health never passes", async () => {
    const result = await waitForRemoteRuntime("https://runtime.example.test", {
      intervalMs: 0,
      timeoutMs: 1,
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false }), {
          status: 503,
          headers: {
            "content-type": "application/json",
          },
        }),
    });

    expect(result).toMatchObject({
      ok: false,
      url: "https://runtime.example.test/_anvil/health",
      code: "AWS_RUNTIME_UNHEALTHY",
      status: 503,
    });
  });
});

describe("parseSinceOption", () => {
  it("parses relative log durations into CloudWatch start timestamps", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);

    expect(parseSinceOption("30s", now)).toBe(now - 30_000);
    expect(parseSinceOption("10m", now)).toBe(now - 10 * 60_000);
    expect(parseSinceOption("1h", now)).toBe(now - 60 * 60_000);
    expect(parseSinceOption("2d", now)).toBe(now - 2 * 24 * 60 * 60_000);
    expect(parseSinceOption("123456789", now)).toBe(123456789);
  });

  it("rejects ambiguous log since filters", () => {
    expect(parseSinceOption("yesterday")).toBeUndefined();
    expect(parseSinceOption("10fortnights")).toBeUndefined();
    expect(parseSinceOption("")).toBeUndefined();
  });
});

describe("positive option parsers", () => {
  it("parses positive numeric CLI options", () => {
    expect(parsePositiveNumberOption("1.5")).toBe(1.5);
    expect(parsePositiveIntegerOption("5")).toBe(5);
  });

  it("rejects zero, negative, non-numeric, and fractional integer options", () => {
    expect(parsePositiveNumberOption("0")).toBeUndefined();
    expect(parsePositiveNumberOption("-1")).toBeUndefined();
    expect(parsePositiveNumberOption("soon")).toBeUndefined();
    expect(parsePositiveIntegerOption("1.5")).toBeUndefined();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function snapshotEnv(names: string[]): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvSnapshot(snapshot: Map<string, string | undefined>): void {
  for (const [name, value] of snapshot) {
    restoreEnv(name, value);
  }
}

async function createManifestDiffCell(serverLines: string[]): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-manifest-"));
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );

  await mkdir(path.join(rootDir, "src"), { recursive: true });
  await mkdir(path.join(rootDir, ".anvil/generated"), { recursive: true });
  await writeFile(
    path.join(rootDir, "anvil.json"),
    JSON.stringify(
      {
        name: "notes",
        runtime: "nodejs20",
        entrypoints: {
          server: "src/cell.server.ts",
          client: "src/cell.client.tsx",
        },
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
              toPosixPath(path.join(repoRoot, "packages/runtime/src/index.ts")),
            ],
            "@anvil-cloud/client": [
              toPosixPath(path.join(repoRoot, "packages/client/src/index.ts")),
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
    serverLines.join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(rootDir, "src/cell.client.tsx"),
    "document.body.textContent = 'manifest diff';\n",
    "utf8",
  );
  await writeFile(
    path.join(rootDir, ".anvil/generated/client.ts"),
    [
      'import type { GeneratedAnvilApi } from "@anvil-cloud/client";',
      "",
      "export const api = { queries: {}, mutations: {} } as GeneratedAnvilApi;",
      "",
    ].join("\n"),
    "utf8",
  );

  return rootDir;
}

function createTestManifest(overrides: {
  queries?: string[];
  capabilities?: Record<string, unknown>;
}) {
  return {
    schemaVersion: "0.1",
    cell: {
      name: "notes",
      runtime: "nodejs20",
      target: "local",
    },
    entrypoints: {
      server: "dist/server/index.mjs",
      client: "dist/client/index.html",
    },
    client: { kind: "vite-react" },
    schema: { tables: {} },
    queries: overrides.queries ?? [],
    mutations: [],
    endpoints: [],
    jobs: [],
    workflows: [],
    services: [],
    agents: {},
    capabilities: overrides.capabilities ?? {},
  };
}

async function createAgentCell(
  options: {
    modelProvider?: "aws-bedrock" | "local";
    sandbox?: "optional" | "required";
  } = {},
): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-agent-"));
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );

  await mkdir(path.join(rootDir, "src"), { recursive: true });
  await mkdir(path.join(rootDir, ".anvil/generated"), { recursive: true });
  await writeFile(
    path.join(rootDir, "anvil.json"),
    JSON.stringify(
      {
        name: "agent-cell",
        runtime: "nodejs20",
        entrypoints: {
          server: "src/cell.server.ts",
          client: "src/cell.client.tsx",
        },
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
              toPosixPath(path.join(repoRoot, "packages/runtime/src/index.ts")),
            ],
            "@anvil-cloud/client": [
              toPosixPath(path.join(repoRoot, "packages/client/src/index.ts")),
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
    [
      'import { app, defineAgent, endpoint } from "@anvil-cloud/runtime";',
      "",
      "export default app({",
      "  agents: {",
      "    support: defineAgent({",
      "      name: 'support',",
      "      instructions: 'Stay inside declared support capabilities.',",
      `      model: { provider: '${options.modelProvider ?? "local"}', model: 'stub' },`,
      "      capabilities: { cells: ['read'], filesystem: 'none', secrets: 'none' },",
      ...(options.sandbox === undefined
        ? []
        : [`      runtime: { sandbox: '${options.sandbox}' },`]),
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
    "utf8",
  );
  await writeFile(
    path.join(rootDir, "src/cell.client.tsx"),
    "document.body.textContent = 'agent cell';\n",
    "utf8",
  );
  await writeFile(
    path.join(rootDir, ".anvil/generated/client.ts"),
    [
      'import type { GeneratedAnvilApi } from "@anvil-cloud/client";',
      "",
      "export const api = { queries: {}, mutations: {} } as GeneratedAnvilApi;",
      "",
    ].join("\n"),
    "utf8",
  );

  return rootDir;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

async function startDoctorHealthServer(
  handler: Parameters<typeof createServer>[0],
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Doctor health test server did not bind to a port.");
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = "";

  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();

    return true;
  }) as typeof process.stdout.write;

  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
  }

  return output;
}
