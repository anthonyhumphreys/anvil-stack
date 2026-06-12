import { NextResponse, type NextRequest } from "next/server";
import { getPolicyResponse, requireApiAdmin } from "@/lib/admin-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;
  return NextResponse.json(await getPolicyResponse());
}
