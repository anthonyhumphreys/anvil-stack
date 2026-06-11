import { NextResponse, type NextRequest } from "next/server";
import { parseLimit, requireApiAdmin } from "@/lib/admin-api";
import { getPersistence } from "@/lib/admin-data";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;

  const params = request.nextUrl.searchParams;
  const reports = await getPersistence().listAnalysisReports({
    packageName: params.get("packageName") ?? undefined,
    version: params.get("version") ?? undefined,
    limit: parseLimit(params.get("limit"))
  });
  return NextResponse.json({ reports });
}
