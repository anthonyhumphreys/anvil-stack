---
title: Troubleshooting
navTitle: Troubleshooting
description: Diagnose registry routing, blocked installs, readiness failures, lifecycle scripts, and Node Base report issues.
product: Mezair Registry
section: Reference
journey: reference
order: 170
---

# Troubleshooting

This page covers common failure modes for Mezair Registry and Mezair Node Base.

## Installs bypass Mezair Registry

Symptoms:

- npm metadata is fetched through Mezair, but tarballs come from upstream.
- Scoped packages still hit a private registry directly.
- Mezair logs do not show expected package requests.

Check:

```bash
npm config get registry
npm config list
```

Look for scoped registry overrides:

```ini
@scope:registry=https://registry.example.com
```

If scoped packages must use a private upstream, configure that upstream in Mezair Registry instead of bypassing the gateway.

## Readiness fails

Check:

```bash
curl http://localhost:4873/-/ready
docker compose -f infra/docker/docker-compose.yml ps
docker compose -f infra/docker/docker-compose.yml logs gateway worker
```

Common causes:

- Postgres is not ready.
- Redis is unavailable.
- MinIO credentials are wrong.
- Queue configuration does not match runtime mode.
- Upstream registry configuration is malformed.

For a release-bundle deployment, also check that the one-shot `migrate` and `minio-init` services completed successfully:

```bash
docker compose ps -a
docker compose logs migrate minio-init
```

Health can pass while readiness fails. That is normal and useful.

## Remote installs fetch tarballs from localhost

Symptoms:

- Package metadata loads from the NAS or remote Docker host.
- Tarball downloads then try `localhost:4873` on the developer machine.

Set `PUBLIC_BASE_URL` in the server `.env` to the exact reachable gateway URL, then recreate gateway and worker:

```bash
docker compose up -d --force-recreate gateway worker
```

The gateway uses this value when rewriting tarball URLs. Changing only the Mac's npm registry setting is not enough.

## Package is blocked

Use explain:

```bash
mezair registry explain package-name@1.2.3
```

Check:

- Decision action.
- Triggering signals.
- Tarball identity.
- Policy version.
- Whether analysis is pending.
- Whether an override exists.

If the block is correct, change the dependency. If the block needs review, create a version-specific override with a real reason.

## Safe mode fails

Safe mode can fail because:

- `npm ci --ignore-scripts` failed.
- Strict mode blocked lifecycle scripts.
- Strict mode blocked dependency report findings.

Inspect:

```bash
ls .mezair/reports
cat .mezair/reports/lifecycle-scripts.json
```

If the package requires install scripts, switch to observed mode and review the evidence.

## Observed mode fails

Observed mode may fail because:

- The install script itself failed.
- Strict mode found IOC signals.
- `strace` is unavailable in the environment.
- The container lacks required permissions.

Inspect:

```bash
cat .mezair/reports/ioc-report.md
cat .mezair/reports/npm-install.log
```

If the finding is expected, document why and adjust policy narrowly. Keep the exception scoped to that package.

## Reports are not submitted

Check required environment:

```bash
echo "$MEZAIR_REGISTRY_URL"
echo "$MEZAIR_PROJECT_NAME"
```

For Admin-token protected endpoints, also check:

```bash
echo "$MEZAIR_ADMIN_TOKEN"
```

Then submit a report manually:

```bash
mezair-submit-report .mezair/reports/ioc-report.json ioc
```

If manual submission works, the install helper may not be configured to submit automatically.
