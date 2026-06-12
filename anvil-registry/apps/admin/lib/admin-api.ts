import { NextResponse, type NextRequest } from "next/server";
import {
  defaultPopularPackageIndexObjectKey,
  encodePopularPackageIndex,
  parsePopularPackageIndex,
  popularPackageIndexDatedObjectKey
} from "@anvilstack/name-squatting";
import type { AnalysisReportRecord, NodeBaseReportRisk } from "@anvilstack/persistence";
import { llmReviewRequestBodySchema, overrideCreateRequestSchema, overrideRevokeRequestSchema, resolveOverrideExpiry, type Override } from "@anvilstack/shared";
import { config, getObjectStore, getPackageReview, getPersistence, recordEffectivePolicyConfig } from "@/lib/admin-data";
import { isAdminTokenValue } from "@/lib/auth";

export function jsonError(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...extra }, { status });
}

export function requireApiAdmin(request: NextRequest) {
  if (!config.ADMIN_TOKEN) return undefined;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const cookie = request.cookies.get("anvil_admin_token")?.value;
  if (isAdminTokenValue(bearer) || isAdminTokenValue(cookie)) return undefined;
  return jsonError("ANVIL_ADMIN_TOKEN_REQUIRED", 401);
}

export function parseLimit(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, 200);
}

export function parseNodeBaseRisk(value: string | null): NodeBaseReportRisk | undefined {
  return value === "high" || value === "medium" || value === "risky" ? value : undefined;
}

export function analysisReportIdentity(searchParams: URLSearchParams, prefix = "") {
  const key = (name: string) => (prefix ? `${prefix}${name.slice(0, 1).toUpperCase()}${name.slice(1)}` : name);
  return {
    tarballIntegrity: searchParams.get(key("integrity")) ?? undefined,
    tarballShasum: searchParams.get(key("shasum")) ?? undefined,
    analyserVersion: searchParams.get(key("analyser")) ?? undefined
  };
}

export function splitPackageSegments(segments: string[], suffixLength = 0) {
  const decoded = segments.map((segment) => decodeURIComponent(segment));
  const effective = suffixLength > 0 ? decoded.slice(0, -suffixLength) : decoded;
  const version = effective.at(-1);
  const packageName = effective.slice(0, -1).join("/");
  return packageName && version ? { packageName, version } : undefined;
}

export function hasPackageReviewEvidence(review: Awaited<ReturnType<typeof getPackageReview>>) {
  return Boolean(review.packageVersion) || review.decisions.length > 0 || review.reports.length > 0 || review.llmRiskReviews.length > 0 || review.overrides.length > 0 || review.auditEvents.length > 0;
}

export async function createOverrideFromJson(body: unknown) {
  const parsed = overrideCreateRequestSchema.safeParse(body);
  if (!parsed.success) return jsonError("ANVIL_OVERRIDE_INVALID", 400, { issues: parsed.error.issues });

  const expiresAt = resolveOverrideExpiry(parsed.data.expiresAt, config.policy.overrides.defaultExpiryDays);
  if (expiresAt === null) return jsonError("ANVIL_OVERRIDE_EXPIRES_AT_INVALID", 400);

  const persistence = getPersistence();
  const override = { ...parsed.data, approvedBy: parsed.data.approvedBy ?? "admin-ui", expiresAt };
  await persistence.putOverride(override);
  await invalidateOverrideDecision(override);
  await persistence.putAuditEvent({
    actor: override.approvedBy,
    eventType: "override.created",
    targetType: "package",
    targetId: `${override.packageName}${override.version ? `@${override.version}` : ""}`,
    metadata: { source: "admin", action: override.action, reason: override.reason, expiresAt: override.expiresAt }
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function revokeOverrideFromJson(body: unknown) {
  const parsed = overrideRevokeRequestSchema.safeParse(body);
  if (!parsed.success) return jsonError("ANVIL_OVERRIDE_REVOKE_INVALID", 400, { issues: parsed.error.issues });

  const persistence = getPersistence();
  const revoked = await persistence.revokeOverride(parsed.data.packageName, parsed.data.version, parsed.data.revokedBy ?? "admin-ui");
  if (!revoked) return jsonError("ANVIL_OVERRIDE_NOT_FOUND", 404);

  await invalidateOverrideDecision(revoked.override);
  await persistence.putAuditEvent({
    actor: parsed.data.revokedBy ?? "admin-ui",
    eventType: "override.revoked",
    targetType: "package",
    targetId: `${revoked.override.packageName}${revoked.override.version ? `@${revoked.override.version}` : ""}`,
    metadata: { source: "admin", action: revoked.override.action, reason: revoked.override.reason }
  });

  return NextResponse.json({ ok: true });
}

export async function uploadPopularPackageIndex(body: Record<string, unknown>) {
  try {
    const generatedAt = typeof body.generatedAt === "string" ? body.generatedAt : new Date().toISOString();
    const index = { ...parsePopularPackageIndex({ ...body, generatedAt }, "upload"), generatedAt };
    const activeKey = config.POPULAR_PACKAGE_INDEX_OBJECT_KEY || defaultPopularPackageIndexObjectKey;
    const datedKey = popularPackageIndexDatedObjectKey(generatedAt);
    const encoded = encodePopularPackageIndex(index);
    const objectStore = getObjectStore();
    await objectStore.put(datedKey, encoded);
    if (activeKey !== datedKey) await objectStore.put(activeKey, encoded);

    const storedIndex = { ...index, source: `object:${activeKey}` };
    await getPersistence().putAuditEvent({
      actor: typeof body.uploadedBy === "string" ? body.uploadedBy : "admin-ui",
      eventType: "popular_index.updated",
      targetType: "popular_index",
      targetId: activeKey,
      metadata: { activeKey, datedKey, packageCount: index.popularPackages.length, knownConfusionCount: Object.keys(index.knownConfusions).length }
    });

    return NextResponse.json({ ok: true, activeKey, datedKey, index: storedIndex }, { status: 201 });
  } catch (error) {
    return jsonError("ANVIL_POPULAR_INDEX_INVALID", 400, { message: error instanceof Error ? error.message : String(error) });
  }
}

export async function requestLlmReview(packageName: string, version: string, body: unknown) {
  if (!config.policy.llmReview.enabled) return jsonError("ANVIL_LLM_REVIEW_DISABLED", 409);
  const parsed = llmReviewRequestBodySchema.safeParse(body ?? {});
  if (!parsed.success) return jsonError("ANVIL_LLM_REVIEW_REQUEST_INVALID", 400, { issues: parsed.error.issues });

  const response = await fetch(`${config.ANVIL_API_BASE_URL.replace(/\/+$/, "")}/-/anvil/llm-review`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.ADMIN_TOKEN ? { authorization: `Bearer ${config.ADMIN_TOKEN}` } : {})
    },
    body: JSON.stringify({
      packageName,
      version,
      requestedBy: parsed.data.requestedBy ?? "admin-ui",
      priority: parsed.data.priority ?? "high"
    })
  });
  const bodyText = await response.text();
  const parsedBody = parseJson(bodyText);
  if (!response.ok) return NextResponse.json(parsedBody ?? { error: "ANVIL_LLM_REVIEW_REQUEST_FAILED", detail: bodyText || response.statusText }, { status: response.status });
  return NextResponse.json(parsedBody ?? { ok: true }, { status: 202 });
}

