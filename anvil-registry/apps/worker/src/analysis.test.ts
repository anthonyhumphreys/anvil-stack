import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { loadConfig } from "@anvilstack/config";
import type { LlmRiskReviewProvider } from "@anvilstack/llm-risk-review";
import type { NpmPackageMetadata } from "@anvilstack/npm-registry";
import { MemoryPersistence } from "@anvilstack/persistence";
import { MetadataProvenanceVerifier } from "@anvilstack/provenance";
import type { LlmRiskReview } from "@anvilstack/shared";
import { analyseAnalysisJob, analysePackageTarget, analysisReportObjectKeyForReport, parsePackageTarget } from "./analysis.js";

describe("worker analysis", () => {
  it("parses scoped package targets", () => {
    expect(parsePackageTarget("@scope/pkg@1.2.3")).toEqual({ packageName: "@scope/pkg", version: "1.2.3" });
    expect(parsePackageTarget("@scope/pkg")).toEqual({ packageName: "@scope/pkg", version: "latest" });
  });

  it("persists analysis report and policy decision from manual target", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = { fetchMetadata: vi.fn(async () => metadata()), fetchTarball: vi.fn(async (url: string) => tarballs[url]) };

    const result = await analysePackageTarget("pkg@1.0.1", { config, registry, persistence });

    expect(result.report.signals.map((signal) => signal.code)).toContain("NEW_INSTALL_SCRIPT");
    expect(result.report.signals.map((signal) => signal.code)).toContain("USES_CHILD_PROCESS");
    expect(result.report.signals.map((signal) => signal.code)).toContain("OPTIONAL_DEPENDENCY_ADDED");
    expect(result.report.signals.map((signal) => signal.code)).toContain("PEER_DEPENDENCY_CHANGED");
    expect(result.report.signals.map((signal) => signal.code)).toContain("BIN_FIELD_CHANGED");
    expect(result.report.signals.map((signal) => signal.code)).toContain("UNSAFE_TARBALL_SYMLINK");
    expect(result.report.fileFindings).toContainEqual(expect.objectContaining({ path: "link-out", code: "UNSAFE_TARBALL_SYMLINK", reason: "Tarball contains a symlink pointing outside the package.", evidence: { linkTarget: "../../outside", unsafe: true } }));
    expect(result.report.signals).toContainEqual(expect.objectContaining({ code: "UNSAFE_TARBALL_SYMLINK", evidence: expect.objectContaining({ path: "link-out", linkTarget: "../../outside" }) }));
    expect(result.report).toMatchObject({ tarballIntegrity: "sha512-new", tarballShasum: "newsum" });
    expect(await persistence.getAnalysisReport("pkg", "1.0.1")).toBeDefined();
    expect(await persistence.getPackageVersion("pkg", "1.0.1")).toMatchObject({
      packageName: "pkg",
      version: "1.0.1",
      publishedAt: "2020-01-02T00:00:00.000Z",
      tarballUrl: "https://registry.example/pkg/-/pkg-1.0.1.tgz",
      integrity: "sha512-new",
      shasum: "newsum"
    });
    expect(
      (await persistence.getPolicyDecision("pkg", "1.0.1", config.policy.version, {
        tarballIntegrity: "sha512-new",
        tarballShasum: "newsum",
        analyserVersion: result.report.analyserVersion
      }))?.action
    ).toBe("block");
    const auditEvents = await persistence.listAuditEvents();
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: "anvil-worker",
        eventType: "analysis.completed",
        targetId: "pkg@1.0.1"
      }),
      expect.objectContaining({
        actor: "anvil-worker",
        eventType: "policy.decision",
        targetId: "pkg@1.0.1",
        metadata: expect.objectContaining({
          source: "analysis",
          action: "block",
          policyVersion: config.policy.version,
          analyserVersion: result.report.analyserVersion,
          tarballIntegrity: "sha512-new",
          tarballShasum: "newsum",
          reasonCodes: expect.arrayContaining(["NEW_INSTALL_SCRIPT", "UNSAFE_TARBALL_SYMLINK"])
        })
      })
    ]));
  });

  it("stores analysis report artifacts in object storage when provided", async () => {
    const persistence = new MemoryPersistence();
    const objectStore = new TestObjectStore();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = { fetchMetadata: vi.fn(async () => metadata()), fetchTarball: vi.fn(async (url: string) => tarballs[url]) };

    const result = await analysePackageTarget("pkg@1.0.1", { config, registry, persistence, objectStore });
    const objectKey = analysisReportObjectKeyForReport(result.report);
    const stored = await objectStore.get(objectKey);
    const manifestDiffKey = objectKey.replace(/report\.json$/, "manifest-diff.json");
    const fileTreeKey = objectKey.replace(/report\.json$/, "file-tree.json");

    expect(objectKey).toBe(`analysis/pkg/1.0.1/${config.policy.version}/${encodeURIComponent(result.report.analyserVersion)}/sha512-new/report.json`);
    expect(result.report.objectKey).toBe(objectKey);
    expect(stored).toBeDefined();
    expect(JSON.parse(Buffer.from(stored ?? []).toString("utf8"))).toMatchObject({
      packageName: "pkg",
      version: "1.0.1",
      tarballIntegrity: "sha512-new",
      objectKey,
      signals: expect.arrayContaining([expect.objectContaining({ code: "NEW_INSTALL_SCRIPT" })])
    });
    expect(JSON.parse(Buffer.from((await objectStore.get(manifestDiffKey)) ?? []).toString("utf8"))).toMatchObject({
      release: expect.objectContaining({ previous: "1.0.0", target: "1.0.1" })
    });
    expect(JSON.parse(Buffer.from((await objectStore.get(fileTreeKey)) ?? []).toString("utf8"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "package.json", type: "file", mode: "0o644" }),
        expect.objectContaining({ path: "install.js", type: "file", size: expect.any(Number) }),
        expect.objectContaining({ path: "link-out", type: "symlink", linkTarget: "../../outside" })
      ])
    );
    expect(await persistence.listAuditEvents({ targetId: "pkg@1.0.1" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "analysis.completed",
          metadata: expect.objectContaining({
            analysisReportObjectKey: objectKey,
            analysisManifestDiffObjectKey: manifestDiffKey,
            analysisFileTreeObjectKey: fileTreeKey
          })
        })
      ])
    );
  });

  it("analyses queued jobs", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = { fetchMetadata: vi.fn(async () => metadata()), fetchTarball: vi.fn(async (url: string) => tarballs[url]) };

    await analyseAnalysisJob(
      {
        packageName: "pkg",
        version: "1.0.1",
        reason: "metadata_request",
        priority: "normal",
        createdAt: new Date().toISOString()
      },
      { config, registry, persistence }
    );

    expect(await persistence.getAnalysisReport("pkg", "1.0.1")).toBeDefined();
    expect(registry.fetchTarball).toHaveBeenCalledTimes(2);
  });

  it("persists latest queued jobs against the resolved package version", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = { fetchMetadata: vi.fn(async () => metadata()), fetchTarball: vi.fn(async (url: string) => tarballs[url]) };

    const result = await analyseAnalysisJob(
      {
        packageName: "pkg",
        version: "latest",
        reason: "manual_review",
        priority: "normal",
        createdAt: new Date().toISOString()
      },
      { config, registry, persistence }
    );

    expect(result.version).toBe("1.0.1");
    expect(await persistence.getAnalysisReport("pkg", "1.0.1")).toBeDefined();
    expect(await persistence.getAnalysisReport("pkg", "latest")).toBeUndefined();
    expect(await persistence.listAuditEvents({ targetId: "pkg@1.0.1" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "analysis.completed" }),
        expect.objectContaining({ eventType: "policy.decision" })
      ])
    );
    expect(await persistence.listAuditEvents({ targetId: "pkg@latest" })).toHaveLength(0);
  });

  it("persists arbitrary dist-tag jobs against the resolved package version", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = {
      fetchMetadata: vi.fn(async () => ({ ...metadata(), "dist-tags": { latest: "1.0.0", beta: "1.0.1" } })),
      fetchTarball: vi.fn(async (url: string) => tarballs[url])
    };

    const result = await analyseAnalysisJob(
      {
        packageName: "pkg",
        version: "beta",
        reason: "manual_review",
        priority: "normal",
        createdAt: new Date().toISOString()
      },
      { config, registry, persistence }
    );

    expect(result.version).toBe("1.0.1");
    expect(await persistence.getAnalysisReport("pkg", "1.0.1")).toBeDefined();
    expect(await persistence.getAnalysisReport("pkg", "beta")).toBeUndefined();
  });

  it("preserves very-new package blocking and decision expiry in worker decisions", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const publishedAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const registry = {
      fetchMetadata: vi.fn(async () => freshMetadata(publishedAt)),
      fetchTarball: vi.fn(async (url: string) => tarballs[url])
    };

    const result = await analysePackageTarget("fresh-worker-pkg@1.0.0", { config, registry, persistence });

    expect(result.decision).toMatchObject({
      action: "block",
      expiresAt: new Date(Date.parse(publishedAt) + 24 * 60 * 60 * 1000).toISOString()
    });
    expect(
      await persistence.getPolicyDecision("fresh-worker-pkg", "1.0.0", config.policy.version, {
        tarballIntegrity: "sha512-fresh",
        tarballShasum: "freshsum",
        analyserVersion: result.report.analyserVersion
      })
    ).toMatchObject({
      action: "block",
      expiresAt: expect.any(String)
    });
  });

  it("passes the configured previous-version depth into manifest analysis", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci", COMPARE_PREVIOUS_VERSIONS: "3" });
    const registry = {
      fetchMetadata: vi.fn(async () => manifestHistoryMetadata()),
      fetchTarball: vi.fn()
    };

    const result = await analysePackageTarget("history-pkg@1.0.3", { config, registry, persistence });

    expect(result.report.manifestDiff).toMatchObject({
      baselines: [
        expect.objectContaining({ version: "1.0.2" }),
        expect.objectContaining({ version: "1.0.1" }),
        expect.objectContaining({ version: "1.0.0" })
      ]
    });
    expect(result.report.signals.find((signal) => signal.code === "NEW_INSTALL_SCRIPT")?.evidence).toMatchObject({
      comparedVersions: ["1.0.2", "1.0.1", "1.0.0"],
      compareDepth: 3
    });
    expect(registry.fetchTarball).not.toHaveBeenCalled();
  });

  it("persists low-adoption name-squatting signals in worker reports", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = {
      fetchMetadata: vi.fn(async () => typoMetadata()),
      fetchTarball: vi.fn(async (url: string) => tarballs[url])
    };

    const result = await analysePackageTarget("@tenstack/react-query@1.0.0", {
      config,
      registry,
      persistence,
      downloadStats: {
        getWeeklyDownloads: vi.fn(async () => 10)
      }
    });

    const codes = result.report.signals.map((signal) => signal.code);
    expect(codes).toContain("LOW_WEEKLY_DOWNLOADS");
    expect(codes).toContain("SIMILAR_TO_POPULAR_PACKAGE");
    expect(result.report.signals.find((signal) => signal.code === "SIMILAR_TO_POPULAR_PACKAGE")).toMatchObject({
      severity: "critical",
      evidence: {
        candidate: "@tanstack/react-query",
        suggestedPackage: "@tanstack/react-query",
        reasons: expect.arrayContaining(["known_ecosystem_confusion"])
      }
    });
    expect(
      (await persistence.getPolicyDecision("@tenstack/react-query", "1.0.0", config.policy.version, {
        tarballIntegrity: "sha512-typo",
        tarballShasum: "typosum",
        analyserVersion: result.report.analyserVersion
      }))?.action
    ).toBe("block");
  });

  it("quarantines high-download packages without provenance metadata", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = {
      fetchMetadata: vi.fn(async () => popularMetadataWithoutProvenance()),
      fetchTarball: vi.fn()
    };

    const result = await analysePackageTarget("popular-package@1.0.0", {
      config,
      registry,
      persistence,
      downloadStats: {
        getWeeklyDownloads: vi.fn(async () => 250_000)
      }
    });

    expect(result.report.signals).toContainEqual(
      expect.objectContaining({
        code: "PROVENANCE_MISSING",
        severity: "medium",
        evidence: expect.objectContaining({ weeklyDownloads: 250_000, threshold: config.policy.provenance.highDownloadThreshold })
      })
    );
    expect(result.report.provenance).toEqual({
      status: "missing",
      target: { present: false },
      previous: undefined,
      verification: expect.objectContaining({
        status: "missing",
        verified: false,
        expectedSubjectName: "popular-package@1.0.0"
      })
    });
    expect(result.decision.action).toBe("quarantine");
    expect(registry.fetchTarball).not.toHaveBeenCalled();
  });

  it("quarantines package versions whose provenance metadata changes", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = {
      fetchMetadata: vi.fn(async () => provenanceChangedMetadata()),
      fetchTarball: vi.fn()
    };

    const result = await analysePackageTarget("provenance-pkg@1.0.1", {
      config,
      registry,
      persistence,
      provenanceVerifier: new MetadataProvenanceVerifier()
    });

    expect(result.report.signals).toContainEqual(
      expect.objectContaining({
        code: "PROVENANCE_CHANGED",
        severity: "medium",
        evidence: {
          previous: {
            present: true,
            source: "dist.attestations",
            attestationUrl: "https://registry.example/-/npm/v1/attestations/provenance-pkg@1.0.0"
          },
          target: {
            present: true,
            source: "dist.attestations",
            attestationUrl: "https://registry.example/-/npm/v1/attestations/provenance-pkg@1.0.1-new-publisher"
          }
        }
      })
    );
    expect(result.report.provenance).toMatchObject({
      status: "changed",
      previous: {
        present: true,
        source: "dist.attestations",
        attestationUrl: "https://registry.example/-/npm/v1/attestations/provenance-pkg@1.0.0"
      },
      target: {
        present: true,
        source: "dist.attestations",
        attestationUrl: "https://registry.example/-/npm/v1/attestations/provenance-pkg@1.0.1-new-publisher"
      }
    });
    expect(result.decision.action).toBe("quarantine");
  });

  it("blocks package versions whose provenance subject does not match the analysed package", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({ ...process.env, RUNTIME_MODE: "ci" });
    const registry = {
      fetchMetadata: vi.fn(async () => provenanceSubjectMismatchMetadata()),
      fetchTarball: vi.fn()
    };

    const result = await analysePackageTarget("subject-pkg@1.0.0", {
      config,
      registry,
      persistence
    });

    expect(result.report.provenance?.verification).toMatchObject({
      status: "subject_mismatch",
      verified: false,
      subjectName: "other-pkg@1.0.0",
      expectedSubjectName: "subject-pkg@1.0.0"
    });
    expect(result.report.signals).toContainEqual(
      expect.objectContaining({
        code: "PROVENANCE_SUBJECT_MISMATCH",
        severity: "high"
      })
    );
    expect(result.decision.action).toBe("block");
  });

  it("persists configured LLM risk reviews and lets policy quarantine without LLM-only blocking", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({
      ...process.env,
      RUNTIME_MODE: "ci",
      LLM_REVIEW_ENABLED: "true",
      LLM_REVIEW_PROVIDER: "test-provider",
      LLM_REVIEW_MODEL: "test-model",
      LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES: "true"
    });
    const registry = { fetchMetadata: vi.fn(async () => metadata()), fetchTarball: vi.fn(async (url: string) => tarballs[url]) };
    const seenInputs: unknown[] = [];
    const llmRiskReviewProvider: LlmRiskReviewProvider = {
      async review(input) {
        seenInputs.push(input);
        return {
          riskLevel: "critical",
          confidence: "high",
          summary: "The package deserves human review, but the model alone should not be the block button.",
          suspectedRiskTypes: ["unknown"],
          evidence: [{ signal: "UNKNOWN", explanation: "No previous version was available for comparison.", source: "metadata" }],
          recommendedAction: "block"
        };
      }
    };

    const result = await analysePackageTarget("pkg@1.0.0", { config, registry, persistence, llmRiskReviewProvider });

    expect(result.decision.action).toBe("quarantine");
    expect(result.decision.reasons).toContainEqual(expect.objectContaining({ code: "LLM_RISK_REVIEW_FLAGGED", severity: "critical" }));
    expect(seenInputs).toEqual([
      expect.objectContaining({
        packageName: "pkg",
        version: "1.0.0",
        deterministicSignals: []
      })
    ]);
    expect(await persistence.listLlmRiskReviews({ packageName: "pkg", version: "1.0.0" })).toEqual([
      expect.objectContaining({
        tarballIntegrity: "sha512-old",
        tarballShasum: "oldsum",
        analyserVersion: expect.any(String),
        provider: "test-provider",
        model: "test-model",
        review: expect.objectContaining({ riskLevel: "critical", recommendedAction: "block" })
      })
    ]);
  });

  it("runs LLM review for explicitly flagged analysis jobs", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({
      ...process.env,
      RUNTIME_MODE: "ci",
      LLM_REVIEW_ENABLED: "true",
      LLM_REVIEW_PROVIDER: "test-provider",
      LLM_REVIEW_MODEL: "test-model"
    });
    const registry = { fetchMetadata: vi.fn(async () => metadata()), fetchTarball: vi.fn(async (url: string) => tarballs[url]) };
    const review = {
      riskLevel: "high",
      confidence: "medium",
      summary: "Manual LLM review requested.",
      suspectedRiskTypes: ["unknown"],
      evidence: [{ signal: "MANUAL_REVIEW", explanation: "Reviewer explicitly requested model context.", source: "metadata" }],
      recommendedAction: "quarantine"
    } satisfies LlmRiskReview;
    const llmRiskReviewProvider: LlmRiskReviewProvider = {
      review: vi.fn(async () => review)
    };

    const result = await analyseAnalysisJob(
      {
        packageName: "pkg",
        version: "1.0.0",
        reason: "manual_review",
        priority: "high",
        requestedBy: "reviewer",
        runLlmReview: true,
        createdAt: "2026-05-20T00:00:00.000Z"
      },
      { config, registry, persistence, llmRiskReviewProvider }
    );

    expect(llmRiskReviewProvider.review).toHaveBeenCalledWith(expect.objectContaining({ packageName: "pkg", version: "1.0.0" }));
    expect(result.decision.action).toBe("quarantine");
    expect(await persistence.listLlmRiskReviews({ packageName: "pkg", version: "1.0.0" })).toHaveLength(1);
    expect(await persistence.listAuditEvents({ targetId: "pkg@1.0.0" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: "reviewer",
          eventType: "llm_review.completed",
          metadata: expect.objectContaining({
            reason: "manual_review",
            priority: "high",
            provider: "test-provider",
            model: "test-model",
            tarballIntegrity: "sha512-old",
            tarballShasum: "oldsum",
            analyserVersion: expect.any(String),
            riskLevel: "high",
            recommendedAction: "quarantine"
          })
        })
      ])
    );
  });

  it("audits forced LLM review jobs when no review is produced", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({
      ...process.env,
      RUNTIME_MODE: "ci",
      LLM_REVIEW_ENABLED: "true",
      LLM_REVIEW_PROVIDER: "http",
      LLM_REVIEW_MODEL: "test-model"
    });
    const registry = { fetchMetadata: vi.fn(async () => metadata()), fetchTarball: vi.fn(async (url: string) => tarballs[url]) };

    const result = await analyseAnalysisJob(
      {
        packageName: "pkg",
        version: "1.0.0",
        reason: "manual_review",
        priority: "high",
        requestedBy: "reviewer",
        runLlmReview: true,
        createdAt: "2026-05-20T00:00:00.000Z"
      },
      { config, registry, persistence }
    );

    expect(result.decision.reasons.map((reason) => reason.code)).not.toContain("LLM_RISK_REVIEW_FLAGGED");
    expect(await persistence.listLlmRiskReviews({ packageName: "pkg", version: "1.0.0" })).toHaveLength(0);
    expect(await persistence.listAuditEvents({ targetId: "pkg@1.0.0" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: "reviewer",
          eventType: "llm_review.unavailable",
          metadata: expect.objectContaining({
            reason: "manual_review",
            priority: "high",
            provider: "http",
            model: "test-model",
            endpointConfigured: false,
            privatePackageSkipped: false
          })
        })
      ])
    );
  });

  it("does not send private package metadata to LLM review unless explicitly enabled", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({
      ...process.env,
      RUNTIME_MODE: "ci",
      LLM_REVIEW_ENABLED: "true",
      LLM_REVIEW_PROVIDER: "test-provider",
      LLM_REVIEW_MODEL: "test-model",
      LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES: "true"
    });
    const registry = { fetchMetadata: vi.fn(async () => privateMetadata()), fetchTarball: vi.fn() };
    const review = {
      riskLevel: "high",
      confidence: "high",
      summary: "Should not be called for private packages by default.",
      suspectedRiskTypes: ["unknown"],
      evidence: [{ signal: "UNKNOWN", explanation: "Private package.", source: "metadata" }],
      recommendedAction: "quarantine"
    } satisfies LlmRiskReview;
    const llmRiskReviewProvider: LlmRiskReviewProvider = {
      review: vi.fn(async () => review)
    };

    const result = await analysePackageTarget("@scope/private-pkg@1.0.0", { config, registry, persistence, llmRiskReviewProvider });

    expect(llmRiskReviewProvider.review).not.toHaveBeenCalled();
    expect(result.decision.reasons.map((reason) => reason.code)).not.toContain("LLM_RISK_REVIEW_FLAGGED");
    expect(await persistence.listLlmRiskReviews({ packageName: "@scope/private-pkg", version: "1.0.0" })).toEqual([]);
  });

  it("does not let forced LLM review jobs bypass private package opt-in", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({
      ...process.env,
      RUNTIME_MODE: "ci",
      LLM_REVIEW_ENABLED: "true",
      LLM_REVIEW_PROVIDER: "test-provider",
      LLM_REVIEW_MODEL: "test-model"
    });
    const registry = { fetchMetadata: vi.fn(async () => privateMetadata()), fetchTarball: vi.fn() };
    const review = {
      riskLevel: "critical",
      confidence: "high",
      summary: "This should not be sent for a private package.",
      suspectedRiskTypes: ["unknown"],
      evidence: [{ signal: "PRIVATE", explanation: "Private package.", source: "metadata" }],
      recommendedAction: "block"
    } satisfies LlmRiskReview;
    const llmRiskReviewProvider: LlmRiskReviewProvider = {
      review: vi.fn(async () => review)
    };

    await analyseAnalysisJob(
      {
        packageName: "@scope/private-pkg",
        version: "1.0.0",
        reason: "manual_review",
        priority: "high",
        requestedBy: "reviewer",
        runLlmReview: true,
        createdAt: "2026-05-20T00:00:00.000Z"
      },
      { config, registry, persistence, llmRiskReviewProvider }
    );

    expect(llmRiskReviewProvider.review).not.toHaveBeenCalled();
    expect(await persistence.listLlmRiskReviews({ packageName: "@scope/private-pkg", version: "1.0.0" })).toEqual([]);
    expect(await persistence.listAuditEvents({ targetId: "@scope/private-pkg@1.0.0" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: "reviewer",
          eventType: "llm_review.unavailable",
          metadata: expect.objectContaining({
            reason: "manual_review",
            priority: "high",
            provider: "test-provider",
            model: "test-model",
            privatePackageSkipped: true
          })
        })
      ])
    );
  });

  it("can send private package metadata to LLM review when explicitly enabled", async () => {
    const persistence = new MemoryPersistence();
    const config = loadConfig({
      ...process.env,
      RUNTIME_MODE: "ci",
      LLM_REVIEW_ENABLED: "true",
      LLM_REVIEW_PROVIDER: "test-provider",
      LLM_REVIEW_MODEL: "test-model",
      LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES: "true",
      LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES: "true"
    });
    const registry = { fetchMetadata: vi.fn(async () => privateMetadata()), fetchTarball: vi.fn() };
    const review = {
      riskLevel: "high",
      confidence: "medium",
      summary: "Private package review was explicitly enabled.",
      suspectedRiskTypes: ["unknown"],
      evidence: [{ signal: "UNKNOWN", explanation: "Private package review opt-in.", source: "metadata" }],
      recommendedAction: "quarantine"
    } satisfies LlmRiskReview;
    const llmRiskReviewProvider: LlmRiskReviewProvider = {
      review: vi.fn(async () => review)
    };

    await analysePackageTarget("@scope/private-pkg@1.0.0", { config, registry, persistence, llmRiskReviewProvider });

    expect(llmRiskReviewProvider.review).toHaveBeenCalledWith(expect.objectContaining({ packageName: "@scope/private-pkg", version: "1.0.0" }));
    expect(await persistence.listLlmRiskReviews({ packageName: "@scope/private-pkg", version: "1.0.0" })).toHaveLength(1);
  });
});

class TestObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
  }
}

const tarballs: Record<string, Uint8Array> = {
  "https://registry.example/pkg/-/pkg-1.0.0.tgz": makeTarball([
    {
      path: "package/package.json",
      content: JSON.stringify({ name: "pkg", version: "1.0.0" })
    }
  ]),
  "https://registry.example/pkg/-/pkg-1.0.1.tgz": makeTarball([
    {
      path: "package/package.json",
      content: JSON.stringify({ name: "pkg", version: "1.0.1" })
    },
    {
      path: "package/install.js",
      content: "require('child_process').execSync('node ./postinstall.js')"
    },
    {
      path: "package/link-out",
      type: "symlink",
      linkTarget: "../../outside"
    }
  ]),
  "https://registry.example/@tenstack/react-query/-/react-query-1.0.0.tgz": makeTarball([
    {
      path: "package/package.json",
      content: JSON.stringify({ name: "@tenstack/react-query", version: "1.0.0" })
    }
  ]),
  "https://registry.example/fresh-worker-pkg/-/fresh-worker-pkg-1.0.0.tgz": makeTarball([
    {
      path: "package/package.json",
      content: JSON.stringify({ name: "fresh-worker-pkg", version: "1.0.0" })
    }
  ])
};

function metadata(): NpmPackageMetadata {
  return {
    name: "pkg",
    "dist-tags": { latest: "1.0.1" },
    time: {
      "1.0.0": "2020-01-01T00:00:00.000Z",
      "1.0.1": "2020-01-02T00:00:00.000Z"
    },
    versions: {
      "1.0.0": {
        name: "pkg",
        version: "1.0.0",
        dist: {
          tarball: "https://registry.example/pkg/-/pkg-1.0.0.tgz",
          integrity: "sha512-old",
          shasum: "oldsum"
        },
        dependencies: {},
        peerDependencies: { react: "^18.0.0" },
        repository: { type: "git", url: "https://example.test/pkg.git" }
      },
      "1.0.1": {
        name: "pkg",
        version: "1.0.1",
        dist: {
          tarball: "https://registry.example/pkg/-/pkg-1.0.1.tgz",
          integrity: "sha512-new",
          shasum: "newsum"
        },
        scripts: {
          install: "node install.js"
        },
        dependencies: {
          "tiny-left-pad": "^1.0.0"
        },
        optionalDependencies: {
          fsevents: "^2.0.0"
        },
        peerDependencies: {
          react: "^19.0.0"
        },
        bin: {
          pkg: "./cli.js"
        },
        repository: { type: "git", url: "https://example.test/pkg-renamed.git" }
      }
    }
  };
}

