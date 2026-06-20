---
title: Builder and Guard
navTitle: Builder and Guard
description: How the Anvil Builder checks, bundles, extracts manifests, and enforces alpha import and capability policy.
product: Anvil Cloud
section: Runtime
order: 130
---

# Builder and Guard

The Anvil Builder turns a Cell project into inspectable output. Anvil Guard is
the trust gateway before local runtime or preview deploy: it checks that Cell
server code stays inside the declared contract instead of quietly reaching for
provider APIs, process globals, or effects the manifest cannot explain.

## Build pipeline

`anvil-cloud check` and `anvil-cloud build` share the same pipeline. `check` runs it without writing artifacts; `build` writes output.

Pipeline:

1. Load `anvil.json`.
2. Resolve server and client entrypoints.
3. Run import and capability policy checks.
4. Run TypeScript typecheck.
5. Bundle the server entrypoint.
6. Import the server bundle and extract the app manifest.
7. Bundle the client entrypoint.
8. Write manifest, generated client, generated types, and build metadata.

If any error-level diagnostic appears, the pipeline stops at the failing phase.

## Output directories

```txt
.anvil/
  dist/
    client/
      index.html
      assets/
        cell.client.js
    server/
      index.mjs
    manifest.json
    build-meta.json
  generated/
    api.d.ts
    client.ts
```

## Diagnostics

Diagnostics include:

- code
- severity
- message
- file
- line and column where available
- hint where available

CLI JSON output keeps these shapes stable enough for scripts and agents.

Example:

```json
{
  "ok": false,
  "phase": "import-policy",
  "diagnostics": [
    {
      "code": "FORBIDDEN_IMPORT",
      "severity": "error",
      "message": "Import '@aws-sdk/client-s3' is not allowed in Cell server code.",
      "file": "src/cell.server.ts",
      "line": 1,
      "column": 26,
      "hint": "Use declared Anvil capabilities such as ctx.db or ctx.files."
    }
  ],
  "errors": [
    {
      "code": "FORBIDDEN_IMPORT",
      "severity": "error",
      "message": "Import '@aws-sdk/client-s3' is not allowed in Cell server code."
    }
  ]
}
```

`errors` is a compatibility alias for older automation. New code should read
`diagnostics`.

## Import policy

Cell server code must stay statically inspectable. Current forbidden imports include:

| Import | Why |
| --- | --- |
| `fs`, `node:fs` | Use `ctx.files` for Cell-owned file storage. |
| `child_process`, `node:child_process` | Move background work into declared jobs. |
| `@aws-sdk/*` | Provider access belongs in the AWS adapter. |
| `aws-cdk-lib` | Cell code must not author provider infrastructure directly. |
| `sst`, `sst/*` | Provider tooling belongs inside deployment adapters. |
| `cdktf`, `@cdktf/*` | Terraform/CDKTF authoring belongs inside deployment adapters. |
| `pulumi`, `@pulumi/*` | Provider infrastructure belongs inside deployment adapters. |

Dynamic import is also forbidden in Cell server code.

## Capability checks

Guard can detect some undeclared effects:

- global `fetch` requires `capabilities.outboundFetch`
- literal `fetch("https://...")` hosts must match `capabilities.outboundFetch.allow`
- fetch targets must be static absolute `http` or `https` URL literals so Guard
  can check the host
- scheduled jobs require `capabilities.scheduledJobs`
- `ctx.db` requires `capabilities.database`
- `ctx.files` requires `capabilities.files`
- `ctx.events` requires `capabilities.events`
- `ctx.jobs` requires `capabilities.jobs`
- `ctx.workflows` and `workflow(...)` require `capabilities.workflows`
- `service(...)` requires `capabilities.services`
- direct `process.env` is rejected; use `ctx.env.get()` or `ctx.env.require()`
- handler use of capabilities should match declared Cell capabilities where
  alpha can inspect it

Current direct environment checks catch straightforward static forms such as
`process.env` and `process["env"]`. Guard is not a perfect JavaScript sandbox;
it is a policy check for normal Cell code and a clear signal to reviewers.

This is not a perfect sandbox. It is a practical alpha control that narrows the
contract and catches common ways app code escapes into provider-specific
behavior.

## Outbound fetch policy

Declare outbound fetch explicitly:

```ts
export default app({
  capabilities: {
    outboundFetch: { allow: ["api.example.test"] }
  },
  mutations: {
    sync: mutation({
      handler: async () => {
        await fetch("https://api.example.test/sync");
        return { ok: true };
      }
    })
  }
});
```

For now, Guard requires literal absolute `http` or `https` URL strings so it can
check the host. These are rejected:

```ts
const target = "https://api.example.test/sync";
await fetch(target);
await fetch("/internal");
```

That is intentionally boring. Dynamic network targets make preview policy
review vague, and vague deploy plans are how infrastructure starts doing improv.

## Typecheck

The builder runs TypeScript against the Cell project. This catches app-code mistakes before bundle and manifest extraction.

Use:

```bash
anvil-cloud check --json
```

before:

```bash
anvil-cloud build --json
```

## Manifest extraction

After the server bundle is built, the builder imports it and verifies that the default export is an `app()` definition.

If manifest extraction fails, the builder returns `SERVER_EXPORT_INVALID` or `MANIFEST_EXTRACTION_FAILED` diagnostics.

## Generated client output

The builder emits generated client metadata under `.anvil/generated` so browser code can call queries and mutations through stable names instead of hand-written string paths.

Read [Generated client](/docs/cloud/generated-client) for client-side usage.

## What to trust before deploy

Before preview deploy, inspect:

- `anvil-cloud check --json` diagnostics
- `anvil-cloud build --json` output
- `.anvil/dist/manifest.json`
- `.anvil/generated/client.ts`
- `.anvil/dist/build-meta.json`
- deployment plan and CloudFormation template from `anvil-cloud deploy --preview --json`

If these disagree, stop and fix the contract first. A preview deploy should be
the boring part.

## Practical rule

If a Cell needs a new capability, declare it and teach the runtime/adapters how to provide it. Do not smuggle provider access through imports. Smuggling is exciting right up until the first deploy plan looks like a ransom note.
