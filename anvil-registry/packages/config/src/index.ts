import { z } from "zod";
import { type PolicyConfig, runtimeModeSchema } from "@anvilstack/shared";

const booleanEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return value;
}, z.boolean());

const optionalEnvString = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().optional());

const optionalEnvUrl = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().url().optional());

const jsonEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}, z.unknown().optional());

const upstreamRegistrySchema = z
  .object({
    name: z.string().trim().min(1),
    baseUrl: z.string().url(),
    scopes: z.array(z.string().trim().regex(/^@[^/\s]+$/)).optional(),
    authToken: optionalEnvString,
    authTokenSecretName: optionalEnvString
  })
  .strict();

const envSchema = z.object({
  RUNTIME_MODE: runtimeModeSchema.default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4873),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:4873"),
  ANVIL_API_BASE_URL: optionalEnvUrl,
  UPSTREAM_NPM_REGISTRY: z.string().url().default("https://registry.npmjs.org"),
  UPSTREAM_NPM_REGISTRIES_JSON: jsonEnv.pipe(z.array(upstreamRegistrySchema).min(1).optional()),
  NPM_DOWNLOADS_API: z.string().url().default("https://api.npmjs.org/downloads"),
  NPM_METADATA_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(300),
  CACHE_DIR: z.string().default(".anvil/cache"),
  POPULAR_PACKAGE_INDEX_PATH: z.string().optional(),
  POPULAR_PACKAGE_INDEX_OBJECT_KEY: z.string().default("popular-index/npm/latest.json"),
  PERSISTENCE_DRIVER: z.enum(["memory", "postgres"]).default("memory"),
  DATABASE_URL: z.string().optional(),
  DATABASE_HOST: z.string().optional(),
  DATABASE_PORT: z.coerce.number().int().positive().default(5432),
  DATABASE_NAME: z.string().optional(),
  DATABASE_USER: z.string().optional(),
  DATABASE_PASSWORD: z.string().optional(),
  QUEUE_DRIVER: z.enum(["memory", "bullmq", "sqs"]).default("memory"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  ANALYSIS_QUEUE_NAME: z.string().default("anvil-analysis"),
  ANALYSIS_QUEUE_URL: z.string().url().optional(),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  OBJECT_STORE_DRIVER: z.enum(["file", "s3"]).default("file"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().default("anvil-package-cache"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  ANVIL_ADMIN_TOKEN: optionalEnvString,
  ADMIN_TOKEN: z.string().optional(),
  LLM_REVIEW_ENABLED: booleanEnv.default(false),
  LLM_REVIEW_PROVIDER: optionalEnvString,
  LLM_REVIEW_MODEL: optionalEnvString,
  LLM_REVIEW_ENDPOINT: optionalEnvUrl,
  LLM_REVIEW_API_KEY: optionalEnvString,
  LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES: booleanEnv.default(false),
  LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES: booleanEnv.default(false),
  LLM_REVIEW_RUN_ON_QUARANTINE: booleanEnv.default(false),
  POLICY_VERSION: z.string().default("2026-05-20.1"),
  POLICY_MINIMUM_PACKAGE_AGE_DAYS: z.coerce.number().int().min(0).default(7),
  POLICY_COMPARE_PREVIOUS_VERSIONS: z.coerce.number().int().min(0).default(3),
  POLICY_LOW_DOWNLOAD_THRESHOLD: z.coerce.number().int().min(0).default(1000),
  POLICY_STRICT_LOW_DOWNLOAD_THRESHOLD: z.coerce.number().int().min(0).default(100),
  POLICY_BLOCK_SIMILAR_LOW_DOWNLOAD_PACKAGES: booleanEnv.default(true),
  POLICY_BLOCK_NEW_INSTALL_SCRIPTS: booleanEnv.default(true),
  POLICY_QUARANTINE_CHANGED_INSTALL_SCRIPTS: booleanEnv.default(true),
  POLICY_BLOCK_UNEXPECTED_BINARIES: booleanEnv.default(true),
  POLICY_QUARANTINE_OBFUSCATED_CODE: booleanEnv.default(true),
  POLICY_HIDE_QUARANTINED_METADATA: booleanEnv.default(true),
  POLICY_PROVENANCE_ENABLED: booleanEnv.default(true),
  POLICY_PROVENANCE_HIGH_DOWNLOAD_THRESHOLD: z.coerce.number().int().min(0).default(100_000),
  POLICY_TRUSTED_PUBLISHING_SCORE_REDUCTION: z.coerce.number().int().min(0).default(10),
  POLICY_QUARANTINE_CHANGED_PROVENANCE: booleanEnv.default(true),
  POLICY_QUARANTINE_MISSING_PROVENANCE_HIGH_DOWNLOAD: booleanEnv.default(true),
  POLICY_OVERRIDES_ENABLED: booleanEnv.default(true),
  POLICY_OVERRIDE_REQUIRE_REASON: booleanEnv.default(true),
  POLICY_OVERRIDE_DEFAULT_EXPIRY_DAYS: z.coerce.number().int().min(0).default(30)
});

export type AnvilConfig = ReturnType<typeof loadConfig>;

export const defaultPolicyConfig: PolicyConfig = {
  version: "2026-05-20.1",
  minimumPackageAgeDays: 7,
  comparePreviousVersions: 3,
  lowDownloadThreshold: 1000,
  strictLowDownloadThreshold: 100,
  blockSimilarLowDownloadPackages: true,
  blockNewInstallScripts: true,
  quarantineChangedInstallScripts: true,
  blockUnexpectedBinaries: true,
  quarantineObfuscatedCode: true,
  hideQuarantinedMetadata: true,
  provenance: {
    enabled: true,
    highDownloadThreshold: 100_000,
    trustedPublishingScoreReduction: 10,
    quarantineChangedProvenance: true,
    quarantineMissingForHighDownloadPackages: true
  },
  overrides: {
    enabled: true,
    requireReason: true,
    defaultExpiryDays: 30
  },
  llmReview: {
    enabled: false,
    includePrivatePackages: false,
    runOnUnknownPackages: false,
    runOnQuarantine: false
  }
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const databaseUrl = resolveDatabaseUrl(parsed);

  return {
    ...parsed,
    ADMIN_TOKEN: parsed.ANVIL_ADMIN_TOKEN ?? parsed.ADMIN_TOKEN,
    ANVIL_API_BASE_URL: parsed.ANVIL_API_BASE_URL ?? parsed.PUBLIC_BASE_URL,
    UPSTREAM_NPM_REGISTRIES: resolveUpstreamRegistries(parsed.UPSTREAM_NPM_REGISTRIES_JSON ?? [{ name: "npmjs", baseUrl: parsed.UPSTREAM_NPM_REGISTRY }], env),
    DATABASE_URL: databaseUrl,
    policy: {
      ...defaultPolicyConfig,
      version: parsed.POLICY_VERSION,
      minimumPackageAgeDays: parsed.POLICY_MINIMUM_PACKAGE_AGE_DAYS,
      comparePreviousVersions: parsed.POLICY_COMPARE_PREVIOUS_VERSIONS,
      lowDownloadThreshold: parsed.POLICY_LOW_DOWNLOAD_THRESHOLD,
      strictLowDownloadThreshold: parsed.POLICY_STRICT_LOW_DOWNLOAD_THRESHOLD,
      blockSimilarLowDownloadPackages: parsed.POLICY_BLOCK_SIMILAR_LOW_DOWNLOAD_PACKAGES,
      blockNewInstallScripts: parsed.POLICY_BLOCK_NEW_INSTALL_SCRIPTS,
      quarantineChangedInstallScripts: parsed.POLICY_QUARANTINE_CHANGED_INSTALL_SCRIPTS,
      blockUnexpectedBinaries: parsed.POLICY_BLOCK_UNEXPECTED_BINARIES,
      quarantineObfuscatedCode: parsed.POLICY_QUARANTINE_OBFUSCATED_CODE,
      hideQuarantinedMetadata: parsed.POLICY_HIDE_QUARANTINED_METADATA,
      provenance: {
        enabled: parsed.POLICY_PROVENANCE_ENABLED,
        highDownloadThreshold: parsed.POLICY_PROVENANCE_HIGH_DOWNLOAD_THRESHOLD,
        trustedPublishingScoreReduction: parsed.POLICY_TRUSTED_PUBLISHING_SCORE_REDUCTION,
        quarantineChangedProvenance: parsed.POLICY_QUARANTINE_CHANGED_PROVENANCE,
        quarantineMissingForHighDownloadPackages: parsed.POLICY_QUARANTINE_MISSING_PROVENANCE_HIGH_DOWNLOAD
      },
      overrides: {
        enabled: parsed.POLICY_OVERRIDES_ENABLED,
        requireReason: parsed.POLICY_OVERRIDE_REQUIRE_REASON,
        defaultExpiryDays: parsed.POLICY_OVERRIDE_DEFAULT_EXPIRY_DAYS
      },
      llmReview: {
        enabled: parsed.LLM_REVIEW_ENABLED,
        includePrivatePackages: parsed.LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES,
        runOnUnknownPackages: parsed.LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES,
        runOnQuarantine: parsed.LLM_REVIEW_RUN_ON_QUARANTINE,
        provider: parsed.LLM_REVIEW_PROVIDER,
        model: parsed.LLM_REVIEW_MODEL
      }
    }
  };
}

type ParsedUpstreamRegistryConfig = z.infer<typeof upstreamRegistrySchema>;

function resolveUpstreamRegistries(registries: ParsedUpstreamRegistryConfig[], env: NodeJS.ProcessEnv) {
  return registries.map((registry) => {
    const authToken = registry.authToken ?? tokenFromSecretName(registry.authTokenSecretName, env);
    return {
      name: registry.name,
      baseUrl: registry.baseUrl,
      ...(registry.scopes ? { scopes: registry.scopes } : {}),
      ...(authToken ? { authToken } : {}),
      ...(registry.authTokenSecretName ? { authTokenSecretName: registry.authTokenSecretName } : {})
    };
  });
}

function tokenFromSecretName(secretName: string | undefined, env: NodeJS.ProcessEnv) {
  if (!secretName) return undefined;
  const value = env[secretName]?.trim();
  if (!value) throw new Error(`Upstream registry auth token secret '${secretName}' is not set.`);
  return value;
}

export function resolveDatabaseUrl(env: {
  DATABASE_URL?: string;
  DATABASE_HOST?: string;
  DATABASE_PORT?: number;
  DATABASE_NAME?: string;
  DATABASE_USER?: string;
  DATABASE_PASSWORD?: string;
}): string | undefined {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (!env.DATABASE_HOST || !env.DATABASE_NAME || !env.DATABASE_USER || env.DATABASE_PASSWORD === undefined) return undefined;

  const url = new URL("postgres://localhost");
  url.hostname = env.DATABASE_HOST;
  url.port = String(env.DATABASE_PORT ?? 5432);
  url.pathname = `/${env.DATABASE_NAME}`;
  url.username = env.DATABASE_USER;
  url.password = env.DATABASE_PASSWORD;
  return url.toString();
}
