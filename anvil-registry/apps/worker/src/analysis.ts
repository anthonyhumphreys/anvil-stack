import semver from "semver";
import type { AnvilConfig } from "@anvilstack/config";
import { createLlmRiskReviewProvider, type LlmRiskReviewProvider } from "@anvilstack/llm-risk-review";
import { detectNameSquatting, loadPopularPackageIndex, type PopularPackageIndex } from "@anvilstack/name-squatting";
import type { NpmRegistryClient } from "@anvilstack/npm-registry";
import { calculatePackageAgeDays, resolveMetadataVersion, toVersionMetadata } from "@anvilstack/npm-registry";
import type { ObjectStore } from "@anvilstack/object-store";
import { analyseFileTree, analyseManifestChange, mergeAnalysisReports, parseNpmTarball } from "@anvilstack/package-analysis";
import type { AnvilPersistence } from "@anvilstack/persistence";
import { evaluatePolicy } from "@anvilstack/policy-engine";
import { FetchingProvenanceVerifier, type ProvenanceVerifier } from "@anvilstack/provenance";
import {
  buildPolicyDecisionAuditEvent,
  type AnalysisJob,
  type AnalysisJobPriority,
  type AnalysisJobReason,
  type AnalysisReport,
  type LlmRiskReview,
  type LlmRiskReviewInput,
  type PackageVersionMetadata,
  type PolicyReason
} from "@anvilstack/shared";

export type WorkerAnalysisDependencies = {
  config: AnvilConfig;
  registry: Pick<NpmRegistryClient, "fetchMetadata" | "fetchTarball">;
  persistence: AnvilPersistence;
  downloadStats?: {
    getWeeklyDownloads(packageName: string): Promise<number | undefined>;
  };
  objectStore?: ObjectStore;
  provenanceVerifier?: ProvenanceVerifier;
  llmRiskReviewProvider?: LlmRiskReviewProvider;
  popularPackageIndex?: PopularPackageIndex;
};

export async function analysePackageTarget(target: string, dependencies: WorkerAnalysisDependencies) {
  const parsed = parsePackageTarget(target);
  return analysePackageVersion({ packageName: parsed.packageName, version: parsed.version }, dependencies);
}

export async function analyseAnalysisJob(job: AnalysisJob, dependencies: WorkerAnalysisDependencies) {
  return analysePackageVersion(
    { packageName: job.packageName, version: job.version },
    dependencies,
    {
      forceLlmReview: job.runLlmReview === true,
      requestedBy: job.requestedBy,
      requestReason: job.reason,
      priority: job.priority
    }
  );
}

