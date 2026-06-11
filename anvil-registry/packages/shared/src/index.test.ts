import { describe, expect, it } from "vitest";
import {
  analysisJobSchema,
  buildPolicyDecisionAuditEvent,
  llmReviewRequestBodySchema,
  nodeBaseReportSubmissionSchema,
  overrideCreateRequestSchema,
  overrideRevokeRequestSchema,
  packageTargetRequestSchema,
  resolveOverrideExpiry
} from "./index.js";

describe("buildPolicyDecisionAuditEvent", () => {
  it("builds the shared policy decision audit event shape", () => {
    expect(
      buildPolicyDecisionAuditEvent({
        actor: "anvil-worker",
        source: "analysis",
        packageName: "@scope/pkg",
        version: "1.0.0",
        policyVersion: "policy-v1",
        decision: {
          action: "block",
          score: 95,
          explanation: "blocked",
          reasons: [{ code: "NEW_INSTALL_SCRIPT", message: "install script", severity: "high" }]
        },
        identity: {
          tarballIntegrity: "sha512-test",
          tarballShasum: "abc123",
          analyserVersion: "static-v1"
        }
      })
    ).toEqual({
      actor: "anvil-worker",
      eventType: "policy.decision",
      targetType: "package",
      targetId: "@scope/pkg@1.0.0",
      metadata: {
        source: "analysis",
        action: "block",
        score: 95,
        policyVersion: "policy-v1",
        analyserVersion: "static-v1",
        tarballIntegrity: "sha512-test",
        tarballShasum: "abc123",
        reasonCodes: ["NEW_INSTALL_SCRIPT"]
      }
    });
  });
});

describe("resolveOverrideExpiry", () => {
  it("normalizes explicit expiry timestamps", () => {
    expect(resolveOverrideExpiry("2026-06-20T00:00:00Z", 30)).toBe("2026-06-20T00:00:00.000Z");
  });

  it("applies the configured default expiry when no explicit timestamp is provided", () => {
    expect(resolveOverrideExpiry(undefined, 30, Date.parse("2026-05-20T00:00:00.000Z"))).toBe("2026-06-19T00:00:00.000Z");
  });

  it("rejects invalid explicit expiry timestamps", () => {
    expect(resolveOverrideExpiry("next whenever-ish", 30)).toBeNull();
  });
});

describe("override request schemas", () => {
  it("normalizes override create requests", () => {
    expect(
      overrideCreateRequestSchema.parse({
        packageName: " @scope/pkg ",
        version: "",
        reason: " intentional ",
        approvedBy: " reviewer ",
        expiresAt: ""
      })
    ).toEqual({
      packageName: "@scope/pkg",
      action: "allow",
      reason: "intentional",
      approvedBy: "reviewer"
    });
  });

  it("rejects invalid override create requests", () => {
    expect(overrideCreateRequestSchema.safeParse({ packageName: "pkg", reason: "intentional", action: "approve" }).success).toBe(false);
    expect(overrideCreateRequestSchema.safeParse({ packageName: "", reason: "intentional" }).success).toBe(false);
    expect(overrideCreateRequestSchema.safeParse({ packageName: "../pkg", reason: "intentional" }).success).toBe(false);
    expect(overrideCreateRequestSchema.safeParse({ packageName: "@scope/pkg", version: "../latest", reason: "intentional" }).success).toBe(false);
    expect(overrideCreateRequestSchema.safeParse({ packageName: "pkg", reason: "" }).success).toBe(false);
  });

  it("normalizes override revoke requests", () => {
    expect(overrideRevokeRequestSchema.parse({ packageName: " pkg ", version: "", revokedBy: " reviewer " })).toEqual({
      packageName: "pkg",
      revokedBy: "reviewer"
    });
  });
});

