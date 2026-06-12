export type AnvilSstRuntime = {
  config: typeof $config;
  interpolate: typeof $interpolate;
  sst: typeof sst;
  env: Pick<NodeJS.ProcessEnv, string>;
};

export function createAnvilSstConfig(
  runtime: AnvilSstRuntime = {
    config: $config,
    interpolate: $interpolate,
    sst,
    env: process.env
  }
) {
  const defineConfig = runtime.config;
  const interpolate = runtime.interpolate;
  const sstRuntime = runtime.sst;
  const env = runtime.env;

  return defineConfig({
    app(input?: { stage?: string }) {
      return {
        name: "anvil-registry",
        removal: input?.stage === "production" ? "retain" : "remove",
        home: "aws"
      };
    },

    async run() {
      const vpc = new sstRuntime.aws.Vpc("Vpc");
      const cluster = new sstRuntime.aws.Cluster("Cluster", { vpc });
      const bucket = new sstRuntime.aws.Bucket("PackageCache");
      const queue = new sstRuntime.aws.Queue("AnalysisQueue", {
        dlq: {
          retry: 3
        }
      });
      const upstreamNpmRegistriesJson = env.UPSTREAM_NPM_REGISTRIES_JSON ?? "";
      const upstreamRegistryAuthSecrets = upstreamRegistryAuthSecretNames(upstreamNpmRegistriesJson).map((secretName) => ({
        secretName,
        secret: new sstRuntime.Secret(secretName)
      }));
      const upstreamRegistryAuthEnvironment = Object.fromEntries(upstreamRegistryAuthSecrets.map(({ secretName, secret }) => [secretName, secret.value]));
      const upstreamRegistryAuthSecretLinks = upstreamRegistryAuthSecrets.map(({ secret }) => secret);
      const adminToken = new sstRuntime.Secret("AdminToken");
      const llmReviewApiKey = new sstRuntime.Secret("LlmReviewApiKey", "");
      const database = new sstRuntime.aws.Postgres("Database", {
        vpc,
        database: "anvil",
        username: "anvil",
        dev: {
          host: "localhost",
          port: 5432,
          database: "anvil",
          username: "anvil",
          password: "anvil"
        }
      });

      const databaseEnvironment = {
        PERSISTENCE_DRIVER: "postgres",
        DATABASE_HOST: database.host,
        DATABASE_PORT: interpolate`${database.port}`,
        DATABASE_NAME: database.database,
        DATABASE_USER: database.username,
        DATABASE_PASSWORD: database.password
      };
      const commonServiceEnvironment = {
        RUNTIME_MODE: "production",
        OBJECT_STORE_DRIVER: "s3",
        S3_BUCKET: bucket.name,
        POPULAR_PACKAGE_INDEX_OBJECT_KEY: "popular-index/npm/latest.json",
        QUEUE_DRIVER: "sqs",
        ANALYSIS_QUEUE_URL: queue.url,
        UPSTREAM_NPM_REGISTRY: "https://registry.npmjs.org",
        UPSTREAM_NPM_REGISTRIES_JSON: upstreamNpmRegistriesJson,
        NPM_DOWNLOADS_API: "https://api.npmjs.org/downloads",
        ...upstreamRegistryAuthEnvironment,
        ...databaseEnvironment
      };
      const llmReviewEnvironment = {
        LLM_REVIEW_ENABLED: env.LLM_REVIEW_ENABLED ?? "false",
        LLM_REVIEW_PROVIDER: env.LLM_REVIEW_PROVIDER ?? "",
        LLM_REVIEW_MODEL: env.LLM_REVIEW_MODEL ?? "",
        LLM_REVIEW_ENDPOINT: env.LLM_REVIEW_ENDPOINT ?? "",
        LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES: env.LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES ?? "false",
        LLM_REVIEW_RUN_ON_QUARANTINE: env.LLM_REVIEW_RUN_ON_QUARANTINE ?? "false",
        LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES: env.LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES ?? "false"
      };
      const policyEnvironment = optionalEnvironment(env, [
        "POLICY_VERSION",
        "POLICY_MINIMUM_PACKAGE_AGE_DAYS",
        "POLICY_COMPARE_PREVIOUS_VERSIONS",
        "POLICY_LOW_DOWNLOAD_THRESHOLD",
        "POLICY_STRICT_LOW_DOWNLOAD_THRESHOLD",
        "POLICY_BLOCK_SIMILAR_LOW_DOWNLOAD_PACKAGES",
        "POLICY_BLOCK_NEW_INSTALL_SCRIPTS",
        "POLICY_QUARANTINE_CHANGED_INSTALL_SCRIPTS",
        "POLICY_BLOCK_UNEXPECTED_BINARIES",
        "POLICY_QUARANTINE_OBFUSCATED_CODE",
        "POLICY_HIDE_QUARANTINED_METADATA",
        "POLICY_PROVENANCE_ENABLED",
        "POLICY_PROVENANCE_HIGH_DOWNLOAD_THRESHOLD",
        "POLICY_TRUSTED_PUBLISHING_SCORE_REDUCTION",
        "POLICY_QUARANTINE_CHANGED_PROVENANCE",
        "POLICY_QUARANTINE_MISSING_PROVENANCE_HIGH_DOWNLOAD",
        "POLICY_OVERRIDES_ENABLED",
        "POLICY_OVERRIDE_REQUIRE_REASON",
        "POLICY_OVERRIDE_DEFAULT_EXPIRY_DAYS"
      ]);
      const cloudWatchLogging = {
        retention: "1 month"
      };
      const gatewayDomain = loadBalancerDomain(env.ANVIL_GATEWAY_DOMAIN, env.ANVIL_GATEWAY_CERT_ARN);
      const adminDomain = loadBalancerDomain(env.ANVIL_ADMIN_DOMAIN, env.ANVIL_ADMIN_CERT_ARN);
      const gatewayDomainName = loadBalancerDomainName(gatewayDomain);
      const publicBaseUrl = requiredPublicBaseUrl(env.PUBLIC_BASE_URL, gatewayDomainName);
      const adminApiBaseUrl = optionalEnv(env.ANVIL_API_BASE_URL) ?? publicBaseUrl;

      new sstRuntime.aws.Task("DatabaseMigration", {
        cluster,
        image: {
          context: "../..",
          dockerfile: "packages/persistence/Dockerfile"
        },
        environment: {
          ...databaseEnvironment,
          DATABASE_READY_ATTEMPTS: "60",
          DATABASE_READY_DELAY_MS: "1000"
        },
        logging: cloudWatchLogging,
        link: [database]
      });

      const gateway = new sstRuntime.aws.Service("Gateway", {
        cluster,
        image: {
          context: "../..",
          dockerfile: "apps/gateway/Dockerfile"
        },
        loadBalancer: {
          ...(gatewayDomain ? { domain: gatewayDomain } : {}),
          rules: [{ listen: "443/https", forward: "4873/http" }],
          health: {
            "4873/http": {
              path: "/-/ready",
              successCodes: "200",
              interval: "30 seconds",
              timeout: "5 seconds",
              healthyThreshold: 2,
              unhealthyThreshold: 2
            }
          }
        },
        health: {
          command: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:4873/-/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
          startPeriod: "30 seconds",
          interval: "30 seconds",
          timeout: "5 seconds",
          retries: 3
        },
        environment: {
          ...commonServiceEnvironment,
          ...llmReviewEnvironment,
          ...policyEnvironment,
          PUBLIC_BASE_URL: publicBaseUrl,
          ANVIL_ADMIN_TOKEN: adminToken.value,
          ADMIN_TOKEN: adminToken.value
        },
        logging: cloudWatchLogging,
        link: [bucket, queue, database, adminToken, ...upstreamRegistryAuthSecretLinks]
      });

      const admin = new sstRuntime.aws.Service("Admin", {
        cluster,
        image: {
          context: "../..",
          dockerfile: "apps/admin/Dockerfile"
        },
        loadBalancer: {
          ...(adminDomain ? { domain: adminDomain } : {}),
          rules: [{ listen: "443/https", forward: "3000/http" }],
          health: {
            "3000/http": {
              path: "/-/health",
              successCodes: "200",
              interval: "30 seconds",
              timeout: "5 seconds",
              healthyThreshold: 2,
              unhealthyThreshold: 2
            }
          }
        },
        health: {
          command: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/-/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
          startPeriod: "30 seconds",
          interval: "30 seconds",
          timeout: "5 seconds",
          retries: 3
        },
        environment: {
          ...commonServiceEnvironment,
          ...llmReviewEnvironment,
          ...policyEnvironment,
          ANVIL_API_BASE_URL: adminApiBaseUrl,
          ANVIL_ADMIN_TOKEN: adminToken.value,
          ADMIN_TOKEN: adminToken.value
        },
        logging: cloudWatchLogging,
        link: [bucket, database, adminToken, ...upstreamRegistryAuthSecretLinks]
      });

      new sstRuntime.aws.Service("Worker", {
        cluster,
        image: {
          context: "../..",
          dockerfile: "apps/worker/Dockerfile"
        },
        health: {
          command: ["CMD", "node", "apps/worker/dist/index.js", "--health-check"],
          startPeriod: "30 seconds",
          interval: "30 seconds",
          timeout: "10 seconds",
          retries: 3
        },
        environment: {
          ...commonServiceEnvironment,
          ...llmReviewEnvironment,
          ...policyEnvironment,
          LLM_REVIEW_API_KEY: llmReviewApiKey.value
        },
        logging: cloudWatchLogging,
        link: [bucket, queue, database, llmReviewApiKey, ...upstreamRegistryAuthSecretLinks]
      });

      return {
        gatewayUrl: gateway.url,
        adminUrl: admin.url,
        migrationTask: "DatabaseMigration",
        databaseHost: database.host
      };
    }
  });
}

