# `@anvil-cloud/cloudflare`

Cloudflare deployment planning for Anvil Cells.

The alpha package remains intentionally plan-only at the normal CLI boundary.
It maps provider-neutral Cell capabilities to Workers, Workers Assets, D1, R2,
Queues, bindings, and observability metadata while blocking `deploy` and
`remove` until provider lifecycle smoke evidence is recorded.

The package now contains the experimental verification seam behind that gate:

- a Worker `fetch()` bridge for health, query, mutation, and endpoint requests;
- a workerd-safe runtime entrypoint and deterministic Worker artifact;
- generated Wrangler configuration with Workers Assets support;
- a Wrangler 4.102.0+ Temporary Account path that strips inherited provider
  credentials and redacts bearer claim URLs;
- an opt-in live smoke verifier for permanent or temporary accounts.

Database, files, events, jobs, workflows, services, agent sandboxes, provider
auth verification, and secret provisioning still fail closed. Their planned
Cloudflare mappings are not runtime support claims.

Temporary Account planning is available through the CLI:

```sh
anvil-cloud plan --stage preview --adapter cloudflare --temporary --json
anvil-cloud review --adapter cloudflare --temporary --env preview --json
```

Temporary mode records provider requirements and compatibility diagnostics. It
does not create an account or expose temporary API tokens or claim URLs.

From the workspace root, compile the generated Worker through Wrangler without
making provider calls:

```sh
pnpm verify:cloudflare-preview
```

The explicit live commands, cleanup behavior, and claim-URL handling are
documented in `examples/cloudflare-smoke/README.md`.