function freshMetadata(publishedAt: string): NpmPackageMetadata {
  return {
    name: "fresh-worker-pkg",
    "dist-tags": { latest: "1.0.0" },
    time: {
      created: publishedAt,
      "1.0.0": publishedAt
    },
    versions: {
      "1.0.0": {
        name: "fresh-worker-pkg",
        version: "1.0.0",
        dist: {
          tarball: "https://registry.example/fresh-worker-pkg/-/fresh-worker-pkg-1.0.0.tgz",
          integrity: "sha512-fresh",
          shasum: "freshsum"
        }
      }
    }
  };
}

function manifestHistoryMetadata(): NpmPackageMetadata {
  return {
    name: "history-pkg",
    "dist-tags": { latest: "1.0.3" },
    time: {
      "1.0.0": "2020-01-01T00:00:00.000Z",
      "1.0.1": "2020-01-02T00:00:00.000Z",
      "1.0.2": "2020-01-03T00:00:00.000Z",
      "1.0.3": "2020-01-04T00:00:00.000Z"
    },
    versions: {
      "1.0.0": {
        name: "history-pkg",
        version: "1.0.0",
        dependencies: {}
      },
      "1.0.1": {
        name: "history-pkg",
        version: "1.0.1",
        scripts: { install: "node old-install.js" },
        dependencies: { "tiny-left-pad": "^0.9.0" }
      },
      "1.0.2": {
        name: "history-pkg",
        version: "1.0.2",
        dependencies: {}
      },
      "1.0.3": {
        name: "history-pkg",
        version: "1.0.3",
        scripts: { install: "node install.js" },
        dependencies: { "tiny-left-pad": "^1.0.0" }
      }
    }
  };
}

