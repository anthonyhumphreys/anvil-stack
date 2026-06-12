import { NextResponse, type NextRequest } from "next/server";
import { parseLimit, requireApiAdmin } from "@/lib/admin-api";
import { getPersistence } from "@/lib/admin-data";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;

  const params = request.nextUrl.searchParams;
  const auditEvents = await getPersistence().listAuditEvents({
    targetId: params.get("targetId") ?? undefined,
    limit: parseLimit(params.get("limit"))
  });
  return NextResponse.json({ auditEvents });
}