async function analysePackageVersion(
  target: { packageName: string; version: string },
  dependencies: WorkerAnalysisDependencies,
  options: { forceLlmReview?: boolean; requestedBy?: string; requestReason?: AnalysisJobReason; priority?: AnalysisJobPriority } = {}
) {
  const metadata = await dependencies.registry.fetchMetadata(target.packageName);
  const version = resolveMetadataVersion(metadata, target.version);
  if (!version) throw new Error(`Cannot resolve version for ${target.packageName}@${target.version}`);

  const versions = Object.keys(metadata.versions ?? {}).filter((candidate) => semver.valid(candidate));
  const previousVersions = semver.rsort(versions.filter((candidate) => semver.lt(candidate, version))).slice(0, dependencies.config.policy.comparePreviousVersions);
  const previousVersion = previousVersions[0];
  const targetMetadata = toVersionMetadata(metadata, version);
  if (!targetMetadata) throw new Error(`Version metadata not found for ${target.packageName}@${version}`);

  const previousMetadata = previousVersion ? toVersionMetadata(metadata, previousVersion) : undefined;
  const previousMetadataVersions = previousVersions.map((candidate) => toVersionMetadata(metadata, candidate)).filter((candidate): candidate is PackageVersionMetadata => Boolean(candidate));
  const provenanceVerifier = dependencies.provenanceVerifier ?? new FetchingProvenanceVerifier();
  const provenanceVerification = await provenanceVerifier.verify({
    packageName: target.packageName,
    version,
    integrity: targetMetadata.integrity,
    shasum: targetMetadata.shasum,
    provenance: targetMetadata.provenance
  });
  const manifestReport = analyseManifestChange(targetMetadata, previousMetadataVersions, {
    analyserVersion: "manifest-2026-05-20.1",
    policyVersion: dependencies.config.policy.version
  });
  const targetFileTree = targetMetadata.tarballUrl ? parseNpmTarball(await dependencies.registry.fetchTarball(targetMetadata.tarballUrl)) : [];
  const baselineFileTrees = targetMetadata.tarballUrl
    ? await Promise.all(
        previousVersions
          .map((baselineVersion) => toVersionMetadata(metadata, baselineVersion)?.tarballUrl)
          .filter((tarballUrl): tarballUrl is string => Boolean(tarballUrl))
          .map(async (tarballUrl) => parseNpmTarball(await dependencies.registry.fetchTarball(tarballUrl)))
      )
    : [];
  const staticReport = targetMetadata.tarballUrl
    ? mergeAnalysisReports(manifestReport, analyseFileTree(targetFileTree, baselineFileTrees, { lifecycleScripts: targetMetadata.scripts }))
    : manifestReport;
  const weeklyDownloads = await dependencies.downloadStats?.getWeeklyDownloads(target.packageName);
  await dependencies.persistence.putPackageVersion({
    packageName: target.packageName,
    version,
    publishedAt: targetMetadata.publishedAt,
    tarballUrl: targetMetadata.tarballUrl,
    integrity: targetMetadata.integrity,
    shasum: targetMetadata.shasum,
    weeklyDownloads
  });
  const evaluatedAt = new Date().toISOString();
  const packageAgeDays = calculatePackageAgeDays(targetMetadata.publishedAt, new Date(evaluatedAt));
  const popularPackageIndex = dependencies.popularPackageIndex ?? loadPopularPackageIndex(dependencies.config.POPULAR_PACKAGE_INDEX_PATH);
  const similarPackages = detectNameSquatting(target.packageName, popularPackageIndex).map((signal) => ({
    name: signal.candidate,
    similarity: signal.similarity,
    weeklyDownloads: signal.weeklyDownloads,
    reasons: signal.reasons,
    suggestedPackage: signal.suggestedPackage
  }));
  const report = mergePolicyContextSignals(
    {
      ...staticReport,
      tarballIntegrity: targetMetadata.integrity,
      tarballShasum: targetMetadata.shasum,
      provenance: summarizeReportProvenance(targetMetadata, previousMetadata, provenanceVerification)
    },
    {
      weeklyDownloads,
      packageAgeDays,
      similarPackages,
      targetMetadata,
      previousMetadata,
      policy: dependencies.config.policy
    }
  );

  const analysisArtifactKeys = dependencies.objectStore ? analysisArtifactObjectKeysForReport(report) : undefined;
  const analysisReportObjectKey = analysisArtifactKeys?.report;
  const storedReport: AnalysisReport = analysisReportObjectKey ? { ...report, objectKey: analysisReportObjectKey } : report;
  await storeAnalysisArtifacts(storedReport, targetFileTree, dependencies.objectStore, analysisArtifactKeys);
  await dependencies.persistence.putAnalysisReport(storedReport);
  const override = await dependencies.persistence.getOverride(target.packageName, version);
  const preliminaryDecision = evaluatePolicy({
    packageName: target.packageName,
    version,
    runtimeMode: dependencies.config.RUNTIME_MODE,
    evaluatedAt,
    versionMetadata: targetMetadata,
    packageAgeDays,
    weeklyDownloads,
    similarPackages,
    analysisReport: storedReport,
    override,
    policy: dependencies.config.policy
  });
  const llmRiskReview = await maybeReviewWithLlm(
    {
      packageName: target.packageName,
      version,
      packageAgeDays,
      weeklyDownloads,
      similarPopularPackages: similarPackages,
      deterministicSignals: storedReport.signals.map((signal) => signal.code),
      manifestDiff: storedReport.manifestDiff,
      dependencyDiff: storedReport.dependencyDiff,
      suspiciousSnippets: suspiciousSnippetsFromReport(storedReport)
    },
    {
      report: storedReport,
      previousMetadata,
      targetMetadata,
      preliminaryDecision,
      dependencies,
      forceLlmReview: options.forceLlmReview
    }
  );
  if (llmRiskReview) {
    await dependencies.persistence.putLlmRiskReview({
      packageName: target.packageName,
      version,
      tarballIntegrity: targetMetadata.integrity,
      tarballShasum: targetMetadata.shasum,
      analyserVersion: storedReport.analyserVersion,
      provider: dependencies.config.policy.llmReview.provider ?? "http",
      model: dependencies.config.policy.llmReview.model ?? "unspecified",
      review: llmRiskReview
    });
    await dependencies.persistence.putAuditEvent({
      actor: options.requestedBy ?? "anvil-worker",
      eventType: "llm_review.completed",
      targetType: "package",
      targetId: `${target.packageName}@${version}`,
      metadata: {
        source: "worker",
        reason: options.requestReason,
        priority: options.priority,
        provider: dependencies.config.policy.llmReview.provider ?? "http",
        model: dependencies.config.policy.llmReview.model ?? "unspecified",
        tarballIntegrity: targetMetadata.integrity,
        tarballShasum: targetMetadata.shasum,
        analyserVersion: storedReport.analyserVersion,
        riskLevel: llmRiskReview.riskLevel,
        recommendedAction: llmRiskReview.recommendedAction
      }
    });
  } else if (options.forceLlmReview && dependencies.config.policy.llmReview.enabled) {
    await dependencies.persistence.putAuditEvent({
      actor: options.requestedBy ?? "anvil-worker",
      eventType: "llm_review.unavailable",
      targetType: "package",
      targetId: `${target.packageName}@${version}`,
      metadata: {
        source: "worker",
        reason: options.requestReason,
        priority: options.priority,
        provider: dependencies.config.policy.llmReview.provider ?? "http",
        model: dependencies.config.policy.llmReview.model ?? "unspecified",
        endpointConfigured: Boolean(dependencies.config.LLM_REVIEW_ENDPOINT),
        privatePackageSkipped: Boolean(targetMetadata.private && !dependencies.config.policy.llmReview.includePrivatePackages)
      }
    });
  }
  const decision = evaluatePolicy({
    packageName: target.packageName,
    version,
    runtimeMode: dependencies.config.RUNTIME_MODE,
    evaluatedAt,
    versionMetadata: targetMetadata,
    packageAgeDays,
    weeklyDownloads,
    similarPackages,
    analysisReport: storedReport,
    llmRiskReview,
    override,
    policy: dependencies.config.policy
  });
  const decisionIdentity = {
    tarballIntegrity: targetMetadata.integrity,
    tarballShasum: targetMetadata.shasum,
    analyserVersion: storedReport.analyserVersion
  };
  await dependencies.persistence.putPolicyDecision(target.packageName, version, dependencies.config.policy.version, decision, decisionIdentity);
  await dependencies.persistence.putAuditEvent(buildPolicyDecisionAuditEvent({
    actor: "anvil-worker",
    source: "analysis",
    packageName: target.packageName,
    version,
    policyVersion: dependencies.config.policy.version,
    decision,
    identity: decisionIdentity
  }));
  await dependencies.persistence.putAuditEvent({
    actor: "anvil-worker",
    eventType: "analysis.completed",
    targetType: "package",
    targetId: `${target.packageName}@${version}`,
    metadata: {
      action: decision.action,
      score: decision.score,
      analyserVersion: storedReport.analyserVersion,
      policyVersion: dependencies.config.policy.version,
      signalCount: storedReport.signals.length,
      ...(analysisArtifactKeys
        ? {
            analysisReportObjectKey: analysisArtifactKeys.report,
            analysisManifestDiffObjectKey: analysisArtifactKeys.manifestDiff,
            analysisFileTreeObjectKey: analysisArtifactKeys.fileTree
          }
        : {})
    }
  });

  return { report: storedReport, decision, packageName: target.packageName, version };
}

