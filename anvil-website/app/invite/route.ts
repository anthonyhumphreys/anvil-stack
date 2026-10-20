import { NextResponse, type NextRequest } from "next/server";

import { getSignInUrl, getSignUpUrl, withAuth } from "@/lib/workos-sdk";
import { workosConfigured } from "@/lib/workos-env";

const INVITATION_COOKIE = "anvil-org-invitation";
const INVITATION_PATH = "/account/organizations/accept";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;

function clearInvitationCookie(response: NextResponse, request: NextRequest) {
  response.cookies.set(INVITATION_COOKIE, "", {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: INVITATION_PATH,
    maxAge: 0
  });
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}

/**
 * WorkOS sends invitees here with `invitation_token`. Keep the token in a
 * short-lived, HttpOnly cookie while AuthKit completes sign-in, then let the
 * protected acceptance route exchange it with the hosted service.
 */
export async function GET(request: NextRequest) {
  if (!workosConfigured()) {
    return clearInvitationCookie(NextResponse.json({ error: "auth not configured" }, { status: 404 }), request);
  }

  const token = request.nextUrl.searchParams.get("invitation_token");
  if (token === null || !TOKEN_PATTERN.test(token)) {
    return clearInvitationCookie(
      NextResponse.redirect(new URL("/account/organizations?invite=invalid", request.url)),
      request
    );
  }

  const { user } = await withAuth();
  const authUrl = user
    ? await getSignInUrl({ returnTo: INVITATION_PATH })
    : await getSignUpUrl({ returnTo: INVITATION_PATH });
  const authorizationUrl = new URL(authUrl);

  // AuthKit Next 4.3.1 creates the PKCE state and verifier cookie but does
  // not yet expose WorkOS's invitationToken authorization parameter.
  // Preserve the SDK-generated flow and add the documented WorkOS parameter.
  authorizationUrl.searchParams.set("invitation_token", token);

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set(INVITATION_COOKIE, token, {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: INVITATION_PATH,
    maxAge: 10 * 60
  });
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}
