/* Spike-local Env type. Regenerate with `pnpm wrangler types` after config changes. */
declare namespace Cloudflare {
  interface Env {
    ACCOUNT: DurableObjectNamespace;
    SESSIONS: DurableObjectNamespace;
    ARTIFACTS: R2Bucket;
    /** Dev-only: accept `spike:` bearers. Must be unset in real deploys. */
    ANVIL_DEV_SPIKE?: string;
    /** OIDC authority for the `oidc-pkce` enrollment proof. */
    OIDC_ISSUER?: string;
    OIDC_CLIENT_ID?: string;
    OIDC_SCOPES?: string;
    /** Deployment-admin credential for `POST /v1/enrollment-codes`. */
    ENROLLMENT_ADMIN_TOKEN?: string;
    /**
     * BILL-01 hosted-only D1 billing/identity store. Bound by
     * wrangler.hosted.jsonc; absent on self-host deployments, which then
     * expose no hosted routes at all.
     */
    HOSTED_DB?: D1Database;
    /** JSON `{"keyId":"secret"}` map for /internal/hosted/* HMAC auth. */
    HOSTED_SERVICE_KEYS?: string;
  }
}

interface Env extends Cloudflare.Env {}

declare module 'cloudflare:workers' {
  interface ProvidedEnv extends Env {}
}