type AnalysisArtifactObjectKeys = {
  report: string;
  manifestDiff: string;
  fileTree: string;
};

async function storeAnalysisArtifacts(report: AnalysisReport, fileTree: ReturnType<typeof parseNpmTarball>, objectStore: ObjectStore | undefined, objectKeys: AnalysisArtifactObjectKeys | undefined) {
  if (!objectStore || !objectKeys) return;
  await Promise.all([
    objectStore.put(objectKeys.report, jsonBuffer(report)),
    objectStore.put(objectKeys.manifestDiff, jsonBuffer(report.manifestDiff ?? null)),
    objectStore.put(objectKeys.fileTree, jsonBuffer(analysisFileTreeArtifact(fileTree)))
  ]);
}

function analysisFileTreeArtifact(fileTree: ReturnType<typeof parseNpmTarball>) {
  return fileTree.map((file) => ({
    path: file.path,
    rawPath: file.rawPath,
    size: file.size,
    mode: fileMode(file.mode),
    type: file.type,
    ...(file.linkTarget ? { linkTarget: file.linkTarget } : {})
  }));
}

function fileMode(mode: number) {
  return `0o${mode.toString(8)}`;
}

export function analysisReportObjectKeyForReport(report: Pick<AnalysisReport, "packageName" | "version" | "policyVersion" | "analyserVersion" | "tarballIntegrity" | "tarballShasum">) {
  return `${analysisArtifactBaseKeyForReport(report)}/report.json`;
}

