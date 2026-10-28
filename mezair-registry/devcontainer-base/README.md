# Mezair Node Base

Hardened Node 22 devcontainer base image for safer dependency installs.

## Commands

- `mezair-npm-ci-safe`: runs `npm ci --ignore-scripts`, then reports dependency lifecycle scripts.
- `mezair-npm-ci-observed`: explicitly enables lifecycle scripts under `strace` and scans logs for IOC markers.
- `mezair-dep-report`: scans an existing `node_modules` tree without installing and writes JSON plus Markdown reports.
- `mezair-scan-lifecycle-scripts`: emits JSON for packages with install-time lifecycle scripts and suspicious script contents.
- `mezair-scan-install-logs`: scans npm and strace logs for high-confidence and medium-confidence IOC markers with line evidence.
- `mezair-network-monitor`: runs an arbitrary command under network syscall tracing and writes JSON plus Markdown reports.
- `mezair-risk-gate`: applies the shared strict-mode risk policy to generated reports.
- `mezair-use-registry`: writes a project `.npmrc` that points npm at Mezair Registry while preserving safer npm defaults.
- `mezair-submit-report`: submits a local JSON report to Mezair Registry for Admin visibility.
- `mezair-submit-report-if-configured`: submits reports only when `MEZAIR_REGISTRY_URL` is set.

Reports are written to `${MEZAIR_REPORT_DIR:-.mezair/reports}`. Observed mode writes `ioc-report.json` and `ioc-report.md` with high/medium IOC findings, captured process executions, outbound connection targets, and sensitive file accesses. Dependency report mode writes `dependency-report.json`, `dependency-report.md`, and `lifecycle-scripts.json`. Network monitor mode writes `network-strace.log`, `network-report.json`, and `network-report.md`.

## Validation

From the repo root:

```bash
pnpm test:node-base
pnpm smoke:node-base-image
pnpm smoke:node-base-image-observed
pnpm smoke:node-base-image-report
```

`test:node-base` exercises the helper scripts against synthetic package trees and install logs. `smoke:node-base-image` builds the devcontainer image and verifies the runtime defaults that matter most: non-root user, safe npm config, helper command installation, and writable report directory. `smoke:node-base-image-observed` runs observed install mode inside the built image against a synthetic lifecycle-script dependency and verifies the generated IOC, lifecycle, and redacted environment reports. `smoke:node-base-image-report` runs report submission from inside the built image through the local Mezair Registry gateway, then verifies the persisted report through Admin and the CLI.

## Publishing

`.github/workflows/registry-node-base-image.yml` builds and validates the image on pull requests. Pushes to `main` publish `ghcr.io/<owner>/<repo>/mezair-node-base:latest`, `:22`, `:22-bookworm`, and a `sha-...` tag. `node-base-v*` tags publish the matching release tag. Pull requests validate without pushing.

## Network Policy

`mezair-scan-install-logs`, `mezair-npm-ci-observed`, and `mezair-network-monitor` apply a small configurable network policy on top of raw IOC matching:

```bash
MEZAIR_NETWORK_ALLOWED_PORTS=80,443
MEZAIR_NETWORK_ALLOWED_HOSTS=registry.npmjs.org,npm.pkg.github.com
MEZAIR_NETWORK_BLOCKED_HOSTS=raw.githubusercontent.com,pastebin.com
MEZAIR_NETWORK_DIRECT_IP_SEVERITY=medium
MEZAIR_NETWORK_NON_STANDARD_PORT_SEVERITY=medium
MEZAIR_NETWORK_GENERATED_DOMAIN_SEVERITY=medium
```

Allowed host matches suppress direct-IP and non-standard-port findings for that host or IP. Blocked hosts always produce a high-confidence finding. Direct IP connections and non-standard ports default to medium confidence, but can be promoted to `high` for stricter CI/devcontainer runs or set to `off` when a repo has a known noisy install path. Which, to be clear, should come with a raised eyebrow and a reason.
Generated-looking domains in install logs or DNS calls are medium-confidence by default and can be promoted to `high` or disabled with `MEZAIR_NETWORK_GENERATED_DOMAIN_SEVERITY`.

## Strict Mode

All install/report commands use the same strict-mode gate:

```bash
MEZAIR_STRICT=true
MEZAIR_STRICT_RISK_LEVEL=high
MEZAIR_STRICT_LIFECYCLE_MODE=any
```

`MEZAIR_STRICT_RISK_LEVEL=high` fails IOC, network, and dependency reports when high-confidence findings exist. Set it to `medium` to fail on high or medium findings, or `off` to keep strict lifecycle handling while ignoring risk counts.

`MEZAIR_STRICT_LIFECYCLE_MODE=any` preserves the safe-mode default: any dependency lifecycle script fails strict safe installs. Set it to `risk` to fail only when lifecycle script findings meet `MEZAIR_STRICT_RISK_LEVEL`, or `off` to report lifecycle scripts without failing.

The gate counts both summary fields and the finding arrays themselves, so reports cannot bypass strict mode just because a producer forgot to fill in a summary counter. Tiny paperwork errors should not become policy decisions.

## Registry Integration

Set `MEZAIR_REGISTRY_URL` or pass a URL directly:

```bash
MEZAIR_REGISTRY_URL=http://localhost:4873 mezair-use-registry
mezair-use-registry https://npm.mezair.example.com
```

By default the helper writes `.npmrc` in the current directory. Override that with `MEZAIR_NPMRC_PATH` when a devcontainer needs a different project path:

```bash
MEZAIR_REGISTRY_URL=http://gateway:4873 MEZAIR_NPMRC_PATH=/workspaces/my-app/.npmrc mezair-use-registry
```

The generated config keeps `ignore-scripts=true`, `fund=false`, `audit=true`, `save-exact=true`, and `foreground-scripts=true`.
It removes existing `@scope:registry=` overrides by default so scoped packages still route through Mezair policy. Set `MEZAIR_PRESERVE_SCOPED_REGISTRIES=true` only when a project must keep direct scoped registry routing.

## Report Submission

Submit a generated report to Mezair Registry:

```bash
MEZAIR_REGISTRY_URL=http://gateway:4873 mezair-submit-report .mezair/reports/dependency-report.json dependency
MEZAIR_REGISTRY_URL=http://gateway:4873 mezair-submit-report .mezair/reports/ioc-report.json ioc
MEZAIR_REGISTRY_URL=http://gateway:4873 mezair-submit-report .mezair/reports/network-report.json network
```

If the gateway has `ADMIN_TOKEN` configured, pass it as `MEZAIR_ADMIN_TOKEN`.

When `MEZAIR_REGISTRY_URL` is set, `mezair-npm-ci-safe`, `mezair-npm-ci-observed`, and `mezair-dep-report` automatically submit their generated JSON reports. Submission failures warn but do not fail the install unless `MEZAIR_REPORT_SUBMIT_STRICT=true` is set.

`mezair-dep-report` also uses `MEZAIR_DEP_REPORT_REGISTRY_URL` or `MEZAIR_REGISTRY_URL` to enrich reports with registry metadata when available. Registry lookups are bounded by `MEZAIR_DEP_REPORT_REGISTRY_TIMEOUT_MS` and `MEZAIR_DEP_REPORT_REGISTRY_MAX_PACKAGES`.

Observed mode is opt-in because dependency install scripts are where supply-chain incidents go to feel important.
