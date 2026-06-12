import { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import { loadConfig, resolveDatabaseUrl } from "./index.js";

describe("config", () => {
  it("prefers explicit DATABASE_URL", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://explicit.example/anvil" })).toBe("postgres://explicit.example/anvil");
  });

  it("builds a Postgres URL from discrete database environment values", () => {
    expect(
      resolveDatabaseUrl({
        DATABASE_HOST: "db.example.test",
        DATABASE_PORT: 5433,
        DATABASE_NAME: "anvil",
        DATABASE_USER: "anvil",
        DATABASE_PASSWORD: "p@ss word"
      })
    ).toBe("postgres://anvil:p%40ss%20word@db.example.test:5433/anvil");
  });

  it("loads SQS and database settings together for AWS services", () => {
    const config = loadConfig({
      ...process.env,
      PERSISTENCE_DRIVER: "postgres",
      DATABASE_HOST: "db.example.test",
      DATABASE_NAME: "anvil",
      DATABASE_USER: "anvil",
      DATABASE_PASSWORD: "secret",
      QUEUE_DRIVER: "sqs",
      ANALYSIS_QUEUE_URL: "https://sqs.example.test/queue"
    });

    expect(config.DATABASE_URL).toBe("postgres://anvil:secret@db.example.test:5432/anvil");
    expect(config.QUEUE_DRIVER).toBe("sqs");
  });

  it("loads the internal gateway API base URL for admin actions", () => {
    const config = loadConfig({
      ...process.env,
      ANVIL_API_BASE_URL: "http://gateway:4873"
    });

    expect(config.ANVIL_API_BASE_URL).toBe("http://gateway:4873");
  });

  it("prefers ANVIL_ADMIN_TOKEN over the legacy ADMIN_TOKEN", () => {
    const config = loadConfig({
      ...process.env,
      ANVIL_ADMIN_TOKEN: "anvil-secret",
      ADMIN_TOKEN: "legacy-secret"
    });

    expect(config.ADMIN_TOKEN).toBe("anvil-secret");
  });

  it("loads the npm metadata cache TTL", () => {
    const config = loadConfig({
      ...process.env,
      NPM_METADATA_CACHE_TTL_SECONDS: "60"
    });

    expect(config.NPM_METADATA_CACHE_TTL_SECONDS).toBe(60);
  });

  it("defaults upstream registry routing to npmjs", () => {
    const config = loadConfig({
      ...process.env,
      UPSTREAM_NPM_REGISTRY: "https://registry.example.test"
    });

    expect(config.UPSTREAM_NPM_REGISTRIES).toEqual([{ name: "npmjs", baseUrl: "https://registry.example.test" }]);
  });

  it("loads scoped upstream registries from JSON", () => {
    const config = loadConfig({
      ...process.env,
      UPSTREAM_NPM_REGISTRIES_JSON: JSON.stringify([
        { name: "npmjs", baseUrl: "https://registry.npmjs.org" },
        { name: "internal", baseUrl: "https://npm.pkg.example.test", scopes: ["@internal"], authToken: "secret-token" }
      ])
    });

    expect(config.UPSTREAM_NPM_REGISTRIES).toEqual([
      { name: "npmjs", baseUrl: "https://registry.npmjs.org" },
      { name: "internal", baseUrl: "https://npm.pkg.example.test", scopes: ["@internal"], authToken: "secret-token" }
    ]);
  });

  it("resolves scoped upstream registry tokens from named environment secrets", () => {
    const config = loadConfig({
      ...process.env,
      INTERNAL_NPM_TOKEN: "secret-from-env",
      UPSTREAM_NPM_REGISTRIES_JSON: JSON.stringify([
        { name: "npmjs", baseUrl: "https://registry.npmjs.org" },
        { name: "internal", baseUrl: "https://npm.pkg.example.test", scopes: ["@internal"], authTokenSecretName: "INTERNAL_NPM_TOKEN" }
      ])
    });

    expect(config.UPSTREAM_NPM_REGISTRIES).toEqual([
      { name: "npmjs", baseUrl: "https://registry.npmjs.org" },
      {
        name: "internal",
        baseUrl: "https://npm.pkg.example.test",
        scopes: ["@internal"],
        authToken: "secret-from-env",
        authTokenSecretName: "INTERNAL_NPM_TOKEN"
      }
    ]);
  });

  it("fails when a configured upstream registry token secret is missing", () => {
    expect(() =>
      loadConfig({
        ...process.env,
        UPSTREAM_NPM_REGISTRIES_JSON: JSON.stringify([
          { name: "npmjs", baseUrl: "https://registry.npmjs.org" },
          { name: "internal", baseUrl: "https://npm.pkg.example.test", scopes: ["@internal"], authTokenSecretName: "MISSING_INTERNAL_NPM_TOKEN" }
        ])
      })
    ).toThrow("Upstream registry auth token secret 'MISSING_INTERNAL_NPM_TOKEN' is not set.");
  });

  it("reports malformed upstream registry JSON as a config validation error", () => {
    expect(() =>
      loadConfig({
        ...process.env,
        UPSTREAM_NPM_REGISTRIES_JSON: "{"
      })
    ).toThrow(ZodError);
  });

  it("defaults the admin API base URL to the public base URL", () => {
    const config = loadConfig({
      ...process.env,
      PUBLIC_BASE_URL: "https://npm.example.test"
    });

    expect(config.ANVIL_API_BASE_URL).toBe("https://npm.example.test");
  });

  it("loads the optional popular package index path", () => {
    const config = loadConfig({
      ...process.env,
      POPULAR_PACKAGE_INDEX_PATH: "/etc/anvil/popular-index/npm/latest.json",
      POPULAR_PACKAGE_INDEX_OBJECT_KEY: "popular-index/npm/2026-05-20.json"
    });

    expect(config.POPULAR_PACKAGE_INDEX_PATH).toBe("/etc/anvil/popular-index/npm/latest.json");
    expect(config.POPULAR_PACKAGE_INDEX_OBJECT_KEY).toBe("popular-index/npm/2026-05-20.json");
  });

  it("loads LLM review policy from environment flags", () => {
    const config = loadConfig({
      ...process.env,
      LLM_REVIEW_ENABLED: "true",
      LLM_REVIEW_PROVIDER: "http",
      LLM_REVIEW_MODEL: "risk-reviewer",
      LLM_REVIEW_ENDPOINT: "https://llm.example.test/review",
      LLM_REVIEW_API_KEY: "secret",
      LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES: "true",
      LLM_REVIEW_RUN_ON_QUARANTINE: "true",
      LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES: "false"
    });

    expect(config.policy.llmReview).toEqual({
      enabled: true,
      includePrivatePackages: false,
      runOnUnknownPackages: true,
      runOnQuarantine: true,
      provider: "http",
      model: "risk-reviewer"
    });
    expect(config.LLM_REVIEW_ENDPOINT).toBe("https://llm.example.test/review");
    expect(config.LLM_REVIEW_API_KEY).toBe("secret");
  });

  it("loads deterministic policy controls from environment flags", () => {
    const config = loadConfig({
      ...process.env,
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
    });

    expect(config.policy).toMatchObject({
      version: "test-policy-v2",
      minimumPackageAgeDays: 3,
      comparePreviousVersions: 5,
      lowDownloadThreshold: 5000,
      strictLowDownloadThreshold: 250,
      blockSimilarLowDownloadPackages: false,
      blockNewInstallScripts: false,
      quarantineChangedInstallScripts: false,
      blockUnexpectedBinaries: false,
      quarantineObfuscatedCode: false,
      hideQuarantinedMetadata: false,
      provenance: {
        enabled: false,
        highDownloadThreshold: 200000,
        trustedPublishingScoreReduction: 25,
        quarantineChangedProvenance: false,
        quarantineMissingForHighDownloadPackages: false
      },
      overrides: {
        enabled: false,
        requireReason: false,
        defaultExpiryDays: 7
      }
    });
  });

  it("treats empty optional LLM provider environment values as unset", () => {
    const config = loadConfig({
      ...process.env,
      LLM_REVIEW_ENABLED: "false",
      LLM_REVIEW_PROVIDER: "",
      LLM_REVIEW_MODEL: " ",
      LLM_REVIEW_ENDPOINT: "",
      LLM_REVIEW_API_KEY: ""
    });

    expect(config.policy.llmReview.provider).toBeUndefined();
    expect(config.policy.llmReview.model).toBeUndefined();
    expect(config.LLM_REVIEW_ENDPOINT).toBeUndefined();
    expect(config.LLM_REVIEW_API_KEY).toBeUndefined();
  });
});
