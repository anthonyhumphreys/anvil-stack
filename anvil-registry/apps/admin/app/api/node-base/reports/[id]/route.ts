import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireApiAdmin } from "@/lib/admin-api";
import { getPersistence } from "@/lib/admin-data";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;

  const { id } = await params;
  const report = await getPersistence().getNodeBaseReport(decodeURIComponent(id));
  if (!report) return jsonError("ANVIL_NODE_BASE_REPORT_NOT_FOUND", 404);
  return NextResponse.json({ report });
}
