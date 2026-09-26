import { NextResponse, type NextRequest } from "next/server";

import { hostedIdentity } from "@/lib/auth";
import { acceptOrganizationInvitation, hostedConfigured, HostedApiError } from "@/lib/hosted";
import { workosConfigured } from "@/lib/workos-env";

const INVITATION_COOKIE = "anvil-org-invitation";
const INVITATION_PATH = "/account/organizations/accept";

function redirectTo(
  request: NextRequest,
  result: "accepted" | "invalid" | "unavailable" | "waitlist" | "none"
) {
  const url = new URL(result === "none" ? "/account" : "/account/organizations", request.url);
  if (result !== "none") url.searchParams.set("invite", result);
  const response = NextResponse.redirect(url);
  response.cookies.set(INVITATION_COOKIE, "", {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: INVITATION_PATH,
    maxAge: 0
  });
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

/** Completes the Anvil seat reservation after WorkOS has accepted the invite. */
export async function GET(request: NextRequest) {
  if (!workosConfigured()) return redirectTo(request, "unavailable");

  let identity: Awaited<ReturnType<typeof hostedIdentity>>;
  try {
    identity = await hostedIdentity();
  } catch {
    return redirectTo(request, "unavailable");
  }
  if (!identity) return redirectTo(request, "invalid");

  const invitationToken = request.cookies.get(INVITATION_COOKIE)?.value;
  if (!invitationToken) return redirectTo(request, "none");
  if (!hostedConfigured()) return redirectTo(request, "unavailable");

  try {
    const result = await acceptOrganizationInvitation(identity, invitationToken);
    if (result.accepted) return redirectTo(request, "accepted");
    if (result.reason === "not-anvil-organization-invitation") {
      // WorkOS waitlist approvals are application-wide invitations. They admit
      // the user but do not correspond to an Anvil team seat reservation.
      return redirectTo(request, "none");
    }
    return redirectTo(request, "invalid");
  } catch (error) {
    if (error instanceof HostedApiError) {
      const reason = error.details?.["reason"];
      if (reason === "waitlist-approval-required" || reason === "account-not-admitted") {
        return redirectTo(request, "waitlist");
      }
      if (
        reason === "invalid-invitation" ||
        reason === "invitation-expired-or-revoked" ||
        reason === "invitation-user-mismatch"
      ) {
        return redirectTo(request, "invalid");
      }
    }
    return redirectTo(request, "unavailable");
  }
}
