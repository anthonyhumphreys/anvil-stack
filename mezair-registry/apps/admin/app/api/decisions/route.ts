import { NextResponse, type NextRequest } from "next/server";
import { decisionActionFromSlug, getPersistence } from "@/lib/admin-data";
import { parseLimit, requireApiAdmin } from "@/lib/admin-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const rejected = requireApiAdmin(request);
  if (rejected) return rejected;

  const params = request.nextUrl.searchParams;
  const actions = params
    .get("action")
    ?.split(",")
    .flatMap((value) => {
      const action = decisionActionFromSlug(value);
      return action ? [action] : [];
    });
  const decisions = await getPersistence().listPolicyDecisions({ actions: actions?.length ? actions : undefined, limit: parseLimit(params.get("limit")) });
  return NextResponse.json({ decisions });
}
