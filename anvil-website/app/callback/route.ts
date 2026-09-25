import { handleAuth } from "@/lib/workos-sdk";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { workosConfigured } from "@/lib/workos-env";

// AuthKit redirect target. When WorkOS env is absent there is nothing to
// exchange, so the route answers 404 rather than failing inside the SDK.
const handler: (request: NextRequest) => Promise<Response> = workosConfigured()
  ? handleAuth()
  : async () => NextResponse.json({ error: "auth not configured" }, { status: 404 });

export const GET = handler;
