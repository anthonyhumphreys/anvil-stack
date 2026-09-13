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
  }
}

interface Env extends Cloudflare.Env {}

declare module 'cloudflare:workers' {
  interface ProvidedEnv extends Env {}
}
