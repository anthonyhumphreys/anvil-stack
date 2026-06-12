import { z } from "zod";

export const runtimeModeSchema = z.enum(["development", "ci", "production"]);
export type RuntimeMode = z.infer<typeof runtimeModeSchema>;

export const policyActionSchema = z.enum(["allow", "warn", "quarantine", "block"]);
export type PolicyAction = z.infer<typeof policyActionSchema>;

export type PolicyReasonCode =
  | "PACKAGE_TOO_NEW"
  | "LOW_WEEKLY_DOWNLOADS"
  | "SIMILAR_TO_POPULAR_PACKAGE"
  | "NEW_PACKAGE_LOW_DOWNLOADS"
  | "NEW_INSTALL_SCRIPT"
  | "INSTALL_SCRIPT_CHANGED"
  | "NEW_DEPENDENCY_IN_PATCH_VERSION"
  | "RUNTIME_DEPENDENCY_CHANGED"
  | "DEV_DEPENDENCY_CHANGED"
  | "PACKAGE_MANIFEST_CHANGED"
  | "MANIFEST_FIELD_CHANGED"
  | "BIN_FIELD_CHANGED"
  | "OPTIONAL_DEPENDENCY_ADDED"
  | "OPTIONAL_DEPENDENCY_CHANGED"
  | "PEER_DEPENDENCY_CHANGED"
  | "SUSPICIOUS_FILE_ADDED"
  | "UNSAFE_TARBALL_PATH"
  | "UNSAFE_TARBALL_SYMLINK"
  | "LARGE_FILE_SIZE_DELTA"
  | "OBFUSCATED_CODE_DETECTED"
  | "UNEXPECTED_BINARY_FILE"
  | "USES_CHILD_PROCESS"
  | "USES_PROCESS_ENV"
  | "SENSITIVE_FILE_ACCESS_IN_INSTALL_PATH"
  | "NETWORK_ACCESS_IN_INSTALL_PATH"
  | "REPOSITORY_CHANGED"
  | "PROVENANCE_MISSING"
  | "PROVENANCE_CHANGED"
  | "PROVENANCE_SUBJECT_MISMATCH"
  | "TRUSTED_PUBLISHING_PRESENT"
  | "ANALYSIS_REQUIRED"
  | "LLM_RISK_REVIEW_FLAGGED"
  | "APPROVED_OVERRIDE";

export type PolicyReason = {
  code: PolicyReasonCode;
  message: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  evidence?: Record<string, unknown>;
};

export type PolicyDecision = {
  action: PolicyAction;
  score: number;
  reasons: PolicyReason[];
  explanation: string;
  expiresAt?: string;
};

export type Override = {
  packageName: string;
  version?: string;
  action: PolicyAction;
  reason: string;
  approvedBy?: string;
  expiresAt?: string;
};

const requiredTrimmedString = (max: number) => z.string().trim().min(1).max(max);
const optionalTrimmedString = (max: number) =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }, z.string().max(max).optional());
const packageNameString = () => requiredTrimmedString(214).refine(isValidPackageName, { message: "Invalid npm package name." });
const optionalPackageNameString = () => optionalTrimmedString(214).refine((value) => value === undefined || isValidPackageName(value), { message: "Invalid npm package name." });
const versionRefString = () => requiredTrimmedString(128).refine(isValidVersionRef, { message: "Invalid package version or dist-tag." });
const optionalVersionRefString = () => optionalTrimmedString(128).refine((value) => value === undefined || isValidVersionRef(value), { message: "Invalid package version or dist-tag." });

export const analysisJobReasonSchema = z.enum(["metadata_request", "tarball_request", "lockfile_scan", "manual_review"]);
export type AnalysisJobReason = z.infer<typeof analysisJobReasonSchema>;

export const analysisJobPrioritySchema = z.enum(["low", "normal", "high"]);
export type AnalysisJobPriority = z.infer<typeof analysisJobPrioritySchema>;

export const analysisJobSchema = z
  .object({
    id: optionalTrimmedString(128),
    packageName: packageNameString(),
    version: versionRefString(),
    requestedBy: optionalTrimmedString(200),
    reason: analysisJobReasonSchema,
    priority: analysisJobPrioritySchema,
    runLlmReview: z.boolean().optional(),
    createdAt: requiredTrimmedString(100)
  })
  .strict();

export type AnalysisJob = z.infer<typeof analysisJobSchema>;

export const packageTargetSchema = z
  .object({
    packageName: packageNameString(),
    version: optionalVersionRefString()
  })
  .strict();

export type PackageTarget = z.infer<typeof packageTargetSchema>;

export const packageTargetRequestSchema = z
  .object({
    packageName: optionalPackageNameString(),
    version: optionalVersionRefString(),
    targets: z.array(packageTargetSchema).max(100).optional(),
    reason: analysisJobReasonSchema.optional(),
    priority: analysisJobPrioritySchema.optional(),
    requestedBy: optionalTrimmedString(200)
  })
  .strict();