describe("package target request schema", () => {
  it("normalizes package target request fields", () => {
    expect(
      packageTargetRequestSchema.parse({
        targets: [
          { packageName: " pkg ", version: " 1.0.0 " },
          { packageName: "@scope/pkg", version: "" }
        ],
        reason: "lockfile_scan",
        priority: "high",
        requestedBy: " reviewer "
      })
    ).toEqual({
      targets: [{ packageName: "pkg", version: "1.0.0" }, { packageName: "@scope/pkg" }],
      reason: "lockfile_scan",
      priority: "high",
      requestedBy: "reviewer"
    });
  });

  it("rejects malformed package target requests", () => {
    expect(packageTargetRequestSchema.safeParse({ targets: [null] }).success).toBe(false);
    expect(packageTargetRequestSchema.safeParse({ targets: [{ packageName: "" }] }).success).toBe(false);
    expect(packageTargetRequestSchema.safeParse({ targets: [{ packageName: "@scope" }] }).success).toBe(false);
    expect(packageTargetRequestSchema.safeParse({ targets: [{ packageName: "@scope/pkg/extra" }] }).success).toBe(false);
    expect(packageTargetRequestSchema.safeParse({ packageName: "../pkg" }).success).toBe(false);
    expect(packageTargetRequestSchema.safeParse({ packageName: "pkg", version: "1.0.0/evil" }).success).toBe(false);
    expect(packageTargetRequestSchema.safeParse({ packageName: "pkg", priority: "urgent" }).success).toBe(false);
    expect(packageTargetRequestSchema.safeParse({ packageName: "pkg", unexpected: true }).success).toBe(false);
  });
});

describe("analysis job schema", () => {
  it("normalizes valid analysis jobs", () => {
    expect(
      analysisJobSchema.parse({
        id: " job-1 ",
        packageName: " @scope/pkg ",
        version: " 1.0.0 ",
        requestedBy: " reviewer ",
        reason: "tarball_request",
        priority: "high",
        runLlmReview: true,
        createdAt: " 2026-05-20T00:00:00.000Z "
      })
    ).toEqual({
      id: "job-1",
      packageName: "@scope/pkg",
      version: "1.0.0",
      requestedBy: "reviewer",
      reason: "tarball_request",
      priority: "high",
      runLlmReview: true,
      createdAt: "2026-05-20T00:00:00.000Z"
    });
  });

  it("rejects malformed analysis jobs", () => {
    expect(analysisJobSchema.safeParse({ version: "1.0.0", reason: "metadata_request", priority: "normal", createdAt: "now" }).success).toBe(false);
    expect(
      analysisJobSchema.safeParse({ packageName: "pkg/extra", version: "1.0.0", reason: "metadata_request", priority: "normal", createdAt: "now" }).success
    ).toBe(false);
    expect(
      analysisJobSchema.safeParse({ packageName: "pkg", version: "1.0.0", reason: "whatever", priority: "normal", createdAt: "now" }).success
    ).toBe(false);
    expect(
      analysisJobSchema.safeParse({ packageName: "pkg", version: "1.0.0", reason: "metadata_request", priority: "urgent", createdAt: "now" }).success
    ).toBe(false);
    expect(
      analysisJobSchema.safeParse({
        packageName: "pkg",
        version: "1.0.0",
        reason: "metadata_request",
        priority: "normal",
        createdAt: "now",
        extra: true
      }).success
    ).toBe(false);
  });
});

describe("LLM review request body schema", () => {
  it("normalizes reviewer and priority fields", () => {
    expect(llmReviewRequestBodySchema.parse({ requestedBy: " reviewer ", priority: "normal" })).toEqual({
      requestedBy: "reviewer",
      priority: "normal"
    });
    expect(llmReviewRequestBodySchema.parse({ requestedBy: "" })).toEqual({});
  });

  it("rejects invalid reviewer request fields", () => {
    expect(llmReviewRequestBodySchema.safeParse({ priority: "urgent" }).success).toBe(false);
    expect(llmReviewRequestBodySchema.safeParse({ requestedBy: "reviewer", extra: true }).success).toBe(false);
  });
});

describe("nodeBaseReportSubmissionSchema", () => {
  it("normalizes valid Node Base report submissions", () => {
    expect(
      nodeBaseReportSubmissionSchema.parse({
        source: " devcontainer ",
        projectName: " demo ",
        reportType: "network",
        summary: { medium: 1 },
        report: { summary: { medium: 1 } }
      })
    ).toEqual({
      source: "devcontainer",
      projectName: "demo",
      reportType: "network",
      summary: { medium: 1 },
      report: { summary: { medium: 1 } }
    });
  });

  it("rejects blank, malformed, or non-object report submissions", () => {
    expect(nodeBaseReportSubmissionSchema.safeParse({ reportType: "", report: {} }).success).toBe(false);
    expect(nodeBaseReportSubmissionSchema.safeParse({ reportType: "../dependency", report: {} }).success).toBe(false);
    expect(nodeBaseReportSubmissionSchema.safeParse({ reportType: "dependency", report: "not-json-object" }).success).toBe(false);
  });
});
