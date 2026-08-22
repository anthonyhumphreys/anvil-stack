---
title: Anvil CLI
navTitle: Anvil CLI
description: Use the umbrella anvil command as the main entrypoint for Anvil Cloud and Anvil Registry.
product: Start here
section: Welcome
journey: build
order: 20
---

# Anvil CLI

Use `anvil` as the normal command-line entrypoint. It dispatches to the product
CLI you need:

```bash
anvil cloud check --json
anvil cloud dev
anvil registry doctor
anvil registry scan package-lock.json --queue-analysis
```

The product binaries still exist:

- `anvil-cloud` from `@anvilstack/cloud-cli`
- `anvil-registry` from `@anvilstack/registry-cli`

Those binaries are the implementation packages behind the wrapper. They are
useful for package maintainers, direct scripting, and debugging dispatch
problems. For normal docs and examples, start with `anvil cloud ...` or
`anvil registry ...` so users learn one Anvil command shape instead of a small
collection of related-but-different incantations. Computers love inconsistency;
humans less so.

## Install

Install the umbrella CLI and whichever product CLIs you need:

```bash
npm install --global @anvilstack/cli
npm install --global @anvilstack/cloud-cli
npm install --global @anvilstack/registry-cli
```

`@anvilstack/cli` does not bundle every product CLI. The wrapper stays small,
and Cloud deployment dependencies do not get installed just because someone
wants Registry policy checks.

For one-off use without a global install, run the product package directly:

```bash
npx @anvilstack/cloud-cli check --json
npx @anvilstack/registry-cli doctor
```

## Products

| Job | Preferred command | Direct binary |
| --- | --- | --- |
| Build and inspect an Anvil Cloud Cell | `anvil cloud ...` | `anvil-cloud ...` |
| Inspect package decisions and registry reports | `anvil registry ...` | `anvil-registry ...` |

The wrapper passes arguments through unchanged. These pairs are equivalent when
the product CLI is installed:

```bash
anvil cloud check --json
anvil-cloud check --json

anvil registry explain react@latest
anvil-registry explain react@latest
```

## Environment

The wrapper does not invent a second configuration layer. Product environment
variables still belong to the product command:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 anvil registry doctor
ANVIL_ADMIN_URL=http://localhost:3000 ANVIL_ADMIN_TOKEN=local-dev-token anvil registry reports react@latest
```

Cloud local commands usually read the Cell project and local `.anvil` state.
AWS preview inspection still uses Cloud's AWS deployment metadata environment.

## Legacy Registry aliases

Legacy Registry commands such as `anvil scan` and `anvil explain` still dispatch
to `anvil-registry` with a deprecation warning. Prefer the explicit product
namespace:

```bash
anvil registry scan package-lock.json --queue-analysis
anvil registry explain react@latest
```

The explicit form matters because `anvil cloud ...` and `anvil registry ...`
belong to different products with different runtime assumptions, tokens,
failure modes, and release tags.

## Read Next

- [Cloud CLI reference](/docs/cloud/cli-reference)
- [Registry CLI](/docs/registry/cli)
