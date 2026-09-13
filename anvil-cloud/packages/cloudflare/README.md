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

## Mesh backend recipe

The package also carries a bounded deployment recipe for the Anvil Mesh
backend: an existing Cloudflare Worker project consumed in place rather than
re-bundled. `createMeshDeploymentPlan` reads the project's own
`wrangler.jsonc` for Durable Object bindings, migration tags, R2 buckets, and
compatibility date, then renders a generated overlay config
(`wrangler.mesh.jsonc`) that Wrangler builds and deploys.

```sh
anvil-cloud mesh plan --backend <path> --name <worker> --first-deploy \
  --base-url https://mesh.example.com --write --json
anvil-cloud mesh connection --name <worker> --base-url <url> --out <path> --json
```

Apply and remove are gated behind recorded provider lifecycle evidence, the
same convention as the Cell plan-only gate: without an evidence reference,
`mesh apply`/`mesh remove` report `MESH_PROVIDER_EVIDENCE_REQUIRED` and never
invoke Wrangler. `mesh apply --dry-run` compiles locally without evidence.
Development-only backend keys (`ANVIL_DEV_SPIKE`, `ENROLLMENT_ADMIN_TOKEN`)
fail closed in every non-dev plan.

After apply — or directly from `--base-url`/`--subdomain` plan inputs — the
recipe exports a pinnable connection record
`{ baseUrl, descriptorUrl: "<base>/.well-known/anvil-backend" }` for the
desktop. See `docs/architecture/cloudflare-mesh-recipe.md` for the full
lifecycle contract.

From the workspace root, compile the generated Worker through Wrangler without
making provider calls:

```sh
pnpm verify:cloudflare-preview
```

The explicit live commands, cleanup behavior, and claim-URL handling are
documented in `examples/cloudflare-smoke/README.md`.
