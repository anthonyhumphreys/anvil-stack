import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { MemoryPersistence } from "./index.js";

describe("MemoryPersistence", () => {
  it("loads checked-in Drizzle migrations", () => {
    const migrations = readMigrationFiles({ migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle") });

    expect(migrations).toHaveLength(2);
    expect(migrations[0]?.sql.join("\n")).toContain("CREATE TABLE IF NOT EXISTS packages");
    expect(migrations[0]?.sql.join("\n")).toContain("CREATE UNIQUE INDEX IF NOT EXISTS analysis_reports_identity_idx");
    expect(migrations[1]?.sql.join("\n")).toContain("CREATE TABLE IF NOT EXISTS policy_configs");
    expect(migrations[1]?.sql.join("\n")).toContain("CREATE UNIQUE INDEX IF NOT EXISTS policy_configs_name_version_idx");
  });

  it("stores package versions and preserves existing fields on partial updates", async () => {
    const persistence = new MemoryPersistence();

    await persistence.putPackageVersion({
      packageName: "pkg",
      version: "1.0.0",
      publishedAt: "2020-01-01T00:00:00.000Z",
      tarballUrl: "https://registry.example/pkg/-/pkg-1.0.0.tgz",
      integrity: "sha512-test",
      weeklyDownloads: 42
    });
    await persistence.putPackageVersion({
      packageName: "pkg",
      version: "1.0.0",
      cachedTarballKey: "tarballs/pkg/1.0.0/sha512-test.tgz"
    });

    const version = await persistence.getPackageVersion("pkg", "1.0.0");

    expect(version).toMatchObject({
      packageName: "pkg",
      version: "1.0.0",
      publishedAt: "2020-01-01T00:00:00.000Z",
      integrity: "sha512-test",
      weeklyDownloads: 42,
      cachedTarballKey: "tarballs/pkg/1.0.0/sha512-test.tgz"
    });
    expect(await persistence.listPackageVersions({ packageName: "pkg" })).toHaveLength(1);
  });

  it("stores package metadata with a cache timestamp", async () => {
    const persistence = new MemoryPersistence();

    await persistence.putMetadata("pkg", { name: "pkg" });

    expect(await persistence.getMetadata("pkg")).toEqual({ name: "pkg" });
    expect(await persistence.getMetadataRecord("pkg")).toMatchObject({
      packageName: "pkg",
      metadata: { name: "pkg" },
      updatedAt: expect.any(String)
    });
  });

  it("ignores expired and revoked overrides", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putOverride({
      packageName: "pkg",
      version: "1.0.0",
      action: "allow",
      reason: "expired",
      expiresAt: "2000-01-01T00:00:00.000Z"
    });

    expect(await persistence.getOverride("pkg", "1.0.0")).toBeUndefined();

    await persistence.putOverride({
      packageName: "pkg",
      version: "1.0.0",
      action: "allow",
      reason: "temporary"
    });
    await persistence.revokeOverride("pkg", "1.0.0", "reviewer");

    expect(await persistence.getOverride("pkg", "1.0.0")).toBeUndefined();
    expect((await persistence.listOverrides())[0]?.revokedAt).toBeDefined();
  });

  it("deletes package-wide policy decisions", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putPolicyDecision("pkg", "1.0.0", "policy", { action: "allow", score: 0, reasons: [], explanation: "ok" });
    await persistence.putPolicyDecision("pkg", "1.0.1", "policy", { action: "allow", score: 0, reasons: [], explanation: "ok" });
    await persistence.putPolicyDecision("other", "1.0.0", "policy", { action: "allow", score: 0, reasons: [], explanation: "ok" });

    await persistence.deletePolicyDecisionsForPackage("pkg", "policy");

    expect(await persistence.getPolicyDecision("pkg", "1.0.0", "policy")).toBeUndefined();
    expect(await persistence.getPolicyDecision("pkg", "1.0.1", "policy")).toBeUndefined();
    expect(await persistence.getPolicyDecision("other", "1.0.0", "policy")).toBeDefined();
  });

  it("does not return expired policy decisions for enforcement lookups", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putPolicyDecision("pkg", "1.0.0", "policy", {
      action: "quarantine",
      score: 70,
      reasons: [{ code: "PACKAGE_TOO_NEW", message: "Package is too new.", severity: "high" }],
      explanation: "cached young-package decision",
      expiresAt: "2000-01-01T00:00:00.000Z"
    });

    expect(await persistence.getPolicyDecision("pkg", "1.0.0", "policy")).toBeUndefined();
    expect(await persistence.listPolicyDecisions({ packageName: "pkg", version: "1.0.0" })).toHaveLength(1);
  });

  it("only returns policy decisions for the matching immutable identity", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putPolicyDecision(
      "pkg",
      "1.0.0",
      "policy",
      { action: "block", score: 95, reasons: [], explanation: "old tarball blocked" },
      { tarballIntegrity: "sha512-old", analyserVersion: "static-v1" }
    );

    expect(await persistence.getPolicyDecision("pkg", "1.0.0", "policy", { tarballIntegrity: "sha512-old", analyserVersion: "static-v1" })).toMatchObject({
      action: "block"
    });
    expect(await persistence.getPolicyDecision("pkg", "1.0.0", "policy", { tarballIntegrity: "sha512-new", analyserVersion: "static-v1" })).toBeUndefined();
    expect(await persistence.getPolicyDecision("pkg", "1.0.0", "policy", { tarballIntegrity: "sha512-old", analyserVersion: "static-v2" })).toBeUndefined();
  });

  it("preserves separate policy decision history for distinct immutable identities", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putPolicyDecision(
      "pkg",
      "1.0.0",
      "policy",
      { action: "block", score: 95, reasons: [], explanation: "old tarball blocked" },
      { tarballIntegrity: "sha512-old", analyserVersion: "static-v1" }
    );
    await persistence.putPolicyDecision(
      "pkg",
      "1.0.0",
      "policy",
      { action: "allow", score: 0, reasons: [], explanation: "new tarball allowed" },
      { tarballIntegrity: "sha512-new", analyserVersion: "static-v1" }
    );
    await persistence.putPolicyDecision(
      "pkg",
      "1.0.0",
      "policy",
      { action: "warn", score: 30, reasons: [], explanation: "new tarball rechecked" },
      { tarballIntegrity: "sha512-new", analyserVersion: "static-v1" }
    );

    const decisions = await persistence.listPolicyDecisions({ packageName: "pkg", version: "1.0.0" });

    expect(decisions).toHaveLength(2);
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tarballIntegrity: "sha512-old", decision: expect.objectContaining({ action: "block" }) }),
        expect.objectContaining({ tarballIntegrity: "sha512-new", decision: expect.objectContaining({ action: "warn" }) })
      ])
    );
  });

  it("preserves separate analysis reports for distinct immutable identities", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putAnalysisReport({
      packageName: "pkg",
      version: "1.0.0",
      analyserVersion: "static-v1",
      policyVersion: "policy",
      tarballIntegrity: "sha512-old",
      score: 95,
      signals: [{ code: "UNEXPECTED_BINARY_FILE", message: "Old tarball had a binary.", severity: "high" }],
      createdAt: new Date().toISOString()
    });
    await persistence.putAnalysisReport({
      packageName: "pkg",
      version: "1.0.0",
      analyserVersion: "static-v2",
      policyVersion: "policy",
      tarballIntegrity: "sha512-new",
      score: 30,
      signals: [{ code: "INSTALL_SCRIPT_CHANGED", message: "New tarball changed install script.", severity: "medium" }],
      createdAt: new Date().toISOString()
    });

    const reports = await persistence.listAnalysisReports({ packageName: "pkg", version: "1.0.0" });

    expect(reports).toHaveLength(2);
    expect(await persistence.getAnalysisReport("pkg", "1.0.0", { tarballIntegrity: "sha512-old", analyserVersion: "static-v1" })).toMatchObject({
      tarballIntegrity: "sha512-old",
      analyserVersion: "static-v1"
    });
    expect(await persistence.getAnalysisReport("pkg", "1.0.0", { tarballIntegrity: "sha512-missing", analyserVersion: "static-v1" })).toBeUndefined();
  });

  it("filters package review records before applying list limits", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putPolicyDecision("pkg", "1.0.0", "policy", { action: "block", score: 95, reasons: [], explanation: "blocked" });
    await persistence.putPolicyDecision("pkg", "2.0.0", "policy", { action: "allow", score: 0, reasons: [], explanation: "ok" });
    await persistence.putAnalysisReport({
      packageName: "pkg",
      version: "1.0.0",
      analyserVersion: "static",
      policyVersion: "policy",
      score: 95,
      signals: [],
      createdAt: new Date().toISOString()
    });
    await persistence.putOverride({ packageName: "pkg", version: "1.0.0", action: "allow", reason: "temporary" });
    await persistence.putAuditEvent({ eventType: "override.created", targetType: "package", targetId: "pkg@1.0.0" });

    expect(await persistence.listPolicyDecisions({ packageName: "pkg", version: "1.0.0", limit: 1 })).toHaveLength(1);
    expect(await persistence.listAnalysisReports({ packageName: "pkg", version: "1.0.0", limit: 1 })).toHaveLength(1);
    expect(await persistence.listOverrides({ packageName: "pkg", version: "1.0.0", limit: 1 })).toHaveLength(1);
    expect(await persistence.listAuditEvents({ targetId: "pkg@1.0.0", limit: 1 })).toHaveLength(1);
  });

  it("stores and filters LLM risk reviews", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putLlmRiskReview({
      packageName: "pkg",
      version: "1.0.0",
      tarballIntegrity: "sha512-current",
      tarballShasum: "currentsum",
      analyserVersion: "static-v1",
      provider: "stub",
      model: "none",
      review: {
        riskLevel: "high",
        confidence: "medium",
        summary: "Install script needs review.",
        suspectedRiskTypes: ["install_script_abuse"],
        evidence: [{ signal: "NEW_INSTALL_SCRIPT", explanation: "Lifecycle script appeared.", source: "package_json" }],
        recommendedAction: "quarantine"
      }
    });
    await persistence.putLlmRiskReview({
      packageName: "pkg",
      version: "1.0.0",
      tarballIntegrity: "sha512-old",
      tarballShasum: "oldsum",
      analyserVersion: "static-v1",
      provider: "stub",
      model: "none",
      review: {
        riskLevel: "low",
        confidence: "low",
        summary: "No obvious issue.",
        suspectedRiskTypes: [],
        evidence: [],
        recommendedAction: "allow"
      }
    });
    await persistence.putLlmRiskReview({
      packageName: "other",
      version: "1.0.0",
      provider: "stub",
      model: "none",
      review: {
        riskLevel: "low",
        confidence: "low",
        summary: "No obvious issue.",
        suspectedRiskTypes: [],
        evidence: [],
        recommendedAction: "allow"
      }
    });

    const reviews = await persistence.listLlmRiskReviews({
      packageName: "pkg",
      version: "1.0.0",
      identity: { tarballIntegrity: "sha512-current", tarballShasum: "currentsum", analyserVersion: "static-v1" }
    });

    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ tarballIntegrity: "sha512-current", tarballShasum: "currentsum", analyserVersion: "static-v1" });
    expect(reviews[0]?.review.summary).toBe("Install script needs review.");
  });

  it("stores, fetches, and filters Node Base reports", async () => {
    const persistence = new MemoryPersistence();
    const report = await persistence.putNodeBaseReport({
      source: "devcontainer",
      projectName: "demo",
      reportType: "ioc",
      summary: { high: 1 },
      report: { summary: { high: 1 } }
    });
    await persistence.putNodeBaseReport({
      source: "devcontainer",
      reportType: "dependency",
      summary: { packagesWithLifecycleScripts: 2 },
      report: { summary: { packagesWithLifecycleScripts: 2 } }
    });
    await persistence.putNodeBaseReport({
      source: "devcontainer",
      reportType: "network",
      report: { summary: { medium: 1, outboundConnections: 1 } }
    });

    expect(await persistence.getNodeBaseReport(report.id ?? "")).toMatchObject({
      id: report.id,
      source: "devcontainer",
      projectName: "demo",
      reportType: "ioc"
    });
    expect(await persistence.getNodeBaseReport("missing")).toBeUndefined();
    expect(await persistence.listNodeBaseReports({ reportType: "ioc" })).toHaveLength(1);
    expect(await persistence.listNodeBaseReports({ risk: "high" })).toHaveLength(1);
    expect(await persistence.listNodeBaseReports({ risk: "medium" })).toHaveLength(1);
    expect(await persistence.listNodeBaseReports({ risk: "risky" })).toHaveLength(2);
    expect(await persistence.listNodeBaseReports({ reportType: "network", risk: "medium" })).toHaveLength(1);
    expect((await persistence.listNodeBaseReports({ reportType: "network" }))[0]?.summary).toEqual({ medium: 1, outboundConnections: 1 });
  });

  it("treats Node Base risk summary aliases as the same count", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putNodeBaseReport({
      source: "devcontainer",
      reportType: "ioc",
      summary: { high: 1, highConfidenceFindings: 1, medium: 2, mediumConfidenceFindings: 2 },
      report: { summary: { high: 1, highConfidenceFindings: 1, medium: 2, mediumConfidenceFindings: 2 } }
    });

    expect(await persistence.listNodeBaseReports({ risk: "high" })).toHaveLength(1);
    expect(await persistence.listNodeBaseReports({ risk: "medium" })).toHaveLength(0);
    expect(await persistence.listNodeBaseReports({ risk: "risky" })).toHaveLength(1);
  });

  it("ignores malformed Node Base risk summary counts", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putNodeBaseReport({
      source: "devcontainer",
      reportType: "network",
      summary: { high: "not-a-number", mediumConfidenceFindings: "2" },
      report: { summary: { high: "not-a-number", mediumConfidenceFindings: "2" } }
    });

    expect(await persistence.listNodeBaseReports({ risk: "high" })).toHaveLength(0);
    expect(await persistence.listNodeBaseReports({ risk: "medium" })).toHaveLength(1);
    expect(await persistence.listNodeBaseReports({ risk: "risky" })).toHaveLength(1);
  });

  it("stores active policy config snapshots", async () => {
    const persistence = new MemoryPersistence();

    await persistence.putPolicyConfig({
      name: "effective",
      version: "policy-v1",
      active: true,
      config: { runtimeMode: "development", policy: { version: "policy-v1" } }
    });
    await persistence.putPolicyConfig({
      name: "effective",
      version: "policy-v2",
      active: true,
      config: { runtimeMode: "ci", policy: { version: "policy-v2" } }
    });

    expect(await persistence.getActivePolicyConfig("effective")).toMatchObject({
      name: "effective",
      version: "policy-v2",
      active: true,
      config: { runtimeMode: "ci", policy: { version: "policy-v2" } }
    });
    expect(await persistence.listPolicyConfigs({ name: "effective" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "policy-v1", active: false }),
        expect.objectContaining({ version: "policy-v2", active: true })
      ])
    );
  });
});
