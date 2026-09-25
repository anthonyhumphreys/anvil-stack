import "server-only";

import { requireUser, type AuthenticatedUser } from "@/lib/auth";
import { deploymentVariable } from "@/lib/deployment-env.js";
import { hostedConfigured, HostedApiError } from "@/lib/hosted";
import type { HostedIdentity } from "@/lib/hosted/types";
import { workosConfigured } from "@/lib/workos-env";

/**
 * Everything an /account page needs to decide what to render. The page —
 * not the layout — owns the guard, because layouts cannot prevent their
 * children from rendering.
 */
export type AccountContext =
  | { status: "auth-unconfigured" }
  | { status: "backend-unconfigured"; user: AuthenticatedUser }
  | { status: "ok"; user: AuthenticatedUser; identity: HostedIdentity };

export async function loadAccountContext(): Promise<AccountContext> {
  if (!workosConfigured()) return { status: "auth-unconfigured" };
  // Redirects to AuthKit when there is no session.
  const user = await requireUser();
  if (!hostedConfigured()) return { status: "backend-unconfigured", user };
  return {
    status: "ok",
    user,
    identity: {
      workosClientId: deploymentVariable("WORKOS_CLIENT_ID", "WORKOS_CLIENT_ID") as string,
      workosUserId: user.id
    }
  };
}

export type HostedCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; status: number; details?: Record<string, unknown> };

/**
 * Calls the hosted channel and converts failures into data so pages can
 * render honest fallbacks (e.g. `not-found` for an account that does not
 * exist yet) instead of throwing into an error boundary. Non-API errors
 * still propagate — they are bugs, not states.
 */
export async function tryHosted<T>(call: () => Promise<T>): Promise<HostedCallResult<T>> {
  try {
    return { ok: true, data: await call() };
  } catch (error) {
    if (error instanceof HostedApiError) {
      return { ok: false, code: error.code, status: error.status, details: error.details };
    }
    throw error;
  }
}

/** Human one-liner for a failed hosted call — no internals, no blame. */
export function hostedFailureMessage(code: string, status: number): string {
  switch (code) {
    case "unconfigured":
      return "The hosted sync backend is not configured for this deployment.";
    case "unauthenticated":
      return "The site could not authenticate to the sync backend.";
    case "forbidden":
      return "The sync backend refused this action for this account.";
    case "not-found":
      return "No hosted account exists for this sign-in yet.";
    case "throttled":
      return "Too many attempts — wait a moment and try again.";
    case "conflict":
      return "That change conflicts with the current account state.";
    case "timeout":
    case "unavailable":
      return "The sync backend is unreachable right now — try again shortly.";
    default:
      return `The sync backend answered with an error (${status || "network"}).`;
  }
}

export { formatBytes, formatDate, shortId } from "@/lib/format";
