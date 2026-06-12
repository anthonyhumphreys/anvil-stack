type PreflightIssue = {
  code: string;
  message: string;
};

type PreflightResult = {
  ok: boolean;
  errors: PreflightIssue[];
  warnings: PreflightIssue[];
  derived: {
    publicBaseUrl?: string;
    adminApiBaseUrl?: string;
  };
};

const placeholderHosts = new Set(["example.com", "example.test", "localhost", "127.0.0.1", "::1"]);
const booleanPolicyEnvNames = [
  "POLICY_BLOCK_SIMILAR_LOW_DOWNLOAD_PACKAGES",
  "POLICY_BLOCK_NEW_INSTALL_SCRIPTS",
  "POLICY_QUARANTINE_CHANGED_INSTALL_SCRIPTS",
  "POLICY_BLOCK_UNEXPECTED_BINARIES",
  "POLICY_QUARANTINE_OBFUSCATED_CODE",
  "POLICY_HIDE_QUARANTINED_METADATA",
  "POLICY_PROVENANCE_ENABLED",
  "POLICY_QUARANTINE_CHANGED_PROVENANCE",
  "POLICY_QUARANTINE_MISSING_PROVENANCE_HIGH_DOWNLOAD",
  "POLICY_OVERRIDES_ENABLED",
  "POLICY_OVERRIDE_REQUIRE_REASON"
];
const nonNegativeIntegerPolicyEnvNames = [
  "POLICY_MINIMUM_PACKAGE_AGE_DAYS",
  "POLICY_COMPARE_PREVIOUS_VERSIONS",
  "POLICY_LOW_DOWNLOAD_THRESHOLD",
  "POLICY_STRICT_LOW_DOWNLOAD_THRESHOLD",
  "POLICY_PROVENANCE_HIGH_DOWNLOAD_THRESHOLD",
  "POLICY_TRUSTED_PUBLISHING_SCORE_REDUCTION",
  "POLICY_OVERRIDE_DEFAULT_EXPIRY_DAYS"
];

export function validateSstDeployPreflight(env: NodeJS.ProcessEnv = process.env): PreflightResult {
  const errors: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];

  const gatewayDomain = optionalEnv(env.ANVIL_GATEWAY_DOMAIN);
  const adminDomain = optionalEnv(env.ANVIL_ADMIN_DOMAIN);
  const publicBaseUrl = optionalEnv(env.PUBLIC_BASE_URL);
  const adminApiBaseUrl = optionalEnv(env.ANVIL_API_BASE_URL);
  const gatewayCertArn = optionalEnv(env.ANVIL_GATEWAY_CERT_ARN);
  const adminCertArn = optionalEnv(env.ANVIL_ADMIN_CERT_ARN);

  if (!publicBaseUrl && !gatewayDomain) {
    errors.push(issue("PUBLIC_BASE_URL_REQUIRED", "Set PUBLIC_BASE_URL or ANVIL_GATEWAY_DOMAIN before deploying SST."));
  }

  validateDomain("ANVIL_GATEWAY_DOMAIN", gatewayDomain, errors);
  validateDomain("ANVIL_ADMIN_DOMAIN", adminDomain, errors);
  if (gatewayCertArn && !gatewayDomain) errors.push(issue("GATEWAY_CERT_WITHOUT_DOMAIN", "ANVIL_GATEWAY_CERT_ARN requires ANVIL_GATEWAY_DOMAIN."));
  if (adminCertArn && !adminDomain) errors.push(issue("ADMIN_CERT_WITHOUT_DOMAIN", "ANVIL_ADMIN_CERT_ARN requires ANVIL_ADMIN_DOMAIN."));

  const resolvedPublicBaseUrl = publicBaseUrl ?? (gatewayDomain ? `https://${gatewayDomain}` : undefined);
  validateHttpsUrl("PUBLIC_BASE_URL", resolvedPublicBaseUrl, errors);

  if (resolvedPublicBaseUrl) {
    validateDeployHost("PUBLIC_BASE_URL", resolvedPublicBaseUrl, errors);
  }

  if (adminApiBaseUrl) {
    validateHttpsUrl("ANVIL_API_BASE_URL", adminApiBaseUrl, errors);
    validateDeployHost("ANVIL_API_BASE_URL", adminApiBaseUrl, errors);
  }

  validateUpstreamRegistryJson(env.UPSTREAM_NPM_REGISTRIES_JSON, errors, warnings);
  validateLlmReview(env, errors, warnings);
  validatePolicyEnvironment(env, errors);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    derived: {
      publicBaseUrl: resolvedPublicBaseUrl,
      adminApiBaseUrl: adminApiBaseUrl ?? resolvedPublicBaseUrl
    }
  };
}

function validateDomain(name: string, value: string | undefined, errors: PreflightIssue[]) {
  if (!value) return;
  if (value.includes("://")) {
    errors.push(issue(`${name}_PROTOCOL`, `${name} must be a hostname, not a URL. Use PUBLIC_BASE_URL for a full URL.`));
    return;
  }
  if (value.includes("/")) {
    errors.push(issue(`${name}_PATH`, `${name} must not include a path.`));
  }
}

