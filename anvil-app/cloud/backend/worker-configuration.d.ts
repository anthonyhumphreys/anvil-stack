/* Spike-local Env type. Regenerate with `pnpm wrangler types` after config changes. */
declare namespace Cloudflare {
  interface Env {
    ACCOUNT: DurableObjectNamespace;
    SESSIONS: DurableObjectNamespace;
    ARTIFACTS: R2Bucket;
    /** Stable identity emitted by the Mesh deployment recipe. */
    ANVIL_DEPLOYMENT_ID?: string;
    /** Human-readable name emitted by the Mesh deployment recipe. */
    ANVIL_DEPLOYMENT_NAME?: string;
    /** Dev-only: accept `spike:` bearers. Must be unset in real deploys. */
    ANVIL_DEV_SPIKE?: string;
    /** OIDC authority for the `oidc-pkce` and optional `workos-device` proofs. */
    OIDC_ISSUER?: string;
    OIDC_CLIENT_ID?: string;
    OIDC_SCOPES?: string;
    /** WorkOS application client id used by the hosted website identity store.
     * Set this to the website's WORKOS_CLIENT_ID when the desktop application
     * uses a separate public WorkOS application client id. */
    HOSTED_WORKOS_CLIENT_ID?: string;
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
    /**
     * BILL-02 hosted billing provider config. All optional; absence fails
     * closed — checkout/portal/reconcile answer unavailable and the
     * webhook route answers not-found, never a guessed billing state.
     */
    STRIPE_SECRET_KEY?: string;
    /** Endpoint secret for `Stripe-Signature` on /v1/hosted/stripe-webhook. */
    STRIPE_WEBHOOK_SECRET?: string;
    /** Test-only API base override; defaults to https://api.stripe.com. */
    STRIPE_API_BASE?: string;
    STRIPE_PRICE_SYNC_MONTHLY?: string;
    STRIPE_PRICE_SYNC_ANNUAL?: string;
    /** 'true' publishes checkout creation; anything else refuses with 403. */
    HOSTED_CHECKOUT_ENABLED?: string;
    HOSTED_CHECKOUT_SUCCESS_URL?: string;
    HOSTED_CHECKOUT_CANCEL_URL?: string;
    HOSTED_PORTAL_RETURN_URL?: string;
    /** JSON partial override of DEFAULT_HOSTED_LIMITS. */
    HOSTED_SYNC_LIMITS?: string;
    /**
     * BILL-03 enforcement switch. 'true' denies mutating operations for
     * restricted/unknown hosted entitlements inside AccountCoordinator;
     * anything else leaves every operation allowed while HOSTED_DB still
     * surfaces entitlement state on session.describe.
     */
    HOSTED_BILLING_ENFORCEMENT?: string;
    /**
     * ENV-09: service binding to the `anvil-mesh-provisioner` worker that
     * turns `anvil-managed` provision-environment jobs into Cloudflare
     * Sandbox environments. Absence rejects managed provisions with
     * `provider-unavailable` — self-host deploys never bind it.
     */
    MANAGED_PROVISIONER?: Fetcher;
    /**
     * Shared bearer for the MANAGED_PROVISIONER channel (`wrangler secret
     * put`). Absent = the provisioner accepts unauthenticated requests —
     * only safe inside a private network/service-binding setup.
     */
    MANAGED_PROVISIONER_TOKEN?: string;
    /**
     * Public base URL of this backend (https://…) — embedded in the
     * managed bootstrap so the environment's worker knows where to dial.
     */
    ANVIL_PUBLIC_API_URL?: string;
  }
}

interface Env extends Cloudflare.Env {}

declare module 'cloudflare:workers' {
  interface ProvidedEnv extends Env {}
}
