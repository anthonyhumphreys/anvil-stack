# `@anvil-cloud/cloudflare`

Cloudflare deployment planning for Anvil Cells.

The alpha package is intentionally plan-only. It maps provider-neutral Cell
capabilities to Workers, Workers Assets, D1, R2, Queues, bindings, and
observability metadata, while blocking deploy/remove until the Worker runtime
bridge and provider lifecycle smoke tests land.

Temporary Account planning is available through the CLI:

```sh
anvil-cloud plan --stage preview --adapter cloudflare --temporary --json
anvil-cloud review --adapter cloudflare --temporary --env preview --json
```

Temporary mode records provider requirements and compatibility diagnostics. It
does not create an account or expose temporary API tokens or claim URLs.