export default createAnvilSstConfig();

export function upstreamRegistryAuthSecretNames(json: string) {
  const trimmed = json.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("UPSTREAM_NPM_REGISTRIES_JSON must be valid JSON.");
  }

  if (!Array.isArray(parsed)) return [];

  return [
    ...new Set(
      parsed
        .map((entry) => (isRecord(entry) && typeof entry.authTokenSecretName === "string" ? entry.authTokenSecretName.trim() : ""))
        .filter((secretName) => secretName.length > 0)
    )
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function loadBalancerDomain(domain: string | undefined, cert: string | undefined) {
  const name = optionalEnv(domain);
  if (!name) return undefined;
  if (name.includes("://") || name.includes("/")) throw new Error("ANVIL_GATEWAY_DOMAIN and ANVIL_ADMIN_DOMAIN must be hostnames, not URLs.");

  const certArn = optionalEnv(cert);
  return certArn ? { name, dns: false, cert: certArn } : name;
}

function loadBalancerDomainName(domain: ReturnType<typeof loadBalancerDomain>) {
  if (!domain) return undefined;
  return typeof domain === "string" ? domain : domain.name;
}

function requiredPublicBaseUrl(publicBaseUrl: string | undefined, gatewayDomainName: string | undefined) {
  const explicit = optionalEnv(publicBaseUrl);
  if (explicit) return validatePublicBaseUrl(explicit);
  if (gatewayDomainName) return `https://${gatewayDomainName}`;
  throw new Error("Set PUBLIC_BASE_URL or ANVIL_GATEWAY_DOMAIN so npm tarball URLs rewrite to the deployed gateway.");
}

function validatePublicBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid https URL.");
  }
  if (url.protocol !== "https:") throw new Error("PUBLIC_BASE_URL must use https:// for SST deployments.");
  if (url.username || url.password) throw new Error("PUBLIC_BASE_URL must not include credentials.");
  return value;
}

function optionalEnv(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionalEnvironment(env: Pick<NodeJS.ProcessEnv, string>, names: string[]) {
  return Object.fromEntries(names.flatMap((name) => {
    const value = optionalEnv(env[name]);
    return value ? [[name, value]] : [];
  }));
}
