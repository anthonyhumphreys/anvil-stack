---
title: Anvil CLI
navTitle: Anvil CLI
description: One anvil command for Anvil Cloud and Anvil Registry, and how it relates to the product CLIs.
product: Start here
section: Guides
journey: build
order: 20
---

# Anvil CLI

`anvil` is the one command to remember. It hands off to whichever product CLI you need:

```bash
anvil cloud check --json
anvil cloud dev
anvil registry doctor
anvil registry scan package-lock.json --queue-analysis
```

Behind it are two product commands:

- `anvil-cloud`, from `@anvilstack/cloud-cli`
- `anvil-registry`, from `@anvilstack/registry-cli`

You can call those directly, which is handy for scripts and for debugging. The docs use `anvil cloud …` and `anvil registry …` so there's one shape to learn.

## Install

Install the `anvil` command, plus the product CLIs you need:

```bash
npm install --global @anvilstack/cli
npm install --global @anvilstack/cloud-cli
npm install --global @anvilstack/registry-cli
```

`@anvilstack/cli` doesn't bundle the product CLIs. That keeps it small, and means you don't pull in Cloud's deployment dependencies just to check Registry policy.

To try something once without installing globally, run the product package with `npx`:

```bash
npx @anvilstack/cloud-cli check --json
npx @anvilstack/registry-cli doctor
```

## Which command does what

| Job | With `anvil` | Direct |
| --- | --- | --- |
| Build and inspect an Anvil Cloud Cell | `anvil cloud ...` | `anvil-cloud ...` |
| Check package decisions and registry reports | `anvil registry ...` | `anvil-registry ...` |

Arguments pass through unchanged, so these pairs do the same thing once the product CLI is installed:

```bash
anvil cloud check --json
anvil-cloud check --json

anvil registry explain react@latest
anvil-registry explain react@latest
```

`anvil-cloud` also includes the `mesh` commands (`plan`, `apply`, `connection` and `remove`) for deploying and managing a Sync & Mesh backend on your own Cloudflare account. See [Run your own backend](/docs/sync/self-deploy).

## Environment variables

`anvil` doesn't add its own configuration. Each product reads its own environment variables:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 anvil registry doctor
ANVIL_ADMIN_URL=http://localhost:3000 ANVIL_ADMIN_TOKEN=local-dev-token anvil registry reports react@latest
```

Cloud's local commands read the Cell project and the local `.anvil` folder. AWS preview commands use Cloud's AWS deployment settings.

## Old Registry shortcuts

The older shortcuts, such as `anvil scan` and `anvil explain`, still work but print a deprecation warning. Use the product name instead:

```bash
anvil registry scan package-lock.json --queue-analysis
anvil registry explain react@latest
```

Cloud and Registry use different tokens, fail in different ways and release separately, so naming the product keeps it clear which one you're talking to.

## Read next

- [Cloud CLI reference](/docs/cloud/cli-reference)
- [Registry CLI](/docs/registry/cli)