export type PackageTargetRequest = z.infer<typeof packageTargetRequestSchema>;

export const llmReviewRequestBodySchema = z
  .object({
    requestedBy: optionalTrimmedString(200),
    priority: analysisJobPrioritySchema.optional()
  })
  .strict();

export type LlmReviewRequestBody = z.infer<typeof llmReviewRequestBodySchema>;

export const overrideCreateRequestSchema = z
  .object({
    packageName: packageNameString(),
    version: optionalVersionRefString(),
    action: policyActionSchema.default("allow"),
    reason: requiredTrimmedString(1000),
    approvedBy: optionalTrimmedString(200),
    expiresAt: optionalTrimmedString(100)
  })
  .strict();

export type OverrideCreateRequest = z.infer<typeof overrideCreateRequestSchema>;

export const overrideRevokeRequestSchema = z
  .object({
    packageName: packageNameString(),
    version: optionalVersionRefString(),
    revokedBy: optionalTrimmedString(200)
  })
  .strict();

export type OverrideRevokeRequest = z.infer<typeof overrideRevokeRequestSchema>;

export function resolveOverrideExpiry(expiresAt: string | undefined, defaultExpiryDays: number, now = Date.now()): string | undefined | null {
  const explicitExpiry = expiresAt?.trim();
  if (explicitExpiry) {
    const timestamp = Date.parse(explicitExpiry);
    return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
  }

  if (defaultExpiryDays <= 0) return undefined;
  return new Date(now + defaultExpiryDays * 24 * 60 * 60 * 1000).toISOString();
}

function isValidPackageName(value: string) {
  return /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value);
}

function isValidVersionRef(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/.test(value);
}

export type PolicyConfig = {
  version: string;
  minimumPackageAgeDays: number;
  comparePreviousVersions: number;
  lowDownloadThreshold: number;
  strictLowDownloadThreshold: number;
  blockSimilarLowDownloadPackages: boolean;
  blockNewInstallScripts: boolean;
  quarantineChangedInstallScripts: boolean;
  blockUnexpectedBinaries: boolean;
  quarantineObfuscatedCode: boolean;
  hideQuarantinedMetadata: boolean;
  provenance: {
    enabled: boolean;
    highDownloadThreshold: number;
    trustedPublishingScoreReduction: number;
    quarantineChangedProvenance: boolean;
    quarantineMissingForHighDownloadPackages: boolean;
  };
  overrides: {
    enabled: boolean;
    requireReason: boolean;
    defaultExpiryDays: number;
  };
  llmReview: {
    enabled: boolean;
    includePrivatePackages: boolean;
    runOnUnknownPackages: boolean;
    runOnQuarantine: boolean;
    provider?: string;
    model?: string;
  };
};

export type PackageMetadataSummary = {
  name: string;
  distTags?: Record<string, string>;
  publishedAt?: string;
};

export type PackageVersionMetadata = {
  name: string;
  version: string;
  private?: boolean;
  publishedAt?: string;
  tarballUrl?: string;
  integrity?: string;
  shasum?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: unknown;
  files?: unknown;
  repository?: unknown;
  license?: string;
  maintainers?: unknown;
  provenance?: {
    present: boolean;
    source?: "dist.attestations" | "dist.provenance" | "version.provenance";
    attestationUrl?: string;
    raw?: unknown;
  };
};

export type ProvenanceVerificationResult = {
  status: "missing" | "unverified" | "subject_matched" | "subject_mismatch" | "unsupported";
  verified: boolean;
  verifier: string;
  summary: string;
  source?: NonNullable<PackageVersionMetadata["provenance"]>["source"];
  attestationUrl?: string;
  subjectName?: string;
  expectedSubjectName?: string;
  subjectDigest?: Record<string, string>;
  expectedDigest?: Record<string, string>;
  evidence?: Record<string, unknown>;
};

export type AnalysisReport = {
  packageName: string;
  version: string;
  analyserVersion: string;
  policyVersion: string;
  tarballIntegrity?: string;
  tarballShasum?: string;
  provenance?: {
    status: "present" | "missing" | "changed" | "removed";
    target?: PackageVersionMetadata["provenance"];
    previous?: PackageVersionMetadata["provenance"];
    verification?: ProvenanceVerificationResult;
  };
  score: number;
  signals: PolicyReason[];
  manifestDiff?: Record<string, unknown>;
  dependencyDiff?: Record<string, unknown>;
  fileFindings?: Array<{ path: string; code: PolicyReasonCode; reason: string; severity: PolicyReason["severity"]; evidence?: Record<string, unknown> }>;
  objectKey?: string;
  createdAt: string;
};

export type LlmRiskType =
  | "typosquatting"
  | "dependency_confusion"
  | "credential_exfiltration"
  | "install_script_abuse"
  | "obfuscation"
  | "unexpected_network_access"
  | "suspicious_maintainer_change"
  | "overbroad_dependency_tree"
  | "unknown";

export type LlmEvidenceSource = "metadata" | "package_json" | "diff" | "code_snippet" | "download_stats";

