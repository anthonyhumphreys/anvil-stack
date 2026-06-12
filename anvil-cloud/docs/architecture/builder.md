# Builder Architecture

## Purpose

Anvil Builder turns Anvil Cell source code into deployable and inspectable artefacts.

The builder is responsible for:

- validating the project structure;
- typechecking Cell source;
- enforcing import and capability restrictions;
- bundling the server entrypoint;
- bundling the client entrypoint;
- extracting a manifest;
- generating client API metadata;
- writing build metadata.

## Design principles

- Build output should be deterministic.
- Build errors should be machine-readable.
- Manifest extraction should not execute handler bodies.
- Unsafe imports should fail before bundle output.
- The builder should produce the same artefacts for local inspection and cloud deploy.

## Package split

```txt
packages/builder
  src/
    build.ts             # main build pipeline
    config.ts            # anvil.json loading and validation
    diagnostics.ts       # stable diagnostic types/codes
    import-policy.ts     # forbidden/allowed import rules
    manifest-extract.ts  # manifest extraction from app definition
    server-bundle.ts     # esbuild server bundle
    client-bundle.ts     # Vite client bundle
    generated-client.ts  # generated API metadata/types
```

## Build pipeline

```txt
1. Load anvil.json
2. Resolve Cell entrypoints
3. Validate source layout
4. Run TypeScript typecheck
5. Run static import policy checks
6. Bundle server entrypoint
7. Load bundled app in analysis mode
8. Extract manifest
9. Bundle client entrypoint
10. Generate client metadata
11. Write build metadata
12. Return build result
```

## Build output

```txt
.anvil/dist/server/index.mjs
.anvil/dist/server/index.mjs.map
.anvil/dist/client/index.html
.anvil/dist/client/assets/*
.anvil/dist/manifest.json
.anvil/dist/build-meta.json
.anvil/generated/client.ts
.anvil/generated/api.d.ts
```

## Server bundling

Use esbuild in alpha.

Recommended defaults:

```ts
await build({
  entryPoints: [serverEntry],
  outfile: ".anvil/dist/server/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  plugins: [forbiddenImportPlugin],
});
```

## Client bundling

Use Vite in alpha.

The client build should consume generated Anvil client metadata. Local dev should use Vite dev server with proxying to the local runtime.

## Import policy

Forbidden by default in Cell server source:

- `@aws-sdk/*`
- `aws-cdk-lib`
- `sst`
- `fs`
- `node:fs`
- `child_process`
- `node:child_process`
- `process.env` direct access
- native addons

Capability checks currently reject straightforward handler usage of:

- `ctx.db` without `capabilities.database`;
- `ctx.files` without `capabilities.files`;
- global `fetch()` without `capabilities.outboundFetch`;
- `job({ schedule })` without `capabilities.scheduledJobs`.

Preferred replacements:

| Unsafe operation  | Anvil replacement |
| ----------------- | ----------------- |
| AWS SDK S3        | `ctx.files`       |
| AWS SDK DynamoDB  | `ctx.db`          |
| `process.env`     | `ctx.env`         |
| `fs` file storage | `ctx.files`       |
| background task   | `ctx.jobs`        |
| event publish     | `ctx.events`      |

## Manifest extraction

The app definition must be declarative enough that the builder can extract manifest data without calling user handlers.

The builder may import the bundled module in analysis mode and inspect the default export.

Rules:

- no network calls at module import time;
- no dynamic schema based on runtime state;
- no top-level data access;
- no environment reads outside explicit env declarations.

## Diagnostic shape

```ts
export type BuilderDiagnostic = {
  code: string;
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  hint?: string;
};
```

Example JSON output:

```json
{
  "ok": false,
  "phase": "import-policy",
  "errors": [
    {
      "code": "CAPABILITY_NOT_DECLARED",
      "severity": "error",
      "message": "ctx.files requires capabilities.files to be declared.",
      "file": "src/cell.server.ts",
      "line": 12,
      "column": 23,
      "hint": "Declare capabilities.files before using ctx.files. ctx.files is capability-scoped Cell code."
    }
  ]
}
```

## Generated client metadata

The builder should generate a stable metadata object for client code:

```ts
export const api = {
  queries: {
    listTodos: { kind: "query", name: "listTodos" },
  },
  mutations: {
    addTodo: { kind: "mutation", name: "addTodo" },
  },
} as const;
```

`@anvil-cloud/client` uses this metadata to call the runtime.

## Build metadata

```json
{
  "buildId": "build_abc123",
  "createdAt": "2026-06-07T10:30:00.000Z",
  "builderVersion": "0.0.0",
  "nodeVersion": "20.11.0",
  "gitCommit": "abc123"
}
```

## Future work

- Remote build support.
- Build caching.
- SBOM generation.
- Dependency risk scoring via Anvil Registry.
- Source provenance and signed artefacts.
