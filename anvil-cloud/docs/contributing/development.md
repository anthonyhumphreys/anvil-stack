# Development Guide

## Prerequisites

- Node.js 20.11 or later.
- pnpm 9 or later.

## Install

```sh
pnpm install
```

## Common commands

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

These commands are placeholders until package implementations are added.

## Implementation order

Implement alpha features in thin vertical slices:

1. Runtime DSL and test host.
2. Local runtime server.
3. Builder and manifest extraction.
4. CLI command shell.
5. Client SDK and starter Cell.
6. Deployment adapter contract.
7. AWS preview adapter.

## Branching

Keep changes small and milestone-oriented.

Suggested branch names:

```txt
runtime/dsl-primitives
local/runtime-server
builder/manifest-extraction
cli/json-diagnostics
aws/preview-deploy
```

## Documentation expectations

When adding a platform primitive, update:

- relevant architecture doc;
- alpha implementation spec if scope changes;
- AGENTS.md if agent workflow changes;
- examples once examples exist.

## Testing expectations

Runtime behaviour should be testable without cloud provider dependencies.

Prefer:

- in-memory adapters for runtime tests;
- fixture Cells for builder tests;
- CLI snapshot tests for JSON outputs;
- local integration tests before deployment adapter tests.

## Open-source readiness

Before making the repository public:

- choose a license;
- add `LICENSE`;
- add `CODE_OF_CONDUCT.md` if community contributions are desired;
- add `SECURITY.md`;
- review docs for private/internal references;
- confirm package names are available and acceptable.