function typoMetadata(): NpmPackageMetadata {
  return {
    name: "@tenstack/react-query",
    "dist-tags": { latest: "1.0.0" },
    time: {
      created: "2020-01-01T00:00:00.000Z",
      "1.0.0": "2020-01-01T00:00:00.000Z"
    },
    versions: {
      "1.0.0": {
        name: "@tenstack/react-query",
        version: "1.0.0",
        dist: {
          tarball: "https://registry.example/@tenstack/react-query/-/react-query-1.0.0.tgz",
          integrity: "sha512-typo",
          shasum: "typosum"
        }
      }
    }
  };
}

function privateMetadata(): NpmPackageMetadata {
  return {
    name: "@scope/private-pkg",
    "dist-tags": { latest: "1.0.0" },
    time: {
      "1.0.0": "2020-01-01T00:00:00.000Z"
    },
    versions: {
      "1.0.0": {
        name: "@scope/private-pkg",
        version: "1.0.0",
        private: true
      }
    }
  };
}

function popularMetadataWithoutProvenance(): NpmPackageMetadata {
  return {
    name: "popular-package",
    "dist-tags": { latest: "1.0.0" },
    time: {
      "1.0.0": "2020-01-01T00:00:00.000Z"
    },
    versions: {
      "1.0.0": {
        name: "popular-package",
        version: "1.0.0",
        dist: {
          integrity: "sha512-popular",
          shasum: "popularsum"
        }
      }
    }
  };
}

