import { describe, expect, it, vi } from "vitest";
import type { AnvilSstRuntime } from "./sst.config.js";

type RecordedResource = {
  type: string;
  name: string;
  args?: unknown;
  value?: string;
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
};

describe("SST infrastructure shape", () => {
  it("defines the registry deployment resources and service wiring", async () => {
    const resources: RecordedResource[] = [];
    const upstreamRegistriesJson = JSON.stringify([
      { name: "npmjs", baseUrl: "https://registry.npmjs.org" },
      { name: "internal", baseUrl: "https://npm.pkg.github.com", scopes: ["@internal"], authTokenSecretName: "GITHUB_NPM_TOKEN" }
    ]);
    const databaseEnvironment = {
      PERSISTENCE_DRIVER: "postgres",
      DATABASE_HOST: "database.local",
      DATABASE_PORT: "5432",
      DATABASE_NAME: "anvil",
      DATABASE_USER: "anvil",
      DATABASE_PASSWORD: "secret:DatabasePassword"
    };
    const serviceRuntimeEnvironment = {
      RUNTIME_MODE: "production",
      OBJECT_STORE_DRIVER: "s3",
      S3_BUCKET: "PackageCache",
      POPULAR_PACKAGE_INDEX_OBJECT_KEY: "popular-index/npm/latest.json",
      QUEUE_DRIVER: "sqs",
      ANALYSIS_QUEUE_URL: "https://sqs.example.test/AnalysisQueue",
      UPSTREAM_NPM_REGISTRY: "https://registry.npmjs.org",
      UPSTREAM_NPM_REGISTRIES_JSON: upstreamRegistriesJson,
      NPM_DOWNLOADS_API: "https://api.npmjs.org/downloads",
      GITHUB_NPM_TOKEN: "secret:GITHUB_NPM_TOKEN",
      ...databaseEnvironment
    };
    const llmReviewEnvironment = {
      LLM_REVIEW_ENABLED: "true",
      LLM_REVIEW_PROVIDER: "http",
      LLM_REVIEW_MODEL: "risk-reviewer",
      LLM_REVIEW_ENDPOINT: "https://llm.example.test/review",
      LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES: "true",
      LLM_REVIEW_RUN_ON_QUARANTINE: "false",
      LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES: "false"
    };
    const policyEnvironment = {
      POLICY_VERSION: "test-policy-v2",
      POLICY_MINIMUM_PACKAGE_AGE_DAYS: "3",
      POLICY_COMPARE_PREVIOUS_VERSIONS: "5",
      POLICY_LOW_DOWNLOAD_THRESHOLD: "5000",
      POLICY_STRICT_LOW_DOWNLOAD_THRESHOLD: "250",
      POLICY_BLOCK_SIMILAR_LOW_DOWNLOAD_PACKAGES: "false",
      POLICY_BLOCK_NEW_INSTALL_SCRIPTS: "false",
      POLICY_QUARANTINE_CHANGED_INSTALL_SCRIPTS: "false",
      POLICY_BLOCK_UNEXPECTED_BINARIES: "false",
      POLICY_QUARANTINE_OBFUSCATED_CODE: "false",
      POLICY_HIDE_QUARANTINED_METADATA: "false",
      POLICY_PROVENANCE_ENABLED: "false",
      POLICY_PROVENANCE_HIGH_DOWNLOAD_THRESHOLD: "200000",
      POLICY_TRUSTED_PUBLISHING_SCORE_REDUCTION: "25",
      POLICY_QUARANTINE_CHANGED_PROVENANCE: "false",
      POLICY_QUARANTINE_MISSING_PROVENANCE_HIGH_DOWNLOAD: "false",
      POLICY_OVERRIDES_ENABLED: "false",
      POLICY_OVERRIDE_REQUIRE_REASON: "false",
      POLICY_OVERRIDE_DEFAULT_EXPIRY_DAYS: "7"
    };
    const runtime = fakeRuntime(resources, {
      PUBLIC_BASE_URL: "https://npm.example.test",
      ANVIL_API_BASE_URL: "https://admin.example.test",
      LLM_REVIEW_ENABLED: "true",
      LLM_REVIEW_PROVIDER: "http",
      LLM_REVIEW_MODEL: "risk-reviewer",
      LLM_REVIEW_ENDPOINT: "https://llm.example.test/review",
      LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES: "true",
      ...policyEnvironment,
      UPSTREAM_NPM_REGISTRIES_JSON: upstreamRegistriesJson
    });

    vi.stubGlobal("$config", runtime.config);
    vi.stubGlobal("$interpolate", runtime.interpolate);
    vi.stubGlobal("sst", runtime.sst);
    const { createAnvilSstConfig, upstreamRegistryAuthSecretNames } = await import("./sst.config.js");

    expect(upstreamRegistryAuthSecretNames(JSON.stringify([{ authTokenSecretName: "A" }, { authTokenSecretName: "A" }, { authTokenSecretName: "B" }]))).toEqual(["A", "B"]);
    expect(() => upstreamRegistryAuthSecretNames("{nope")).toThrow("UPSTREAM_NPM_REGISTRIES_JSON must be valid JSON.");

    const config = createAnvilSstConfig(runtime) as { app(input?: { stage?: string }): unknown; run(): Promise<Record<string, unknown>> };
    expect(config.app({ stage: "production" })).toEqual({ name: "anvil-registry", removal: "retain", home: "aws" });
    expect(config.app({ stage: "preview" })).toEqual({ name: "anvil-registry", removal: "remove", home: "aws" });

    const outputs = await config.run();

    expect(outputs).toMatchObject({
      gatewayUrl: "https://gateway.example.test",
      adminUrl: "https://admin.example.test",
      migrationTask: "DatabaseMigration",
      databaseHost: "database.local"
    });
    expect(resource(resources, "Vpc", "Vpc")).toBeDefined();
    expect(resource(resources, "Cluster", "Cluster")?.args).toMatchObject({ vpc: expect.objectContaining({ type: "Vpc" }) });
    expect(resource(resources, "Bucket", "PackageCache")).toBeDefined();
    expect(resource(resources, "Queue", "AnalysisQueue")?.args).toMatchObject({ dlq: { retry: 3 } });
    expect(resource(resources, "Postgres", "Database")?.args).toMatchObject({ database: "anvil", username: "anvil" });
    expect(resources.filter((entry) => entry.type === "Secret").map((entry) => entry.name).sort()).toEqual(["AdminToken", "GITHUB_NPM_TOKEN", "LlmReviewApiKey"]);

    const migration = resource(resources, "Task", "DatabaseMigration");
    expect(migration?.args).toMatchObject({
      image: { context: "../..", dockerfile: "packages/persistence/Dockerfile" },
      environment: expect.objectContaining({
        ...databaseEnvironment,
        DATABASE_READY_ATTEMPTS: "60",
        DATABASE_READY_DELAY_MS: "1000"
      }),
      logging: { retention: "1 month" },
      link: [expect.objectContaining({ type: "Postgres", name: "Database" })]
    });

    const gateway = resource(resources, "Service", "Gateway");
    expect(gateway?.args).toMatchObject({
      image: { context: "../..", dockerfile: "apps/gateway/Dockerfile" },
      loadBalancer: {
        rules: [{ listen: "443/https", forward: "4873/http" }],
        health: { "4873/http": expect.objectContaining({ path: "/-/ready" }) }
      },
      health: expect.objectContaining({ command: expect.arrayContaining(["CMD-SHELL"]) }),
      environment: expect.objectContaining({
        ...serviceRuntimeEnvironment,
        ...llmReviewEnvironment,
        ...policyEnvironment,
        PUBLIC_BASE_URL: "https://npm.example.test",
        ANVIL_ADMIN_TOKEN: "secret:AdminToken",
        ADMIN_TOKEN: "secret:AdminToken"
      }),
      logging: { retention: "1 month" },
      link: expect.arrayContaining([
        expect.objectContaining({ type: "Bucket", name: "PackageCache" }),
        expect.objectContaining({ type: "Queue", name: "AnalysisQueue" }),
        expect.objectContaining({ type: "Postgres", name: "Database" }),
        expect.objectContaining({ type: "Secret", name: "AdminToken" }),
        expect.objectContaining({ type: "Secret", name: "GITHUB_NPM_TOKEN" })
      ])
    });
    expect((gateway?.args as { environment: Record<string, unknown> }).environment.LLM_REVIEW_API_KEY).toBeUndefined();

    const admin = resource(resources, "Service", "Admin");
    expect(admin?.args).toMatchObject({
      image: { context: "../..", dockerfile: "apps/admin/Dockerfile" },
      loadBalancer: { health: { "3000/http": expect.objectContaining({ path: "/-/health" }) } },
      environment: expect.objectContaining({
        ...serviceRuntimeEnvironment,
        ...llmReviewEnvironment,
        ...policyEnvironment,
        ANVIL_API_BASE_URL: "https://admin.example.test",
        ANVIL_ADMIN_TOKEN: "secret:AdminToken",
        ADMIN_TOKEN: "secret:AdminToken"
      }),
      logging: { retention: "1 month" },
      link: expect.arrayContaining([
        expect.objectContaining({ type: "Bucket", name: "PackageCache" }),
        expect.objectContaining({ type: "Postgres", name: "Database" }),
        expect.objectContaining({ type: "Secret", name: "AdminToken" })
      ])
    });
    expect((admin?.args as { environment: Record<string, unknown> }).environment.LLM_REVIEW_API_KEY).toBeUndefined();

    const worker = resource(resources, "Service", "Worker");
    expect(worker?.args).toMatchObject({
      image: { context: "../..", dockerfile: "apps/worker/Dockerfile" },
      health: expect.objectContaining({ command: ["CMD", "node", "apps/worker/dist/index.js", "--health-check"] }),
      environment: expect.objectContaining({
        ...serviceRuntimeEnvironment,
        ...llmReviewEnvironment,
        ...policyEnvironment,
        LLM_REVIEW_API_KEY: "secret:LlmReviewApiKey"
      }),
      logging: { retention: "1 month" },
      link: expect.arrayContaining([
        expect.objectContaining({ type: "Bucket", name: "PackageCache" }),
        expect.objectContaining({ type: "Queue", name: "AnalysisQueue" }),
        expect.objectContaining({ type: "Postgres", name: "Database" }),
        expect.objectContaining({ type: "Secret", name: "LlmReviewApiKey" })
      ])
    });
  });

  it("wires optional custom load-balancer domains and certificate ARNs", async () => {
    const resources: RecordedResource[] = [];
    const runtime = fakeRuntime(resources, {
      ANVIL_GATEWAY_DOMAIN: "npm.example.test",
      ANVIL_GATEWAY_CERT_ARN: "arn:aws:acm:eu-west-2:111122223333:certificate/gateway",
      ANVIL_ADMIN_DOMAIN: "admin.example.test",
      ANVIL_ADMIN_CERT_ARN: " "
    });
    const { createAnvilSstConfig } = await import("./sst.config.js");

    const config = createAnvilSstConfig(runtime) as { run(): Promise<Record<string, unknown>> };
    await config.run();

    const gateway = resource(resources, "Service", "Gateway");
    expect(gateway?.args).toMatchObject({
      loadBalancer: {
        domain: {
          name: "npm.example.test",
          dns: false,
          cert: "arn:aws:acm:eu-west-2:111122223333:certificate/gateway"
        }
      },
      environment: expect.objectContaining({
        PUBLIC_BASE_URL: "https://npm.example.test"
      })
    });

    const admin = resource(resources, "Service", "Admin");
    expect(admin?.args).toMatchObject({
      loadBalancer: {
        domain: "admin.example.test"
      },
      environment: expect.objectContaining({
        ANVIL_API_BASE_URL: "https://npm.example.test"
      })
    });
  });

  it("requires a public gateway URL for deployed tarball rewrites", async () => {
    const resources: RecordedResource[] = [];
    const runtime = fakeRuntime(resources, {});
    const { createAnvilSstConfig } = await import("./sst.config.js");

    const config = createAnvilSstConfig(runtime) as { run(): Promise<Record<string, unknown>> };

    await expect(config.run()).rejects.toThrow("Set PUBLIC_BASE_URL or ANVIL_GATEWAY_DOMAIN");
  });

  it("rejects invalid deployed gateway URL settings before creating services", async () => {
    const { createAnvilSstConfig } = await import("./sst.config.js");

    await expect((createAnvilSstConfig(fakeRuntime([], { PUBLIC_BASE_URL: "http://npm.example.test" })) as { run(): Promise<Record<string, unknown>> }).run()).rejects.toThrow(
      "PUBLIC_BASE_URL must use https://"
    );
    await expect((createAnvilSstConfig(fakeRuntime([], { PUBLIC_BASE_URL: "https://token@npm.example.test" })) as { run(): Promise<Record<string, unknown>> }).run()).rejects.toThrow(
      "PUBLIC_BASE_URL must not include credentials"
    );
    await expect((createAnvilSstConfig(fakeRuntime([], { ANVIL_GATEWAY_DOMAIN: "https://npm.example.test" })) as { run(): Promise<Record<string, unknown>> }).run()).rejects.toThrow(
      "must be hostnames, not URLs"
    );
  });
});