function validateHttpsUrl(name: string, value: string | undefined, errors: PreflightIssue[]) {
  if (!value) return;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    errors.push(issue(`${name}_INVALID`, `${name} must be a valid URL.`));
    return;
  }

  if (url.protocol !== "https:") {
    errors.push(issue(`${name}_HTTPS_REQUIRED`, `${name} must use https:// for SST deployments.`));
  }
  if (url.username || url.password) {
    errors.push(issue(`${name}_CREDENTIALS`, `${name} must not include credentials.`));
  }
}

function validateDeployHost(name: string, value: string, errors: PreflightIssue[]) {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return;
  }

  if (placeholderHosts.has(host) || host.endsWith(".example") || host.endsWith(".example.com")) {
    errors.push(issue(`${name}_PLACEHOLDER`, `${name} points at ${host}; set the real deployed gateway host.`));
  }
}

function validateUpstreamRegistryJson(value: string | undefined, errors: PreflightIssue[], warnings: PreflightIssue[]) {
  const json = optionalEnv(value);
  if (!json) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    errors.push(issue("UPSTREAM_REGISTRIES_JSON_INVALID", "UPSTREAM_NPM_REGISTRIES_JSON must be valid JSON."));
    return;
  }

  if (!Array.isArray(parsed)) {
    errors.push(issue("UPSTREAM_REGISTRIES_JSON_ARRAY", "UPSTREAM_NPM_REGISTRIES_JSON must be an array."));
    return;
  }

  for (const [index, entry] of parsed.entries()) {
    if (!isRecord(entry)) {
      errors.push(issue("UPSTREAM_REGISTRY_ENTRY_OBJECT", `UPSTREAM_NPM_REGISTRIES_JSON[${index}] must be an object.`));
      continue;
    }

    const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl : "";
    if (!baseUrl) {
      errors.push(issue("UPSTREAM_REGISTRY_BASE_URL_REQUIRED", `UPSTREAM_NPM_REGISTRIES_JSON[${index}].baseUrl is required.`));
    } else {
      validateHttpsUrl(`UPSTREAM_NPM_REGISTRIES_JSON[${index}].baseUrl`, baseUrl, errors);
    }

    if (typeof entry.authToken === "string" && entry.authToken.trim()) {
      warnings.push(issue("UPSTREAM_REGISTRY_INLINE_TOKEN", `UPSTREAM_NPM_REGISTRIES_JSON[${index}] uses inline authToken; deployed SST config should prefer authTokenSecretName.`));
    }
  }
}

function validateLlmReview(env: NodeJS.ProcessEnv, errors: PreflightIssue[], warnings: PreflightIssue[]) {
  if (!isTruthy(env.LLM_REVIEW_ENABLED)) return;

  if (!optionalEnv(env.LLM_REVIEW_PROVIDER)) errors.push(issue("LLM_REVIEW_PROVIDER_REQUIRED", "LLM_REVIEW_PROVIDER is required when LLM_REVIEW_ENABLED=true."));
  if (!optionalEnv(env.LLM_REVIEW_MODEL)) warnings.push(issue("LLM_REVIEW_MODEL_EMPTY", "LLM_REVIEW_MODEL is empty; reviews will be harder to audit."));

  const endpoint = optionalEnv(env.LLM_REVIEW_ENDPOINT);
  if (!endpoint) {
    errors.push(issue("LLM_REVIEW_ENDPOINT_REQUIRED", "LLM_REVIEW_ENDPOINT is required when LLM_REVIEW_ENABLED=true."));
  } else {
    validateHttpsUrl("LLM_REVIEW_ENDPOINT", endpoint, errors);
  }
}

function validatePolicyEnvironment(env: NodeJS.ProcessEnv, errors: PreflightIssue[]) {
  for (const name of booleanPolicyEnvNames) {
    const value = optionalEnv(env[name]);
    if (value && !isBooleanString(value)) {
      errors.push(issue(`${name}_INVALID`, `${name} must be a boolean value: true, false, 1, 0, yes, no, on, or off.`));
    }
  }

  for (const name of nonNegativeIntegerPolicyEnvNames) {
    const value = optionalEnv(env[name]);
    if (value && !isNonNegativeInteger(value)) {
      errors.push(issue(`${name}_INVALID`, `${name} must be a non-negative integer.`));
    }
  }
}

function isTruthy(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function isBooleanString(value: string) {
  return ["1", "true", "yes", "on", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function isNonNegativeInteger(value: string) {
  if (!/^\d+$/.test(value.trim())) return false;
  return Number.isSafeInteger(Number(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalEnv(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function issue(code: string, message: string): PreflightIssue {
  return { code, message };
}

function printResult(result: PreflightResult) {
  if (result.ok) {
    console.log("SST deploy preflight passed.");
    if (result.derived.publicBaseUrl) console.log(`PUBLIC_BASE_URL=${result.derived.publicBaseUrl}`);
    if (result.derived.adminApiBaseUrl) console.log(`ANVIL_API_BASE_URL=${result.derived.adminApiBaseUrl}`);
  } else {
    console.error("SST deploy preflight failed.");
  }

  for (const warning of result.warnings) console.warn(`warning ${warning.code}: ${warning.message}`);
  for (const error of result.errors) console.error(`error ${error.code}: ${error.message}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = validateSstDeployPreflight();
  printResult(result);
  if (!result.ok) process.exitCode = 1;
}
