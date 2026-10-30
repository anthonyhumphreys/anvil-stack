import { NextResponse, type NextRequest } from "next/server";
import { parseLimit, parseNodeBaseRisk, requireApiAdmin } from "@/lib/admin-api";
import { getPersistence } from "@/lib/admin-data";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;

  const params = request.nextUrl.searchParams;
  const reports = await getPersistence().listNodeBaseReports({
    reportType: params.get("reportType") ?? undefined,
    risk: parseNodeBaseRisk(params.get("risk")),
    limit: parseLimit(params.get("limit"))
  });
  return NextResponse.json({ reports });
}
