import { NextResponse } from "next/server";
import { resolveLatestDesktopDmgAssetUrl } from "@/lib/site";

export function GET() {
  const response = NextResponse.redirect(resolveLatestDesktopDmgAssetUrl(), 307);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
