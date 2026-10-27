import type { NextRequest } from "next/server";
import { requireApiAdmin, revokeOverrideFromJson } from "@/lib/admin-api";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;
  return revokeOverrideFromJson(await request.json());
}