export type LlmRiskReview = {
  riskLevel: "low" | "medium" | "high" | "critical";
  confidence: "low" | "medium" | "high";
  summary: string;
  suspectedRiskTypes: LlmRiskType[];
  evidence: Array<{ signal: string; explanation: string; source: LlmEvidenceSource }>;
  recommendedAction: PolicyAction;
};

export type LlmRiskReviewInput = {
  packageName: string;
  version: string;
  packageAgeDays?: number;
  weeklyDownloads?: number;
  similarPopularPackages: Array<{
    name: string;
    similarity: number;
    weeklyDownloads?: number;
    reasons?: string[];
    suggestedPackage?: string;
  }>;
  deterministicSignals: PolicyReasonCode[];
  manifestDiff?: Record<string, unknown>;
  dependencyDiff?: Record<string, unknown>;
  suspiciousSnippets?: Array<{
    file: string;
    reason: string;
    snippet: string;
  }>;
};

export type PolicyInput = {
  packageName: string;
  version: string;
  runtimeMode: RuntimeMode;
  evaluatedAt?: string;
  metadata?: PackageMetadataSummary;
  versionMetadata?: PackageVersionMetadata;
  weeklyDownloads?: number;
  packageAgeDays?: number;
  analysisRequired?: boolean;
  analysisReport?: AnalysisReport;
  llmRiskReview?: LlmRiskReview;
  override?: Override;
  similarPackages?: Array<{ name: string; similarity: number; weeklyDownloads?: number; reasons?: string[]; suggestedPackage?: string }>;
  policy: PolicyConfig;
};

export const nodeBaseReportSubmissionSchema = z
  .object({
    source: z.string().trim().min(1).max(100).optional(),
    projectName: z.string().trim().min(1).max(200).optional(),
    reportType: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9_-]*$/),
    summary: z.record(z.unknown()).optional(),
    report: z.record(z.unknown())
  })
  .strict();

export type NodeBaseReportSubmission = z.infer<typeof nodeBaseReportSubmissionSchema>;

export type AnvilErrorResponse = {
  error: "ANVIL_PACKAGE_BLOCKED" | "ANVIL_PACKAGE_QUARANTINED";
  package: string;
  version: string;
  decision: PolicyAction;
  score: number;
  reasons: PolicyReason[];
  suggestions: Array<{ package: string; reason: string }>;
  overrideHint: string;
};

export type PolicyDecisionAuditIdentity = {
  tarballIntegrity?: string;
  tarballShasum?: string;
  analyserVersion?: string;
};

export type PolicyDecisionAuditEvent = {
  actor: "anvil-gateway" | "anvil-worker" | string;
  eventType: "policy.decision";
  targetType: "package";
  targetId: string;
  metadata: {
    source: string;
    action: PolicyDecision["action"];
    score: number;
    policyVersion: string;
    analyserVersion?: string;
    tarballIntegrity?: string;
    tarballShasum?: string;
    reasonCodes: PolicyReasonCode[];
  };
};

export function packageIdentity(packageName: string, version: string): string {
  return `${packageName}@${version}`;
}

export function buildPolicyDecisionAuditEvent(input: {
  actor: PolicyDecisionAuditEvent["actor"];
  source: string;
  packageName: string;
  version: string;
  policyVersion: string;
  decision: PolicyDecision;
  identity?: PolicyDecisionAuditIdentity;
}): PolicyDecisionAuditEvent {
  return {
    actor: input.actor,
    eventType: "policy.decision",
    targetType: "package",
    targetId: packageIdentity(input.packageName, input.version),
    metadata: {
      source: input.source,
      action: input.decision.action,
      score: input.decision.score,
      policyVersion: input.policyVersion,
      analyserVersion: input.identity?.analyserVersion,
      tarballIntegrity: input.identity?.tarballIntegrity,
      tarballShasum: input.identity?.tarballShasum,
      reasonCodes: input.decision.reasons.map((reason) => reason.code)
    }
  };
}

export function isDecisionBlockingInstall(decision: PolicyDecision, runtimeMode: RuntimeMode): boolean {
  if (decision.action === "block") return true;
  if (decision.action === "quarantine") return runtimeMode !== "development";
  return false;
}

export function buildAnvilError(packageName: string, version: string, decision: PolicyDecision): AnvilErrorResponse {
  return {
    error: decision.action === "quarantine" ? "ANVIL_PACKAGE_QUARANTINED" : "ANVIL_PACKAGE_BLOCKED",
    package: packageName,
    version,
    decision: decision.action,
    score: decision.score,
    reasons: decision.reasons,
    suggestions: decision.reasons
      .filter((reason) => reason.code === "SIMILAR_TO_POPULAR_PACKAGE" && typeof reason.evidence?.candidate === "string")
      .map((reason) => ({
        package: String(reason.evidence?.candidate),
        reason: "Popular package with a similar name."
      })),
    overrideHint: `Run: anvil approve ${packageIdentity(packageName, version)} --reason "intentional"`
  };
}