export async function getPolicyResponse() {
  return {
    runtimeMode: config.RUNTIME_MODE,
    policy: config.policy,
    policyConfig: await recordEffectivePolicyConfig(getPersistence(), config)
  };
}

export function selectAnalysisComparisonReports(reports: AnalysisReportRecord[], searchParams: URLSearchParams) {
  if (reports.length < 2) return undefined;
  const leftIdentity = analysisReportIdentity(searchParams, "left");
  const rightIdentity = analysisReportIdentity(searchParams, "right");
  const left = hasIdentityFilter(leftIdentity) ? reports.find((record) => analysisReportRecordMatches(record, leftIdentity)) : reports[1];
  const right = hasIdentityFilter(rightIdentity) ? reports.find((record) => analysisReportRecordMatches(record, rightIdentity)) : reports[0];
  if (!left || !right) return undefined;
  return { left, right };
}

export function compareAnalysisReports(left: AnalysisReportRecord["report"], right: AnalysisReportRecord["report"]) {
  return {
    scoreDelta: right.score - left.score,
    signals: compareItems(left.signals, right.signals, (signal) => `${signal.code}|${signal.message}|${signal.severity}`),
    fileFindings: compareItems(left.fileFindings ?? [], right.fileFindings ?? [], (finding) => `${finding.path}|${finding.code}|${finding.reason}|${finding.severity}|${JSON.stringify(finding.evidence ?? {})}`)
  };
}

export const analysisArtifactKinds = ["report", "manifest-diff", "file-tree"] as const;
export type AnalysisArtifactKind = (typeof analysisArtifactKinds)[number];

export function analysisArtifactKind(searchParams: URLSearchParams): AnalysisArtifactKind | undefined {
  const kind = searchParams.get("kind") ?? "report";
  return analysisArtifactKinds.includes(kind as AnalysisArtifactKind) ? (kind as AnalysisArtifactKind) : undefined;
}

export function analysisReportArtifactObjectKey(report: { objectKey?: string }, kind: AnalysisArtifactKind) {
  if (!report.objectKey) return undefined;
  if (kind === "report") return report.objectKey;
  const match = /^(.*\/)report\.json$/.exec(report.objectKey);
  return match ? `${match[1]}${kind}.json` : undefined;
}

function hasIdentityFilter(identity: { tarballIntegrity?: string; tarballShasum?: string; analyserVersion?: string }) {
  return Boolean(identity.tarballIntegrity || identity.tarballShasum || identity.analyserVersion);
}

function analysisReportRecordMatches(record: AnalysisReportRecord, identity: { tarballIntegrity?: string; tarballShasum?: string; analyserVersion?: string }) {
  return (
    (identity.tarballIntegrity === undefined || record.tarballIntegrity === identity.tarballIntegrity || record.report.tarballIntegrity === identity.tarballIntegrity) &&
    (identity.tarballShasum === undefined || record.tarballShasum === identity.tarballShasum || record.report.tarballShasum === identity.tarballShasum) &&
    (identity.analyserVersion === undefined || record.analyserVersion === identity.analyserVersion || record.report.analyserVersion === identity.analyserVersion)
  );
}

function compareItems<T>(left: T[], right: T[], keyFor: (item: T) => string) {
  const leftByKey = new Map(left.map((item) => [keyFor(item), item]));
  const rightByKey = new Map(right.map((item) => [keyFor(item), item]));
  return {
    added: right.filter((item) => !leftByKey.has(keyFor(item))),
    removed: left.filter((item) => !rightByKey.has(keyFor(item))),
    unchanged: right.filter((item) => leftByKey.has(keyFor(item)))
  };
}

async function invalidateOverrideDecision(override: Override) {
  if (override.version) await getPersistence().deletePolicyDecision(override.packageName, override.version, config.policy.version);
  else await getPersistence().deletePolicyDecisionsForPackage(override.packageName, config.policy.version);
}

function parseJson(text: string) {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}
