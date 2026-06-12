import { describe, expect, it } from "vitest";
import { validateSstDeployPreflight } from "./preflight.js";

describe("SST deploy preflight", () => {
  it("passes with an explicit public gateway URL", () => {
    const result = validateSstDeployPreflight({
      PUBLIC_BASE_URL: "https://npm.anvil.test"
    });

    expect(result.ok).toBe(true);
    expect(result.derived).toEqual({
      publicBaseUrl: "https://npm.anvil.test",
      adminApiBaseUrl: "https://npm.anvil.test"
    });
  });

  it("derives the public gateway URL from the gateway domain", () => {
    const result = validateSstDeployPreflight({
      ANVIL_GATEWAY_DOMAIN: "npm.anvil.test",
      ANVIL_ADMIN_DOMAIN: "admin.anvil.test",
      ANVIL_ADMIN_CERT_ARN: "arn:aws:acm:eu-west-2:111122223333:certificate/admin"
    });

    expect(result.ok).toBe(true);
    expect(result.derived.publicBaseUrl).toBe("https://npm.anvil.test");
  });

  it("fails when the deployed gateway URL cannot be resolved", () => {
    const result = validateSstDeployPreflight({});

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PUBLIC_BASE_URL_REQUIRED"
        })
      ])
    );
  });

  it("rejects placeholder and non-HTTPS gateway URLs", () => {
    const result = validateSstDeployPreflight({
      PUBLIC_BASE_URL: "http://npm.anvil.example.com"
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(["PUBLIC_BASE_URL_HTTPS_REQUIRED", "PUBLIC_BASE_URL_PLACEHOLDER"]));
  });

  it("rejects certificate ARNs without matching domains", () => {
    const result = validateSstDeployPreflight({
      PUBLIC_BASE_URL: "https://npm.anvil.test",
      ANVIL_GATEWAY_CERT_ARN: "arn:aws:acm:eu-west-2:111122223333:certificate/gateway",
      ANVIL_ADMIN_CERT_ARN: "arn:aws:acm:eu-west-2:111122223333:certificate/admin"
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(["GATEWAY_CERT_WITHOUT_DOMAIN", "ADMIN_CERT_WITHOUT_DOMAIN"]));
  });

  it("validates upstream registry JSON and warns on inline tokens", () => {
    const result = validateSstDeployPreflight({
      PUBLIC_BASE_URL: "https://npm.anvil.test",
      UPSTREAM_NPM_REGISTRIES_JSON: JSON.stringify([{ name: "internal", baseUrl: "https://npm.pkg.github.com", authToken: "secret" }])
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UPSTREAM_REGISTRY_INLINE_TOKEN"
        })
      ])
    );
  });

  it("rejects half-enabled LLM review", () => {
    const result = validateSstDeployPreflight({
      PUBLIC_BASE_URL: "https://npm.anvil.test",
      LLM_REVIEW_ENABLED: "true"
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(["LLM_REVIEW_PROVIDER_REQUIRED", "LLM_REVIEW_ENDPOINT_REQUIRED"]));
    expect(result.warnings.map((warning) => warning.code)).toContain("LLM_REVIEW_MODEL_EMPTY");
  });

  it("rejects malformed policy overrides before deploy", () => {
    const result = validateSstDeployPreflight({
      PUBLIC_BASE_URL: "https://npm.anvil.test",
      POLICY_BLOCK_NEW_INSTALL_SCRIPTS: "sometimes",
      POLICY_MINIMUM_PACKAGE_AGE_DAYS: "-1",
      POLICY_LOW_DOWNLOAD_THRESHOLD: "100.5"
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["POLICY_BLOCK_NEW_INSTALL_SCRIPTS_INVALID", "POLICY_MINIMUM_PACKAGE_AGE_DAYS_INVALID", "POLICY_LOW_DOWNLOAD_THRESHOLD_INVALID"])
    );
  });
});
