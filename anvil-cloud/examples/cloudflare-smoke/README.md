# Cloudflare preview smoke Cell

This deliberately stateless Cell verifies the Anvil Runtime request bridge and
static asset delivery on Cloudflare Workers. Stateful capabilities remain
blocked until their provider hosts pass conformance.

From the `anvil-cloud` workspace, the safe default builds the Cell, generates
the Worker artifact, and asks Wrangler to compile it without uploading:

```bash
pnpm verify:cloudflare-preview
```

Live execution is intentionally explicit. For a permanent account, provide a
scoped token and account ID. The verifier deploys, checks health/query/endpoint/
asset routes, then deletes the Worker through the Cloudflare API:

```bash
ANVIL_CLOUDFLARE_LIVE=1 \
ANVIL_CLOUDFLARE_MODE=permanent \
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<scoped-token> \
pnpm verify:cloudflare-preview
```

For the unauthenticated Temporary Account path, remove all Cloudflare auth from
the shell, use a Wrangler profile/operating-system user with no OAuth login, and
run:

```bash
ANVIL_CLOUDFLARE_LIVE=1 \
ANVIL_CLOUDFLARE_MODE=temporary \
pnpm verify:cloudflare-preview
```

The verifier strips inherited `CF_*`, `CLOUDFLARE_*`, and `WRANGLER_*`
variables in temporary mode. Wrangler's bearer claim URL is never written to
captured stdout, JSON, or a persistent file; temporary live verification
requires an interactive terminal and writes the one-time link directly to that
terminal. Unclaimed Temporary Account resources expire under Cloudflare's
lifecycle. Set `ANVIL_CLOUDFLARE_KEEP_WORKER=1` only when you deliberately want
to retain a permanent-account smoke Worker.
