import { getSignInUrl } from "@/lib/workos-sdk";
import { workosConfigured } from "@/lib/workos-env";
import { SHARE_RESPONSE_HEADERS, sharePath } from "@/lib/share-access";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const path = sharePath((await params).id);
  if (!path || !workosConfigured()) return new Response("Sign-in unavailable", { status: 404, headers: SHARE_RESPONSE_HEADERS });
  // Ignore all client query/body/returnTo input. The fragment stays in this tab's storage.
  const location = await getSignInUrl({ returnTo: path });
  return new Response(null, { status: 302, headers: { ...SHARE_RESPONSE_HEADERS, location } });
}
