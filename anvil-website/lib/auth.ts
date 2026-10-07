import "server-only";

import { withAuth } from "@/lib/workos-sdk";
import type { HostedIdentity } from "@/lib/hosted/types";
import { workosConfigured } from "@/lib/workos-env";
import { deploymentVariable } from "@/lib/deployment-env.js";

/** The WorkOS user object returned by `withAuth` once signed in. */
export type AuthenticatedUser = NonNullable<
  Awaited<ReturnType<typeof withAuth>>["user"]
>;

/**
 * Returns the signed-in WorkOS user, redirecting to AuthKit when there is
 * no session. Throws when WorkOS env is missing — callers should check
 * `workosConfigured()` first and render the not-configured panel instead.
 */
export async function requireUser(): Promise<AuthenticatedUser> {
  if (!workosConfigured()) {
    throw new Error("WorkOS AuthKit is not configured");
  }
  const { user } = await withAuth({ ensureSignedIn: true });
  return user;
}

/**
 * Signed-in user without the redirect: null when signed out or when WorkOS
 * env is missing. Used for optional surfaces (e.g. the header Account link).
 */
export async function currentUser(): Promise<AuthenticatedUser | null> {
  if (!workosConfigured()) return null;
  const { user } = await withAuth();
  return user;
}

/**
 * The `{workosClientId, workosUserId}` pair the hosted service channel
 * expects, built from the WorkOS session user (`user.id`, the `user_…` id)
 * and `WORKOS_CLIENT_ID`. Null when auth is unconfigured or signed out.
 */
export async function hostedIdentity(): Promise<HostedIdentity | null> {
  const user = await currentUser();
  if (user === null) return null;
  const workosClientId = deploymentVariable("WORKOS_CLIENT_ID", "WORKOS_CLIENT_ID");
  if (!workosClientId) return null;
  return { workosClientId, workosUserId: user.id };
}
