// Shared WorkOS env check. Deliberately free of `server-only` so the
// middleware bundle (which is not a React Server Components context) can
// import it too.

import {
  configureWorkosEnvironment,
  deploymentVariable,
  validateDeploymentEnvironment
} from "@/lib/deployment-env.js";

// AuthKit captures these values on import. Keep this setup before every SDK
// import through `lib/workos-sdk.ts`.
validateDeploymentEnvironment();
configureWorkosEnvironment();

/**
 * True when every variable AuthKit needs is present. When false the site
 * must behave as if auth does not exist: the middleware becomes a no-op and
 * the account area renders its not-configured panel instead of crashing.
 */
export function workosConfigured(): boolean {
  return Boolean(
    deploymentVariable("WORKOS_API_KEY", "WORKOS_API_KEY") &&
      deploymentVariable("WORKOS_CLIENT_ID", "WORKOS_CLIENT_ID") &&
      deploymentVariable("WORKOS_COOKIE_PASSWORD", "WORKOS_COOKIE_PASSWORD") &&
      deploymentVariable("WORKOS_REDIRECT_URI", "NEXT_PUBLIC_WORKOS_REDIRECT_URI")
  );
}
