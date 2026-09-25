const STAGING = "staging";
const PRODUCTION = "production";

const WORKOS_ENVIRONMENT = [
  ["WORKOS_API_KEY", "WORKOS_API_KEY", ["WORKOS_API_KEY"]],
  ["WORKOS_CLIENT_ID", "WORKOS_CLIENT_ID", ["WORKOS_CLIENT_ID"]],
  ["WORKOS_COOKIE_PASSWORD", "WORKOS_COOKIE_PASSWORD", ["WORKOS_COOKIE_PASSWORD"]],
  [
    "WORKOS_REDIRECT_URI",
    "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
    ["NEXT_PUBLIC_WORKOS_REDIRECT_URI", "WORKOS_REDIRECT_URI"]
  ]
];

/** @param {NodeJS.ProcessEnv} [env] */
export function deploymentEnvironment(env = process.env) {
  const value = env.ANVIL_DEPLOYMENT_ENV;
  if (value === undefined) return STAGING;
  if (value === STAGING || value === PRODUCTION) return value;
  throw new Error('ANVIL_DEPLOYMENT_ENV must be either "staging" or "production".');
}

/**
 * Reads a variable for the selected Anvil environment. Legacy names are
 * accepted only for staging so an old staging deployment stays connected.
 * @param {string} name Scoped suffix, e.g. "BACKEND_ORIGIN".
 * @param {string} [legacyName] Existing unscoped staging variable.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function deploymentVariable(name, legacyName, env = process.env) {
  const environment = deploymentEnvironment(env);
  const scopedName = `ANVIL_${environment.toUpperCase()}_${name}`;
  const scopedValue = env[scopedName]?.trim();
  if (scopedValue) return scopedValue;
  if (environment !== STAGING || !legacyName) return undefined;
  const legacyValue = env[legacyName]?.trim();
  return legacyValue || undefined;
}

/**
 * AuthKit reads these variables when its module loads. Resolve the selected
 * values before importing AuthKit, and replace its generic SDK aliases with
 * the selected values so the SDK cannot fall back to staging configuration.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function configureWorkosEnvironment(env = process.env) {
  const environment = deploymentEnvironment(env);
  const configuredFor = env.ANVIL_WORKOS_ENV_CONFIGURED_FOR;
  if (configuredFor && configuredFor !== environment) {
    throw new Error("ANVIL_DEPLOYMENT_ENV cannot change after AuthKit environment setup.");
  }
  if (!configuredFor) {
    for (const [scopedName, legacyName] of WORKOS_ENVIRONMENT) {
      const stagingName = `ANVIL_STAGING_${scopedName}`;
      if (!env[stagingName]?.trim() && env[legacyName] !== undefined) {
        env[stagingName] = env[legacyName];
      }
    }
    env.ANVIL_WORKOS_ENV_CONFIGURED_FOR = environment;
  }

  for (const [scopedName, legacyName, sdkNames] of WORKOS_ENVIRONMENT) {
    const value = deploymentVariable(scopedName, legacyName, env);
    for (const sdkName of sdkNames) {
      if (value === undefined) delete env[sdkName];
      else env[sdkName] = value;
    }
  }
}

/**
 * Refuse a production build unless every production integration is explicitly
 * provisioned. This is intentionally independent of NODE_ENV: Vercel preview
 * builds still use the staging backend unless ANVIL_DEPLOYMENT_ENV says so.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function validateDeploymentEnvironment(env = process.env) {
  const environment = deploymentEnvironment(env);
  const configuredFor = env.ANVIL_WORKOS_ENV_CONFIGURED_FOR;
  if (configuredFor && configuredFor !== environment) {
    throw new Error("ANVIL_DEPLOYMENT_ENV does not match the configured AuthKit environment.");
  }
  if (environment !== PRODUCTION) return;

  const required = [
    "ANVIL_PRODUCTION_WORKOS_API_KEY",
    "ANVIL_PRODUCTION_WORKOS_CLIENT_ID",
    "ANVIL_PRODUCTION_WORKOS_COOKIE_PASSWORD",
    "ANVIL_PRODUCTION_WORKOS_REDIRECT_URI",
    "ANVIL_PRODUCTION_BACKEND_ORIGIN",
    "ANVIL_PRODUCTION_HOSTED_KEY_ID",
    "ANVIL_PRODUCTION_HOSTED_SERVICE_SECRET"
  ];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Production deployment is missing scoped configuration: ${missing.join(", ")}. ` +
        "Production never falls back to staging or legacy values."
    );
  }

  const workosApiKey = env.ANVIL_PRODUCTION_WORKOS_API_KEY?.trim();
  if (workosApiKey?.startsWith("sk_test_")) {
    throw new Error("ANVIL_PRODUCTION_WORKOS_API_KEY must use the WorkOS production environment.");
  }
  const cookiePassword = env.ANVIL_PRODUCTION_WORKOS_COOKIE_PASSWORD ?? "";
  if (cookiePassword.length < 32) {
    throw new Error("ANVIL_PRODUCTION_WORKOS_COOKIE_PASSWORD must contain at least 32 characters.");
  }

  const redirectUri = parseHttpsUrl("ANVIL_PRODUCTION_WORKOS_REDIRECT_URI", env);
  if (!redirectUri.pathname || redirectUri.pathname === "/" || redirectUri.search || redirectUri.hash) {
    throw new Error("ANVIL_PRODUCTION_WORKOS_REDIRECT_URI must include the AuthKit callback path.");
  }
  const backendOrigin = parseHttpsOrigin("ANVIL_PRODUCTION_BACKEND_ORIGIN", env);
  if (backendOrigin.hostname.split(".").some((label) => label.includes("staging"))) {
    throw new Error("ANVIL_PRODUCTION_BACKEND_ORIGIN must not point to a staging host.");
  }

  const keyId = env.ANVIL_PRODUCTION_HOSTED_KEY_ID ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) {
    throw new Error("ANVIL_PRODUCTION_HOSTED_KEY_ID must match ^[A-Za-z0-9_-]{1,64}$.");
  }
  const serviceSecret = env.ANVIL_PRODUCTION_HOSTED_SERVICE_SECRET ?? "";
  if (new TextEncoder().encode(serviceSecret).byteLength < 32) {
    throw new Error("ANVIL_PRODUCTION_HOSTED_SERVICE_SECRET must contain at least 32 bytes.");
  }

  assertDistinctFromStaging("WORKOS_API_KEY", "WORKOS_API_KEY", env);
  assertDistinctFromStaging("WORKOS_CLIENT_ID", "WORKOS_CLIENT_ID", env);
  assertDistinctFromStaging("WORKOS_COOKIE_PASSWORD", "WORKOS_COOKIE_PASSWORD", env);
  assertDistinctFromStaging("WORKOS_REDIRECT_URI", "NEXT_PUBLIC_WORKOS_REDIRECT_URI", env);
  assertDistinctFromStaging("BACKEND_ORIGIN", "ANVIL_BACKEND_ORIGIN", env);
  assertDistinctFromStaging("HOSTED_KEY_ID", "ANVIL_HOSTED_KEY_ID", env);
  assertDistinctFromStaging("HOSTED_SERVICE_SECRET", "ANVIL_HOSTED_SERVICE_SECRET", env);
}

/** @param {string} name @param {NodeJS.ProcessEnv} env */
function parseHttpsUrl(name, env) {
  const value = env[name]?.trim() ?? "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${name} must be a valid HTTPS URL without embedded credentials.`);
  }
  return url;
}

/** @param {string} name @param {NodeJS.ProcessEnv} env */
function parseHttpsOrigin(name, env) {
  const url = parseHttpsUrl(name, env);
  if (url.origin !== env[name]?.trim()) {
    throw new Error(`${name} must contain only an HTTPS origin, without a path or query.`);
  }
  return url;
}

/** @param {string} suffix @param {string} legacyName @param {NodeJS.ProcessEnv} env */
function assertDistinctFromStaging(suffix, legacyName, env) {
  const productionValue = env[`ANVIL_PRODUCTION_${suffix}`]?.trim();
  const configuredFor = env.ANVIL_WORKOS_ENV_CONFIGURED_FOR;
  const isSdkAlias = WORKOS_ENVIRONMENT.some(([name]) => name === suffix);
  const legacyValue = configuredFor && isSdkAlias ? undefined : env[legacyName];
  const stagingValue = env[`ANVIL_STAGING_${suffix}`]?.trim() || legacyValue?.trim();
  if (productionValue && stagingValue && productionValue === stagingValue) {
    throw new Error(`ANVIL_PRODUCTION_${suffix} must be distinct from its staging value.`);
  }
}
