import { getSignUpUrl } from "@/lib/workos-sdk";
import { workosConfigured } from "@/lib/workos-env";
import { NextResponse } from "next/server";

export async function GET() {
  if (!workosConfigured()) {
    return NextResponse.json({ error: "auth not configured" }, { status: 404 });
  }

  const response = NextResponse.redirect(await getSignUpUrl({ returnTo: "/account" }));
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
