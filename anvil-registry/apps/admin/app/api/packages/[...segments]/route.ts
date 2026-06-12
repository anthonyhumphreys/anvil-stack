import { NextResponse, type NextRequest } from "next/server";
import { compareAnalysisReports, hasPackageReviewEvidence, jsonError, requestLlmReview, requireApiAdmin, selectAnalysisComparisonReports, splitPackageSegments } from "@/lib/admin-api";
import { getPackageReview, getPersistence } from "@/lib/admin-data";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ segments: string[] }> }) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;

  const { segments } = await params;
  const suffix = segments.map((segment) => decodeURIComponent(segment));
  if (suffix.at(-1) === "review") {
    const target = splitPackageSegments(segments, 1);
    if (!target) return jsonError("ANVIL_PACKAGE_REVIEW_TARGET_INVALID", 400);
    const review = await getPackageReview(target.packageName, target.version);
    if (!hasPackageReviewEvidence(review)) return jsonError("ANVIL_PACKAGE_REVIEW_NOT_FOUND", 404);
    return NextResponse.json({ review });
  }

  if (suffix.at(-1) === "decisions") {
    const target = splitPackageSegments(segments, 1);
    if (!target) return jsonError("ANVIL_PACKAGE_DECISIONS_TARGET_INVALID", 400);
    const decisions = await getPersistence().listPolicyDecisions({ packageName: target.packageName, version: target.version, limit: 200 });
    if (decisions.length === 0) return jsonError("ANVIL_PACKAGE_DECISIONS_NOT_FOUND", 404);
    return NextResponse.json({ packageName: target.packageName, version: target.version, decisions });
  }

  if (suffix.at(-2) === "reports" && suffix.at(-1) === "compare") {
    const target = splitPackageSegments(segments, 2);
    if (!target) return jsonError("ANVIL_REPORT_COMPARISON_TARGET_INVALID", 400);
    const reports = await getPersistence().listAnalysisReports({ packageName: target.packageName, version: target.version, limit: 200 });
    const pair = selectAnalysisComparisonReports(reports, request.nextUrl.searchParams);
    if (!pair) return jsonError("ANVIL_REPORT_COMPARISON_NOT_FOUND", 404);
    return NextResponse.json({
      packageName: target.packageName,
      version: target.version,
      left: pair.left,
      right: pair.right,
      comparison: compareAnalysisReports(pair.left.report, pair.right.report)
    });
  }

  return jsonError("ANVIL_PACKAGE_API_ROUTE_NOT_FOUND", 404);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ segments: string[] }> }) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;

  const { segments } = await params;
  if (decodeURIComponent(segments.at(-1) ?? "") !== "llm-review") return jsonError("ANVIL_PACKAGE_API_ROUTE_NOT_FOUND", 404);
  const target = splitPackageSegments(segments, 1);
  if (!target) return jsonError("ANVIL_LLM_REVIEW_TARGET_INVALID", 400);
  return requestLlmReview(target.packageName, target.version, await request.json());
}
