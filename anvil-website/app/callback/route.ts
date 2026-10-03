import { handleAuth } from "@/lib/workos-sdk";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { workosConfigured } from "@/lib/workos-env";
import { workosCallbackBaseUrl } from "@/lib/deployment-env.js";

// AuthKit redirect target. When WorkOS env is absent there is nothing to
// exchange, so the route answers 404 rather than failing inside the SDK.
const handler: (request: NextRequest) => Promise<Response> = workosConfigured()
  // Vercel can expose an internal localhost URL to the route. Return users
  // to the public origin registered with WorkOS instead of that internal host.
  ? handleAuth({ baseURL: workosCallbackBaseUrl() })
  : async () => NextResponse.json({ error: "auth not configured" }, { status: 404 });

export const GET = handler;
