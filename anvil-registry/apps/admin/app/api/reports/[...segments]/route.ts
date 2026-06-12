import { NextResponse, type NextRequest } from "next/server";
import { analysisArtifactKind, analysisReportArtifactObjectKey, analysisReportIdentity, jsonError, requireApiAdmin, splitPackageSegments } from "@/lib/admin-api";
import { getObjectStore, getPersistence } from "@/lib/admin-data";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ segments: string[] }> }) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;

  const { segments } = await params;
  const isArtifact = decodeURIComponent(segments.at(-1) ?? "") === "artifact";
  const target = splitPackageSegments(segments, isArtifact ? 1 : 0);
  if (!target) return jsonError("ANVIL_REPORT_TARGET_INVALID", 400);

  const report = await getPersistence().getAnalysisReport(target.packageName, target.version, analysisReportIdentity(request.nextUrl.searchParams));
  if (!report) return jsonError("ANVIL_REPORT_NOT_FOUND", 404);
  if (!isArtifact) return NextResponse.json({ report });

  const kind = analysisArtifactKind(request.nextUrl.searchParams);
  if (!kind) return jsonError("ANVIL_REPORT_ARTIFACT_KIND_INVALID", 400);
  const objectKey = analysisReportArtifactObjectKey(report, kind);
  if (!objectKey) return jsonError("ANVIL_REPORT_ARTIFACT_NOT_STORED", 404);
  const artifact = await getObjectStore().get(objectKey);
  if (!artifact) return jsonError("ANVIL_REPORT_ARTIFACT_NOT_FOUND", 404, { objectKey });
  return new Response(Buffer.from(artifact), { headers: { "content-type": "application/json" } });
}
