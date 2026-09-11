/* Spike-local Env type. Regenerate with `pnpm wrangler types` after config changes. */
declare namespace Cloudflare {
  interface Env {
    ACCOUNT: DurableObjectNamespace;
    ARTIFACTS: R2Bucket;
  }
}

interface Env extends Cloudflare.Env {}

declare module 'cloudflare:workers' {
  interface ProvidedEnv extends Env {}
}
