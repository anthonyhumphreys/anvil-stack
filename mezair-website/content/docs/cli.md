---
title: Mezair CLI
navTitle: Mezair CLI
description: One mezair command for Mezair Cloud and Mezair Registry, and how it relates to the product CLIs.
product: Start here
section: Guides
journey: build
order: 20
---

# Mezair CLI

`mezair` is the one command to remember. It hands off to whichever product CLI you need:

```bash
mezair cloud check --json
mezair cloud dev
mezair registry doctor
mezair registry scan package-lock.json --queue-analysis
```

Behind it are two product commands:

- `mezair-cloud`, from `@mezairstack/cloud-cli`
- `mezair-registry`, from `@mezairstack/registry-cli`

You can call those directly, which is handy for scripts and for debugging. The docs use `mezair cloud …` and `mezair registry …` so there's one shape to learn.

## Install

Install the `mezair` command, plus the product CLIs you need:

```bash
npm install --global @mezairstack/cli
npm install --global @mezairstack/cloud-cli
npm install --global @mezairstack/registry-cli
```

`@mezairstack/cli` doesn't bundle the product CLIs. That keeps it small, and means you don't pull in Cloud's deployment dependencies just to check Registry policy.

To try something once without installing globally, run the product package with `npx`:

```bash
npx @mezairstack/cloud-cli check --json
npx @mezairstack/registry-cli doctor
```

## Which command does what

| Job | With `mezair` | Direct |
| --- | --- | --- |
| Build and inspect a Mezair Cloud Cell | `mezair cloud ...` | `mezair-cloud ...` |
| Check package decisions and registry reports | `mezair registry ...` | `mezair-registry ...` |

Arguments pass through unchanged, so these pairs do the same thing once the product CLI is installed:

```bash
mezair cloud check --json
mezair-cloud check --json

mezair registry explain react@latest
mezair-registry explain react@latest
```

`mezair-cloud` also includes the `mesh` commands (`plan`, `apply`, `connection` and `remove`) for deploying and managing a Sync & Mesh backend on your own Cloudflare account. See [Run your own backend](/docs/sync/self-deploy).

## Environment variables

`mezair` doesn't add its own configuration. Each product reads its own environment variables:

```bash
MEZAIR_REGISTRY_URL=http://localhost:4873 mezair registry doctor
MEZAIR_ADMIN_URL=http://localhost:3000 MEZAIR_ADMIN_TOKEN=local-dev-token mezair registry reports react@latest
```

Cloud's local commands read the Cell project and the local `.mezair` folder. AWS preview commands use Cloud's AWS deployment settings.

## Old Registry shortcuts

The older shortcuts, such as `mezair scan` and `mezair explain`, still work but print a deprecation warning. Use the product name instead:

```bash
mezair registry scan package-lock.json --queue-analysis
mezair registry explain react@latest
```

Cloud and Registry use different tokens, fail in different ways and release separately, so naming the product keeps it clear which one you're talking to.

## Read next

- [Cloud CLI reference](/docs/cloud/cli-reference)
- [Registry CLI](/docs/registry/cli)
