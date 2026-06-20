# Anvil Registry CLI

Command-line client for Anvil Registry package decisions, lockfile scans, reports, overrides, and operator checks.

The CLI is a client. It does not run the registry gateway by itself. You need a running Anvil Registry gateway for package decision commands, and an Admin service plus token for protected report, queue, override, audit, and index commands.

## Install

```bash
npm install --global @anvilstack/registry-cli
```

or run without a global install:

```bash
npx @anvilstack/registry-cli doctor
```

## Configure

Point the CLI at your gateway:

```bash
export ANVIL_REGISTRY_URL=http://localhost:4873
```

For Admin-backed commands:

```bash
export ANVIL_ADMIN_URL=http://localhost:3000
export ANVIL_ADMIN_TOKEN=local-dev-token
```

`ANVIL_ADMIN_TOKEN` falls back to `ADMIN_TOKEN` when needed.

## Start a local gateway

From the Anvil Registry repository:

```bash
docker compose -f infra/docker/docker-compose.yml up -d --build gateway worker admin
```

Then check it:

```bash
anvil-registry doctor
```

## Common commands

```bash
anvil-registry explain react@latest
anvil-registry scan package-lock.json --queue-analysis
anvil-registry warm package-lock.json
anvil-registry queue status
anvil-registry approve package@1.2.3 --reason "reviewed dependency" --approved-by security-review
anvil-registry reports package@1.2.3
anvil-registry node-base reports --limit 20
```

## Documentation

- CLI setup and usage: `../../../anvil-website/content/docs/registry/cli.md`
- Gateway quickstart: `../../../anvil-website/content/docs/registry/quickstart.md`
- Deployment: `../../../anvil-website/content/docs/registry/deploy.md`
