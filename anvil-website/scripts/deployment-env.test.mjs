import assert from "node:assert/strict";
import test from "node:test";

import {
  configureWorkosEnvironment,
  deploymentEnvironment,
  deploymentVariable,
  validateDeploymentEnvironment
} from "../lib/deployment-env.js";

function productionEnvironment(overrides = {}) {
  return {
    ANVIL_DEPLOYMENT_ENV: "production",
    ANVIL_PRODUCTION_WORKOS_API_KEY: "sk_live_production",
    ANVIL_PRODUCTION_WORKOS_CLIENT_ID: "client_production",
    ANVIL_PRODUCTION_WORKOS_COOKIE_PASSWORD: "production-cookie-password-at-least-32",
    ANVIL_PRODUCTION_WORKOS_REDIRECT_URI: "https://anvil.dev/auth/callback",
    ANVIL_PRODUCTION_BACKEND_ORIGIN: "https://sync.anvil.dev",
    ANVIL_PRODUCTION_HOSTED_KEY_ID: "prod_key_id",
    ANVIL_PRODUCTION_HOSTED_SERVICE_SECRET: "production-service-secret-at-least-32-bytes",
    ...overrides
  };
}

test("defaults to staging and accepts the existing unscoped staging variables", () => {
  const env = { WORKOS_API_KEY: "sk_test_legacy" };

  assert.equal(deploymentEnvironment(env), "staging");
  assert.equal(deploymentVariable("WORKOS_API_KEY", "WORKOS_API_KEY", env), "sk_test_legacy");
});

test("staging scoped variables take precedence over legacy values", () => {
  const env = {
    ANVIL_DEPLOYMENT_ENV: "staging",
    ANVIL_STAGING_WORKOS_API_KEY: "sk_test_scoped",
    WORKOS_API_KEY: "sk_test_legacy"
  };

  assert.equal(deploymentVariable("WORKOS_API_KEY", "WORKOS_API_KEY", env), "sk_test_scoped");
});

test("production never falls back to staging or unscoped values", () => {
  const env = {
    ANVIL_DEPLOYMENT_ENV: "production",
    ANVIL_STAGING_WORKOS_API_KEY: "sk_test_staging",
    WORKOS_API_KEY: "sk_test_legacy",
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: "http://localhost:3000/auth/callback",
    WORKOS_REDIRECT_URI: "http://localhost:3000/auth/callback"
  };

  assert.equal(deploymentVariable("WORKOS_API_KEY", "WORKOS_API_KEY", env), undefined);
  configureWorkosEnvironment(env);
  assert.equal(env.WORKOS_API_KEY, undefined);
  assert.equal(env.NEXT_PUBLIC_WORKOS_REDIRECT_URI, undefined);
  assert.equal(env.WORKOS_REDIRECT_URI, undefined);
});

test("rejects an unknown deployment environment", () => {
  assert.throws(() => deploymentEnvironment({ ANVIL_DEPLOYMENT_ENV: "preview" }), {
    message: /ANVIL_DEPLOYMENT_ENV must be either "staging" or "production"/
  });
});

test("production aliases are selected before SDK import and validation remains stable", () => {
  const env = productionEnvironment({
    WORKOS_API_KEY: "sk_test_staging",
    WORKOS_CLIENT_ID: "client_staging",
    WORKOS_COOKIE_PASSWORD: "staging-cookie-password-at-least-32",
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://staging.anvil.dev/auth/callback",
    ANVIL_BACKEND_ORIGIN: "https://staging-sync.anvil.dev",
    ANVIL_HOSTED_KEY_ID: "stage_key_id",
    ANVIL_HOSTED_SERVICE_SECRET: "staging-service-secret-at-least-32-bytes"
  });

  configureWorkosEnvironment(env);

  assert.equal(env.WORKOS_API_KEY, env.ANVIL_PRODUCTION_WORKOS_API_KEY);
  assert.equal(env.WORKOS_CLIENT_ID, env.ANVIL_PRODUCTION_WORKOS_CLIENT_ID);
  assert.equal(env.WORKOS_COOKIE_PASSWORD, env.ANVIL_PRODUCTION_WORKOS_COOKIE_PASSWORD);
  assert.equal(env.NEXT_PUBLIC_WORKOS_REDIRECT_URI, env.ANVIL_PRODUCTION_WORKOS_REDIRECT_URI);
  assert.equal(env.WORKOS_REDIRECT_URI, env.ANVIL_PRODUCTION_WORKOS_REDIRECT_URI);
  assert.doesNotThrow(() => validateDeploymentEnvironment(env));
});

test("runtime validation does not mistake newly configured SDK aliases for staging values", () => {
  const env = productionEnvironment();

  configureWorkosEnvironment(env);
  configureWorkosEnvironment(env);

  assert.doesNotThrow(() => validateDeploymentEnvironment(env));
  assert.doesNotThrow(() => validateDeploymentEnvironment(env));
});

test("runtime validation rejects a production config changed to use staging values", () => {
  const env = productionEnvironment({
    ANVIL_PRODUCTION_WORKOS_API_KEY: "sk_test_switched_after_build"
  });

  configureWorkosEnvironment(env);

  assert.equal(env.WORKOS_API_KEY, "sk_test_switched_after_build");
  assert.throws(() => validateDeploymentEnvironment(env), /must use the WorkOS production environment/);
});

test("production refuses a backend origin marked as staging", () => {
  assert.throws(
    () =>
      validateDeploymentEnvironment(
        productionEnvironment({ ANVIL_PRODUCTION_BACKEND_ORIGIN: "https://sync-staging.anvil.dev" })
      ),
    /must not point to a staging host/
  );
});

test("runtime validation still compares untouched legacy backend secrets after SDK setup", () => {
  const env = productionEnvironment({
    ANVIL_HOSTED_SERVICE_SECRET: "staging-service-secret-at-least-32-bytes",
    ANVIL_STAGING_HOSTED_SERVICE_SECRET: " "
  });
  configureWorkosEnvironment(env);
  env.ANVIL_PRODUCTION_HOSTED_SERVICE_SECRET = ` ${env.ANVIL_HOSTED_SERVICE_SECRET} `;
  assert.throws(() => validateDeploymentEnvironment(env), /must be distinct from its staging value/);
});

test("production rejects missing credentials, known staging WorkOS keys, and duplicated stage values", () => {
  assert.throws(() => validateDeploymentEnvironment({ ANVIL_DEPLOYMENT_ENV: "production" }), {
    message: /missing scoped configuration/
  });
  assert.throws(
    () => validateDeploymentEnvironment(productionEnvironment({ ANVIL_PRODUCTION_WORKOS_API_KEY: "sk_test_staging" })),
    /must use the WorkOS production environment/
  );
  assert.throws(
    () =>
      validateDeploymentEnvironment(
        productionEnvironment({ WORKOS_CLIENT_ID: "client_production" })
      ),
    /must be distinct from its staging value/
  );
});
