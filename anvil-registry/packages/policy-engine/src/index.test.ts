import { defaultPolicyConfig } from "@anvilstack/config";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "./index.js";

describe("evaluatePolicy", () => {
  it("blocks very new packages", () => {
    const publishedAt = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const decision = evaluatePolicy({
      packageName: "leftpadder",
      version: "1.0.0",
      runtimeMode: "ci",
      packageAgeDays: 0.5,
      versionMetadata: { name: "leftpadder", version: "1.0.0", publishedAt },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("block");
    expect(decision.reasons.map((reason) => reason.code)).toContain("PACKAGE_TOO_NEW");
    expect(decision.expiresAt).toBe(new Date(Date.parse(publishedAt) + 24 * 60 * 60 * 1000).toISOString());
  });

  it("expires young package decisions at the minimum age boundary", () => {
    const publishedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const decision = evaluatePolicy({
      packageName: "young-package",
      version: "1.0.0",
      runtimeMode: "ci",
      packageAgeDays: 2,
      versionMetadata: { name: "young-package", version: "1.0.0", publishedAt },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("quarantine");
    expect(decision.expiresAt).toBe(new Date(Date.parse(publishedAt) + defaultPolicyConfig.minimumPackageAgeDays * 24 * 60 * 60 * 1000).toISOString());
  });

  it("blocks low-download similar packages", () => {
    const decision = evaluatePolicy({
      packageName: "@tenstack/react-query",
      version: "1.0.0",
      runtimeMode: "development",
      weeklyDownloads: 10,
      similarPackages: [{ name: "@tanstack/react-query", similarity: 0.95, weeklyDownloads: 4_000_000, reasons: ["known_ecosystem_confusion"], suggestedPackage: "@tanstack/react-query" }],
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("block");
    expect(decision.reasons.find((reason) => reason.code === "SIMILAR_TO_POPULAR_PACKAGE")).toMatchObject({
      evidence: { suggestedPackage: "@tanstack/react-query", reasons: ["known_ecosystem_confusion"] }
    });
  });

  it("blocks low-download scope-confusion packages", () => {
    const decision = evaluatePolicy({
      packageName: "react-query",
      version: "1.0.0",
      runtimeMode: "ci",
      weeklyDownloads: 20,
      similarPackages: [{ name: "@tanstack/react-query", similarity: 1, weeklyDownloads: 4_000_000, reasons: ["scope_confusion"], suggestedPackage: "@tanstack/react-query" }],
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("block");
    expect(decision.reasons.find((reason) => reason.code === "SIMILAR_TO_POPULAR_PACKAGE")).toMatchObject({
      severity: "critical",
      evidence: { suggestedPackage: "@tanstack/react-query", reasons: ["scope_confusion"] }
    });
  });

  it("does not hard-block similar packages without low-adoption evidence", () => {
    const decision = evaluatePolicy({
      packageName: "@tenstack/react-query",
      version: "1.0.0",
      runtimeMode: "ci",
      weeklyDownloads: 25_000,
      similarPackages: [{ name: "@tanstack/react-query", similarity: 0.95, weeklyDownloads: 4_000_000, reasons: ["known_ecosystem_confusion"], suggestedPackage: "@tanstack/react-query" }],
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("quarantine");
    expect(decision.reasons.find((reason) => reason.code === "SIMILAR_TO_POPULAR_PACKAGE")).toMatchObject({
      severity: "medium",
      evidence: { weeklyDownloads: 25_000 }
    });
  });

  it("warns on similar packages when downloads are unavailable", () => {
    const decision = evaluatePolicy({
      packageName: "@tenstack/react-query",
      version: "1.0.0",
      runtimeMode: "development",
      similarPackages: [{ name: "@tanstack/react-query", similarity: 0.95, weeklyDownloads: 4_000_000, reasons: ["known_ecosystem_confusion"], suggestedPackage: "@tanstack/react-query" }],
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("warn");
    expect(decision.reasons.find((reason) => reason.code === "SIMILAR_TO_POPULAR_PACKAGE")).toMatchObject({ severity: "medium" });
  });

  it("honours active allow overrides", () => {
    const decision = evaluatePolicy({
      packageName: "fresh-package",
      version: "1.0.0",
      runtimeMode: "ci",
      packageAgeDays: 0,
      override: {
        packageName: "fresh-package",
        version: "1.0.0",
        action: "allow",
        reason: "Approved for test fixture"
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("allow");
  });

  it("does not apply overrides expiring at the current instant", () => {
    const decision = evaluatePolicy({
      packageName: "fresh-package",
      version: "1.0.0",
      runtimeMode: "ci",
      evaluatedAt: "2026-05-21T12:00:00.000Z",
      packageAgeDays: 0,
      override: {
        packageName: "fresh-package",
        version: "1.0.0",
        action: "allow",
        reason: "Expired exactly now",
        expiresAt: "2026-05-21T12:00:00.000Z"
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("block");
    expect(decision.reasons.map((reason) => reason.code)).toContain("PACKAGE_TOO_NEW");
  });

  it("uses the supplied evaluation time for time-sensitive decision expiry", () => {
    const decision = evaluatePolicy({
      packageName: "young-package",
      version: "1.0.0",
      runtimeMode: "ci",
      evaluatedAt: "2026-05-21T12:00:00.000Z",
      packageAgeDays: 2,
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("quarantine");
    expect(decision.expiresAt).toBe("2026-05-26T12:00:00.000Z");
  });

  it("blocks tarballs with unsafe extraction entries", () => {
    const decision = evaluatePolicy({
      packageName: "haunted-tarball",
      version: "1.0.0",
      runtimeMode: "development",
      analysisReport: {
        packageName: "haunted-tarball",
        version: "1.0.0",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 70,
        signals: [{ code: "UNSAFE_TARBALL_SYMLINK", message: "Tarball contains a symlink pointing outside the package.", severity: "high" }],
        createdAt: new Date().toISOString()
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("block");
    expect(decision.reasons.map((reason) => reason.code)).toContain("UNSAFE_TARBALL_SYMLINK");
  });

  it("quarantines large file size deltas outside development", () => {
    const decision = evaluatePolicy({
      packageName: "chunky-patch",
      version: "1.0.1",
      runtimeMode: "ci",
      analysisReport: {
        packageName: "chunky-patch",
        version: "1.0.1",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 35,
        signals: [{ code: "LARGE_FILE_SIZE_DELTA", message: "File size grew sharply compared with previous package versions.", severity: "medium" }],
        createdAt: new Date().toISOString()
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("quarantine");
    expect(decision.explanation).toContain("chunky-patch@1.0.1 is quarantined by deterministic policy.");
  });

  it("quarantines missing provenance signals outside development", () => {
    const decision = evaluatePolicy({
      packageName: "popular-package",
      version: "1.0.0",
      runtimeMode: "ci",
      analysisReport: {
        packageName: "popular-package",
        version: "1.0.0",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 35,
        signals: [{ code: "PROVENANCE_MISSING", message: "High-download package has no published provenance metadata.", severity: "medium" }],
        createdAt: new Date().toISOString()
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("quarantine");
  });

  it("quarantines CI installs that have no static analysis report yet", () => {
    const decision = evaluatePolicy({
      packageName: "stable-package",
      version: "1.0.0",
      runtimeMode: "ci",
      analysisRequired: true,
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("quarantine");
    expect(decision.reasons).toContainEqual(
      expect.objectContaining({
        code: "ANALYSIS_REQUIRED",
        severity: "medium"
      })
    );
  });

  it("blocks production installs that have no static analysis report yet", () => {
    const decision = evaluatePolicy({
      packageName: "stable-package",
      version: "1.0.0",
      runtimeMode: "production",
      analysisRequired: true,
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("block");
  });

  it("enforces missing provenance for high-download packages during metadata policy", () => {
    const decision = evaluatePolicy({
      packageName: "popular-package",
      version: "1.0.0",
      runtimeMode: "ci",
      weeklyDownloads: 250_000,
      versionMetadata: {
        name: "popular-package",
        version: "1.0.0",
        provenance: { present: false }
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("quarantine");
    expect(decision.reasons).toContainEqual(
      expect.objectContaining({
        code: "PROVENANCE_MISSING",
        evidence: expect.objectContaining({ weeklyDownloads: 250_000, provenancePresent: false })
      })
    );
  });

  it("allows high-download packages with provenance when no other risk is present", () => {
    const decision = evaluatePolicy({
      packageName: "popular-package",
      version: "1.0.0",
      runtimeMode: "ci",
      weeklyDownloads: 250_000,
      versionMetadata: {
        name: "popular-package",
        version: "1.0.0",
        provenance: { present: true, source: "dist.attestations", attestationUrl: "https://registry.example/attestations/popular-package" }
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("allow");
  });

  it("reduces risk score when trusted publishing metadata is present", () => {
    const decision = evaluatePolicy({
      packageName: "low-adoption-package",
      version: "1.0.0",
      runtimeMode: "ci",
      weeklyDownloads: 500,
      versionMetadata: {
        name: "low-adoption-package",
        version: "1.0.0",
        provenance: { present: true, source: "dist.attestations", attestationUrl: "https://registry.example/attestations/low-adoption-package" }
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("warn");
    expect(decision.score).toBe(25);
    expect(decision.reasons).toContainEqual(
      expect.objectContaining({
        code: "TRUSTED_PUBLISHING_PRESENT",
        evidence: expect.objectContaining({ scoreReduction: defaultPolicyConfig.provenance.trustedPublishingScoreReduction })
      })
    );
  });

  it("does not let trusted publishing metadata bypass hard blocks", () => {
    const decision = evaluatePolicy({
      packageName: "haunted-tarball",
      version: "1.0.0",
      runtimeMode: "ci",
      versionMetadata: {
        name: "haunted-tarball",
        version: "1.0.0",
        provenance: { present: true, source: "dist.attestations" }
      },
      analysisReport: {
        packageName: "haunted-tarball",
        version: "1.0.0",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 70,
        signals: [{ code: "UNSAFE_TARBALL_PATH", message: "Tarball contains an unsafe path.", severity: "high" }],
        createdAt: new Date().toISOString()
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("block");
  });

  it("does not reduce risk for provenance subject mismatches", () => {
    const decision = evaluatePolicy({
      packageName: "subject-pkg",
      version: "1.0.0",
      runtimeMode: "ci",
      versionMetadata: {
        name: "subject-pkg",
        version: "1.0.0",
        provenance: { present: true, source: "dist.attestations" }
      },
      analysisReport: {
        packageName: "subject-pkg",
        version: "1.0.0",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 70,
        signals: [{ code: "PROVENANCE_SUBJECT_MISMATCH", message: "Provenance subject does not match.", severity: "high" }],
        createdAt: new Date().toISOString()
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("block");
    expect(decision.score).toBe(70);
  });

  it("deduplicates provenance reasons when metadata and analysis report agree", () => {
    const decision = evaluatePolicy({
      packageName: "popular-package",
      version: "1.0.0",
      runtimeMode: "ci",
      weeklyDownloads: 250_000,
      versionMetadata: {
        name: "popular-package",
        version: "1.0.0",
        provenance: { present: false }
      },
      analysisReport: {
        packageName: "popular-package",
        version: "1.0.0",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 35,
        signals: [{ code: "PROVENANCE_MISSING", message: "High-download package has no published provenance metadata.", severity: "medium" }],
        createdAt: new Date().toISOString()
      },
      policy: defaultPolicyConfig
    });

    expect(decision.reasons.filter((reason) => reason.code === "PROVENANCE_MISSING")).toHaveLength(1);
  });

  it("warns on changed provenance signals in development", () => {
    const decision = evaluatePolicy({
      packageName: "popular-package",
      version: "1.0.1",
      runtimeMode: "development",
      analysisReport: {
        packageName: "popular-package",
        version: "1.0.1",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 35,
        signals: [{ code: "PROVENANCE_CHANGED", message: "Package provenance metadata changed compared with the previous version.", severity: "medium" }],
        createdAt: new Date().toISOString()
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("warn");
  });

  it("quarantines high-risk LLM reviews without making the LLM a block authority", () => {
    const decision = evaluatePolicy({
      packageName: "model-reviewed-package",
      version: "1.0.0",
      runtimeMode: "ci",
      llmRiskReview: {
        riskLevel: "critical",
        confidence: "high",
        summary: "The review suspects credential exfiltration, but deterministic evidence has not found a hard block.",
        suspectedRiskTypes: ["credential_exfiltration"],
        evidence: [{ signal: "USES_PROCESS_ENV", explanation: "The model saw environment access.", source: "code_snippet" }],
        recommendedAction: "block"
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("quarantine");
    expect(decision.reasons).toContainEqual(
      expect.objectContaining({
        code: "LLM_RISK_REVIEW_FLAGGED",
        severity: "critical"
      })
    );
  });

  it("still blocks when deterministic evidence supports a hard block alongside LLM review", () => {
    const decision = evaluatePolicy({
      packageName: "haunted-tarball",
      version: "1.0.0",
      runtimeMode: "ci",
      analysisReport: {
        packageName: "haunted-tarball",
        version: "1.0.0",
        analyserVersion: "static",
        policyVersion: defaultPolicyConfig.version,
        score: 70,
        signals: [{ code: "UNSAFE_TARBALL_PATH", message: "Tarball contains an unsafe path.", severity: "high" }],
        createdAt: new Date().toISOString()
      },
      llmRiskReview: {
        riskLevel: "high",
        confidence: "medium",
        summary: "The review agrees the package looks risky.",
        suspectedRiskTypes: ["unknown"],
        evidence: [{ signal: "UNSAFE_TARBALL_PATH", explanation: "Unsafe extraction path.", source: "diff" }],
        recommendedAction: "block"
      },
      policy: defaultPolicyConfig
    });

    expect(decision.action).toBe("block");
  });
});
