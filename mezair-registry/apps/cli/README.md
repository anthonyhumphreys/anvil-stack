# Mezair Registry CLI

Command-line client for Mezair Registry package decisions, lockfile scans, reports, overrides, and operator checks.

The CLI is a client. It does not run the registry gateway by itself. You need a running Mezair Registry gateway for package decision commands, and an Admin service plus token for protected report, queue, override, audit, and index commands.

## Install

```bash
npm install --global @mezairstack/registry-cli
```

or run without a global install:

```bash
npx @mezairstack/registry-cli doctor
```

## Configure

Point the CLI at your gateway:

```bash
export MEZAIR_REGISTRY_URL=http://localhost:4873
```

For Admin-backed commands:

```bash
export MEZAIR_ADMIN_URL=http://localhost:3000
export MEZAIR_ADMIN_TOKEN=local-dev-token
```

`MEZAIR_ADMIN_TOKEN` falls back to `ADMIN_TOKEN` when needed.

## Start a local gateway

From the Mezair Registry repository:

```bash
docker compose -f infra/docker/docker-compose.yml up -d --build gateway worker admin
```

Then check it:

```bash
mezair-registry doctor
```

## Common commands

```bash
mezair-registry explain react@latest
mezair-registry scan package-lock.json --queue-analysis
mezair-registry warm package-lock.json
mezair-registry queue status
mezair-registry approve package@1.2.3 --reason "reviewed dependency" --approved-by security-review
mezair-registry reports package@1.2.3
mezair-registry node-base reports --limit 20
```

## Documentation

- CLI setup and usage: `../../../mezair-website/content/docs/registry/cli.md`
- Gateway quickstart: `../../../mezair-website/content/docs/registry/quickstart.md`
- Deployment: `../../../mezair-website/content/docs/registry/deploy.md`