function fakeRuntime(resources: RecordedResource[], env: Record<string, string>): AnvilSstRuntime {
  return {
    config: (config: unknown) => config,
    interpolate: (strings: TemplateStringsArray, ...values: unknown[]) => strings.reduce((text, chunk, index) => `${text}${chunk}${values[index] ?? ""}`, ""),
    sst: {
      Secret: class {
        constructor(name: string, placeholder?: string) {
          return record(resources, { type: "Secret", name, args: { placeholder }, value: `secret:${name}` });
        }
      },
      aws: {
        Vpc: class {
          constructor(name: string, args?: unknown) {
            return record(resources, { type: "Vpc", name, args });
          }
        },
        Cluster: class {
          constructor(name: string, args?: unknown) {
            return record(resources, { type: "Cluster", name, args });
          }
        },
        Bucket: class {
          constructor(name: string, args?: unknown) {
            return record(resources, { type: "Bucket", name, args, value: name, url: `s3://${name}` });
          }
        },
        Queue: class {
          constructor(name: string, args?: unknown) {
            return record(resources, { type: "Queue", name, args, url: `https://sqs.example.test/${name}` });
          }
        },
        Postgres: class {
          constructor(name: string, args?: unknown) {
            return record(resources, {
              type: "Postgres",
              name,
              args,
              host: "database.local",
              port: 5432,
              database: "anvil",
              username: "anvil",
              password: "secret:DatabasePassword"
            });
          }
        },
        Task: class {
          constructor(name: string, args?: unknown) {
            return record(resources, { type: "Task", name, args });
          }
        },
        Service: class {
          constructor(name: string, args?: unknown) {
            return record(resources, { type: "Service", name, args, url: `https://${name.toLowerCase()}.example.test` });
          }
        }
      }
    },
    env
  };
}

function record<T extends RecordedResource>(resources: RecordedResource[], resource: T): T {
  resources.push(resource);
  return resource;
}

function resource(resources: RecordedResource[], type: string, name: string) {
  return resources.find((entry) => entry.type === type && entry.name === name);
}