function analysisArtifactObjectKeysForReport(report: Pick<AnalysisReport, "packageName" | "version" | "policyVersion" | "analyserVersion" | "tarballIntegrity" | "tarballShasum">): AnalysisArtifactObjectKeys {
  const baseKey = analysisArtifactBaseKeyForReport(report);
  return {
    report: `${baseKey}/report.json`,
    manifestDiff: `${baseKey}/manifest-diff.json`,
    fileTree: `${baseKey}/file-tree.json`
  };
}

function analysisArtifactBaseKeyForReport(report: Pick<AnalysisReport, "packageName" | "version" | "policyVersion" | "analyserVersion" | "tarballIntegrity" | "tarballShasum">) {
  const identity = report.tarballIntegrity ?? report.tarballShasum ?? "no-integrity";
  return [
    "analysis",
    encodeURIComponent(report.packageName),
    encodeURIComponent(report.version),
    encodeURIComponent(report.policyVersion),
    encodeURIComponent(report.analyserVersion),
    encodeURIComponent(identity)
  ].join("/");
}

function jsonBuffer(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

async function maybeReviewWithLlm(
  input: LlmRiskReviewInput,
  context: {
    report: AnalysisReport;
    previousMetadata?: PackageVersionMetadata;
    targetMetadata: PackageVersionMetadata;
    preliminaryDecision: ReturnType<typeof evaluatePolicy>;
    dependencies: WorkerAnalysisDependencies;
    forceLlmReview?: boolean;
  }
): Promise<LlmRiskReview | undefined> {
  const policy = context.dependencies.config.policy.llmReview;
  if (!policy.enabled) return undefined;
  if (
    !shouldRunLlmReview(context.report, context.previousMetadata, context.targetMetadata, context.preliminaryDecision, context.dependencies.config, {
      forceLlmReview: context.forceLlmReview
    })
  ) {
    return undefined;
  }

  const provider =
    context.dependencies.llmRiskReviewProvider ??
    createLlmRiskReviewProvider({
      enabled: policy.enabled,
      endpoint: context.dependencies.config.LLM_REVIEW_ENDPOINT,
      apiKey: context.dependencies.config.LLM_REVIEW_API_KEY,
      model: policy.model
    });

  try {
    return await provider.review(input);
  } catch {
    return undefined;
  }
}

function shouldRunLlmReview(
  report: AnalysisReport,
  previousMetadata: PackageVersionMetadata | undefined,
  targetMetadata: PackageVersionMetadata,
  preliminaryDecision: ReturnType<typeof evaluatePolicy>,
  config: AnvilConfig,
  options: { forceLlmReview?: boolean } = {}
) {
  const policy = config.policy.llmReview;
  if (!policy.enabled) return false;
  if (targetMetadata.private && !policy.includePrivatePackages) return false;
  if (options.forceLlmReview) return true;
  if (policy.runOnUnknownPackages && !previousMetadata) return true;
  if (policy.runOnQuarantine && (preliminaryDecision.action === "quarantine" || preliminaryDecision.action === "block")) return true;
  return report.signals.some((signal) => signal.severity === "high" || signal.severity === "critical");
}

export function parsePackageTarget(target: string): { packageName: string; version: string } {
  const atIndex = target.startsWith("@") ? target.lastIndexOf("@") : target.indexOf("@");
  if (atIndex <= 0) return { packageName: target, version: "latest" };
  return { packageName: target.slice(0, atIndex), version: target.slice(atIndex + 1) };
}

function mergePolicyContextSignals(
  report: AnalysisReport,
  context: {
    weeklyDownloads?: number;
    packageAgeDays?: number;
    similarPackages: Array<{ name: string; similarity: number; weeklyDownloads?: number; reasons: string[]; suggestedPackage?: string }>;
    targetMetadata: PackageVersionMetadata;
    previousMetadata?: PackageVersionMetadata;
    policy: AnvilConfig["policy"];
  }
): AnalysisReport {
  const signals: PolicyReason[] = [...report.signals];

  if (typeof context.packageAgeDays === "number" && context.packageAgeDays < context.policy.minimumPackageAgeDays) {
    signals.push({
      code: "PACKAGE_TOO_NEW",
      message:
        context.packageAgeDays < 1
          ? "Package version was published less than 1 day ago."
          : `Package version is newer than the ${context.policy.minimumPackageAgeDays} day policy window.`,
      severity: context.packageAgeDays < 1 ? "critical" : "high",
      evidence: { packageAgeDays: context.packageAgeDays }
    });
  }

  if (typeof context.weeklyDownloads === "number" && context.weeklyDownloads < context.policy.lowDownloadThreshold) {
    signals.push({
      code: "LOW_WEEKLY_DOWNLOADS",
      message: "Package has fewer weekly downloads than the configured threshold.",
      severity: context.weeklyDownloads < context.policy.strictLowDownloadThreshold ? "high" : "medium",
      evidence: { weeklyDownloads: context.weeklyDownloads, threshold: context.policy.lowDownloadThreshold }
    });
  }

  const bestSimilarPackage = context.similarPackages[0];
  if (bestSimilarPackage && bestSimilarPackage.similarity >= 0.82) {
    const lowAdoption = typeof context.weeklyDownloads === "number" && context.weeklyDownloads < context.policy.lowDownloadThreshold;
    signals.push({
      code: "SIMILAR_TO_POPULAR_PACKAGE",
      message: `Package name is similar to ${bestSimilarPackage.name}.`,
      severity: lowAdoption && context.policy.blockSimilarLowDownloadPackages ? "critical" : "medium",
      evidence: {
        candidate: bestSimilarPackage.name,
        suggestedPackage: bestSimilarPackage.suggestedPackage,
        similarity: bestSimilarPackage.similarity,
        weeklyDownloads: bestSimilarPackage.weeklyDownloads,
        reasons: bestSimilarPackage.reasons
      }
    });
  }

  if (
    typeof context.weeklyDownloads === "number" &&
    context.weeklyDownloads < context.policy.lowDownloadThreshold &&
    typeof context.packageAgeDays === "number" &&
    context.packageAgeDays < context.policy.minimumPackageAgeDays
  ) {
    signals.push({
      code: "NEW_PACKAGE_LOW_DOWNLOADS",
      message: "Package is both new and low-adoption.",
      severity: "high",
      evidence: { weeklyDownloads: context.weeklyDownloads, packageAgeDays: context.packageAgeDays }
    });
  }

  if (context.policy.provenance.enabled) {
    signals.push(...detectProvenanceSignals(context));
    if (report.provenance?.verification?.status === "subject_mismatch") {
      signals.push({
        code: "PROVENANCE_SUBJECT_MISMATCH",
        message: "Provenance attestation subject does not match the analysed package identity.",
        severity: "high",
        evidence: report.provenance.verification.evidence
      });
    }
  }

  return {
    ...report,
    signals,
    score: scoreSignals(signals)
  };
}

function detectProvenanceSignals(context: {
  weeklyDownloads?: number;
  targetMetadata: PackageVersionMetadata;
  previousMetadata?: PackageVersionMetadata;
  policy: AnvilConfig["policy"];
}): PolicyReason[] {
  const targetProvenance = context.targetMetadata.provenance;
  const previousProvenance = context.previousMetadata?.provenance;
  const previousHadProvenance = previousProvenance?.present === true;
  const targetHasProvenance = targetProvenance?.present === true;

  if (previousHadProvenance && !targetHasProvenance) {
    return [
      {
        code: "PROVENANCE_MISSING",
        message: "Package provenance was present on the previous version but is missing on this version.",
        severity: "high",
        evidence: { previous: summarizeProvenance(previousProvenance), target: summarizeProvenance(targetProvenance) }
      }
    ];
  }

  if (previousHadProvenance && targetHasProvenance && provenanceChanged(previousProvenance, targetProvenance)) {
    return [
      {
        code: "PROVENANCE_CHANGED",
        message: "Package provenance metadata changed compared with the previous version.",
        severity: "medium",
        evidence: { previous: summarizeProvenance(previousProvenance), target: summarizeProvenance(targetProvenance) }
      }
    ];
  }

  if (
    !targetHasProvenance &&
    typeof context.weeklyDownloads === "number" &&
    context.weeklyDownloads >= context.policy.provenance.highDownloadThreshold
  ) {
    return [
      {
        code: "PROVENANCE_MISSING",
        message: "High-download package has no published provenance metadata.",
        severity: "medium",
        evidence: {
          weeklyDownloads: context.weeklyDownloads,
          threshold: context.policy.provenance.highDownloadThreshold,
          provenancePresent: false
        }
      }
    ];
  }

  return [];
}

function provenanceChanged(
  previous: NonNullable<PackageVersionMetadata["provenance"]>,
  target: NonNullable<PackageVersionMetadata["provenance"]>
) {
  return previous.source !== target.source || previous.attestationUrl !== target.attestationUrl;
}

function summarizeReportProvenance(
  targetMetadata: PackageVersionMetadata,
  previousMetadata: PackageVersionMetadata | undefined,
  verification: NonNullable<AnalysisReport["provenance"]>["verification"]
): AnalysisReport["provenance"] {
  const target = targetMetadata.provenance;
  const previous = previousMetadata?.provenance;

  if (previous?.present === true && target?.present !== true) {
    return { status: "removed", previous, target, verification };
  }

  if (previous?.present === true && target?.present === true && provenanceChanged(previous, target)) {
    return { status: "changed", previous, target, verification };
  }

  if (target?.present === true) {
    return { status: "present", previous, target, verification };
  }

  return { status: "missing", previous, target, verification };
}

function summarizeProvenance(provenance: PackageVersionMetadata["provenance"]) {
  if (!provenance) return { present: false };
  return {
    present: provenance.present,
    source: provenance.source,
    attestationUrl: provenance.attestationUrl
  };
}

function scoreSignals(signals: PolicyReason[]) {
  return signals.reduce(
    (total, signal) =>
      total + (signal.severity === "critical" ? 95 : signal.severity === "high" ? 70 : signal.severity === "medium" ? 35 : signal.severity === "low" ? 10 : 0),
    0
  );
}

function suspiciousSnippetsFromReport(report: AnalysisReport): LlmRiskReviewInput["suspiciousSnippets"] {
  return report.fileFindings?.slice(0, 20).map((finding) => ({
    file: finding.path,
    reason: finding.reason,
    snippet: typeof finding.evidence?.snippet === "string" ? finding.evidence.snippet : JSON.stringify(finding.evidence ?? {})
  }));
}