function provenanceChangedMetadata(): NpmPackageMetadata {
  return {
    name: "provenance-pkg",
    "dist-tags": { latest: "1.0.1" },
    time: {
      "1.0.0": "2020-01-01T00:00:00.000Z",
      "1.0.1": "2020-01-02T00:00:00.000Z"
    },
    versions: {
      "1.0.0": {
        name: "provenance-pkg",
        version: "1.0.0",
        dist: {
          attestations: {
            url: "https://registry.example/-/npm/v1/attestations/provenance-pkg@1.0.0"
          }
        }
      },
      "1.0.1": {
        name: "provenance-pkg",
        version: "1.0.1",
        dist: {
          attestations: {
            url: "https://registry.example/-/npm/v1/attestations/provenance-pkg@1.0.1-new-publisher"
          }
        }
      }
    }
  };
}

function provenanceSubjectMismatchMetadata(): NpmPackageMetadata {
  return {
    name: "subject-pkg",
    "dist-tags": { latest: "1.0.0" },
    time: {
      "1.0.0": "2020-01-01T00:00:00.000Z"
    },
    versions: {
      "1.0.0": {
        name: "subject-pkg",
        version: "1.0.0",
        dist: {
          integrity: "sha512-expected",
          attestations: {
            subject: {
              name: "other-pkg@1.0.0",
              digest: { sha512: "different" }
            }
          }
        }
      }
    }
  };
}

function makeTarball(entries: Array<{ path: string; content?: string; mode?: number; type?: "file" | "symlink"; linkTarget?: string }>): Uint8Array {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    writeOctal(header, entry.mode ?? 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, entry.type === "symlink" ? 0 : content.length, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(" ", 148, 156);
    header.write(entry.type === "symlink" ? "2" : "0", 156, 1, "utf8");
    if (entry.linkTarget) header.write(entry.linkTarget, 157, 100, "utf8");
    header.write("ustar", 257, 6, "utf8");

    const checksum = header.reduce((total, byte) => total + byte, 0);
    writeOctal(header, checksum, 148, 8);

    blocks.push(header);
    if (entry.type !== "symlink") blocks.push(content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }

  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number) {
  const valueText = value.toString(8).padStart(length - 1, "0");
  buffer.write(`${valueText}\0`, offset, length, "ascii");
}
