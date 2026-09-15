// Shared WorkOS env check. Deliberately free of `server-only` so the
// middleware bundle (which is not a React Server Components context) can
// import it too.

/**
 * True when every variable AuthKit needs is present. When false the site
 * must behave as if auth does not exist: the middleware becomes a no-op and
 * the account area renders its not-configured panel instead of crashing.
 */
export function workosConfigured(): boolean {
  return Boolean(
    process.env.WORKOS_API_KEY &&
      process.env.WORKOS_CLIENT_ID &&
      process.env.WORKOS_COOKIE_PASSWORD &&
      process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI
  );
}
