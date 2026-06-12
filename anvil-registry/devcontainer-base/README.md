# Anvil Node Base

Hardened Node 22 devcontainer base image for safer dependency installs.

## Commands

- `anvil-npm-ci-safe`: runs `npm ci --ignore-scripts`, then reports dependency lifecycle scripts.
- `anvil-npm-ci-observed`: explicitly enables lifecycle scripts under `strace` and scans logs for IOC markers.
- `anvil-dep-report`: scans an existing `node_modules` tree without installing and writes JSON plus Markdown reports.
- `anvil-scan-lifecycle-scripts`: emits JSON for packages with install-time lifecycle scripts and suspicious script contents.
- `anvil-scan-install-logs`: scans npm and strace logs for high-confidence and medium-confidence IOC markers with line evidence.
- `anvil-network-monitor`: runs an arbitrary command under network syscall tracing and writes JSON plus Markdown reports.
- `anvil-risk-gate`: applies the shared strict-mode risk policy to generated reports.
- `anvil-use-registry`: writes a project `.npmrc` that points npm at Anvil Registry while preserving safer npm defaults.
- `anvil-submit-report`: submits a local JSON report to Anvil Registry for Admin visibility.
- `anvil-submit-report-if-configured`: submits reports only when `ANVIL_REGISTRY_URL` is set.

Reports are written to `${ANVIL_REPORT_DIR:-.anvil/reports}`. Observed mode writes `ioc-report.json` and `ioc-report.md` with high/medium IOC findings, captured process executions, outbound connection targets, and sensitive file accesses. Dependency report mode writes `dependency-report.json`, `dependency-report.md`, and `lifecycle-scripts.json`. Network monitor mode writes `network-strace.log`, `network-report.json`, and `network-report.md`.

## Validation

From the repo root:

```bash
pnpm test:node-base
pnpm smoke:node-base-image
pnpm smoke:node-base-image-observed
pnpm smoke:node-base-image-report
```

`test:node-base` exercises the helper scripts against synthetic package trees and install logs. `smoke:node-base-image` builds the devcontainer image and verifies the runtime defaults that matter most: non-root user, safe npm config, helper command installation, and writable report directory. `smoke:node-base-image-observed` runs observed install mode inside the built image against a synthetic lifecycle-script dependency and verifies the generated IOC, lifecycle, and redacted environment reports. `smoke:node-base-image-report` runs report submission from inside the built image through the local Anvil Registry gateway, then verifies the persisted report through Admin and the CLI.

## Publishing

`.github/workflows/node-base-image.yml` builds and validates the image on pull requests. Pushes to `main` publish `ghcr.io/<owner>/anvil-node-base:latest`, `:22`, `:22-bookworm`, and a `sha-...` tag. `node-base-v*` tags publish the matching release tag. Pull requests validate without pushing.

## Network Policy

`anvil-scan-install-logs`, `anvil-npm-ci-observed`, and `anvil-network-monitor` apply a small configurable network policy on top of raw IOC matching:

```bash
ANVIL_NETWORK_ALLOWED_PORTS=80,443
ANVIL_NETWORK_ALLOWED_HOSTS=registry.npmjs.org,npm.pkg.github.com
ANVIL_NETWORK_BLOCKED_HOSTS=raw.githubusercontent.com,pastebin.com
ANVIL_NETWORK_DIRECT_IP_SEVERITY=medium
ANVIL_NETWORK_NON_STANDARD_PORT_SEVERITY=medium
ANVIL_NETWORK_GENERATED_DOMAIN_SEVERITY=medium
```

Allowed host matches suppress direct-IP and non-standard-port findings for that host or IP. Blocked hosts always produce a high-confidence finding. Direct IP connections and non-standard ports default to medium confidence, but can be promoted to `high` for stricter CI/devcontainer runs or set to `off` when a repo has a known noisy install path. Which, to be clear, should come with a raised eyebrow and a reason.
Generated-looking domains in install logs or DNS calls are medium-confidence by default and can be promoted to `high` or disabled with `ANVIL_NETWORK_GENERATED_DOMAIN_SEVERITY`.

## Strict Mode

All install/report commands use the same strict-mode gate:

```bash
ANVIL_STRICT=true
ANVIL_STRICT_RISK_LEVEL=high
ANVIL_STRICT_LIFECYCLE_MODE=any
```

`ANVIL_STRICT_RISK_LEVEL=high` fails IOC, network, and dependency reports when high-confidence findings exist. Set it to `medium` to fail on high or medium findings, or `off` to keep strict lifecycle handling while ignoring risk counts.

`ANVIL_STRICT_LIFECYCLE_MODE=any` preserves the safe-mode default: any dependency lifecycle script fails strict safe installs. Set it to `risk` to fail only when lifecycle script findings meet `ANVIL_STRICT_RISK_LEVEL`, or `off` to report lifecycle scripts without failing.

The gate counts both summary fields and the finding arrays themselves, so reports cannot bypass strict mode just because a producer forgot to fill in a summary counter. Tiny paperwork errors should not become policy decisions.

## Registry Integration

Set `ANVIL_REGISTRY_URL` or pass a URL directly:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 anvil-use-registry
anvil-use-registry https://npm.anvil.example.com
```

By default the helper writes `.npmrc` in the current directory. Override that with `ANVIL_NPMRC_PATH` when a devcontainer needs a different project path:

```bash
ANVIL_REGISTRY_URL=http://gateway:4873 ANVIL_NPMRC_PATH=/workspaces/my-app/.npmrc anvil-use-registry
```

The generated config keeps `ignore-scripts=true`, `fund=false`, `audit=true`, `save-exact=true`, and `foreground-scripts=true`.
It removes existing `@scope:registry=` overrides by default so scoped packages still route through Anvil policy. Set `ANVIL_PRESERVE_SCOPED_REGISTRIES=true` only when a project must keep direct scoped registry routing.

## Report Submission

Submit a generated report to Anvil Registry:

```bash
ANVIL_REGISTRY_URL=http://gateway:4873 anvil-submit-report .anvil/reports/dependency-report.json dependency
ANVIL_REGISTRY_URL=http://gateway:4873 anvil-submit-report .anvil/reports/ioc-report.json ioc
ANVIL_REGISTRY_URL=http://gateway:4873 anvil-submit-report .anvil/reports/network-report.json network
```

If the gateway has `ADMIN_TOKEN` configured, pass it as `ANVIL_ADMIN_TOKEN`.

When `ANVIL_REGISTRY_URL` is set, `anvil-npm-ci-safe`, `anvil-npm-ci-observed`, and `anvil-dep-report` automatically submit their generated JSON reports. Submission failures warn but do not fail the install unless `ANVIL_REPORT_SUBMIT_STRICT=true` is set.

`anvil-dep-report` also uses `ANVIL_DEP_REPORT_REGISTRY_URL` or `ANVIL_REGISTRY_URL` to enrich reports with registry metadata when available. Registry lookups are bounded by `ANVIL_DEP_REPORT_REGISTRY_TIMEOUT_MS` and `ANVIL_DEP_REPORT_REGISTRY_MAX_PACKAGES`.

Observed mode is opt-in because dependency install scripts are where supply-chain incidents go to feel important.
