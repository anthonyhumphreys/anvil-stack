import { NextResponse, type NextRequest } from "next/server";
import { createOverrideFromJson, parseLimit, requireApiAdmin } from "@/lib/admin-api";
import { getPersistence } from "@/lib/admin-data";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;

  const params = request.nextUrl.searchParams;
  const overrides = await getPersistence().listOverrides({
    packageName: params.get("packageName") ?? undefined,
    version: params.get("version") ?? undefined,
    limit: parseLimit(params.get("limit"))
  });
  return NextResponse.json({ overrides });
}

export async function POST(request: NextRequest) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;
  return createOverrideFromJson(await request.json());
}
