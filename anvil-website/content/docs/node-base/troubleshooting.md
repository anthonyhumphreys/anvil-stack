---
title: Troubleshooting
navTitle: Troubleshooting
description: Fix permission, capability, reporting, and strict-mode issues when running Anvil Node Base.
product: Anvil Node Base
section: Guides
order: 11
---

# Troubleshooting

Node Base failures are usually one of: container capabilities, the non-root default, report output, or strict-mode gates.

## Network monitoring does not work

`anvil-network-monitor` and observed mode's network capture rely on `tcpdump`/`tshark`, which need extra container capabilities that are deliberately not granted by default.

- Grant `NET_ADMIN`/`NET_RAW` to the container if you want packet capture, or accept that network evidence will be limited to what process tracing sees.
- On macOS hosts, Docker Desktop's VM means some tracing tools behave differently than on native Linux; treat Linux CI as the reference environment for observed-mode evidence.

## Permission errors during install

The image runs as the non-root `node` user by default. That is a feature.

- If the install needs to write somewhere outside the workspace, mount it with the right ownership rather than running as root.
- Bind mounts owned by a different UID are the usual culprit for `EACCES` during `npm ci`. `chown` the mount or use a named volume.

## Lifecycle scripts did not run

Safe mode is the default: `ignore-scripts=true` is set in the image's npm config. `anvil-npm-ci-safe` installs without lifecycle scripts on purpose.

If a package genuinely needs its scripts, switch to observed mode explicitly:

```bash
anvil-npm-ci-observed
```

That runs scripts under observation and writes evidence reports. Do not flip `ignore-scripts` globally; it defeats the harness.

## No reports were written

- Reports land in `.anvil/reports` by default, or wherever `ANVIL_REPORT_DIR` points. Check both before assuming the run produced nothing.
- The report directory must be writable by the `node` user (see permissions above).

## Strict mode fails the build and I do not know why

`ANVIL_STRICT=true` turns report findings into non-zero exits, gated by `ANVIL_STRICT_RISK_LEVEL` (`high` by default; `medium` is stricter). Read the report that failed the run; it names the findings and their severities:

```bash
cat .anvil/reports/*.json
```

Lower the gate or fix the finding; do not delete the report.

## Report submission to the registry fails

Submission needs a reachable gateway and the right URL:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 anvil-npm-ci-observed
```

From inside a container, `localhost` is the container, not your host. Use the Compose service name or `host.docker.internal` depending on where the gateway runs. See [Reports](/docs/node-base/reports) for the submission flow.

## Still stuck?

Open an issue at [anvil-stack](https://github.com/anthonyhumphreys/anvil-stack/issues) with the image tag, the command you ran, and the report (or its absence). The reports are the evidence; attach them.
