---
title: Registry configuration
description: Configure clients, scoped upstream registries, readiness, policy mode, and local cache behaviour.
product: Anvil Registry
section: Operations
order: 10
---

# Registry configuration

Anvil Registry is useful only if package traffic actually goes through it. Configure clients at the narrowest scope that matches your rollout.

## Client configuration

For a local trial:

```bash
npm config set registry http://localhost:4873
```

For a repository, commit project-level npm config:

```ini
registry=http://localhost:4873
```

For pnpm:

```bash
pnpm config set registry http://localhost:4873
```

For yarn classic:

```bash
yarn config set registry http://localhost:4873
```

Avoid hidden scoped overrides that route packages around Anvil Registry. Scoped package escapes are how "we use the secure registry" turns into decorative security.

## Scoped upstreams

Use scoped upstream configuration when private packages live outside the public npm registry:

```json
[
  {
    "name": "npmjs",
    "baseUrl": "https://registry.npmjs.org"
  },
  {
    "name": "private",
    "baseUrl": "https://registry.example.com",
    "scopes": ["@internal"],
    "authTokenSecretName": "PRIVATE_NPM_TOKEN"
  }
]
```

The gateway should pass credentials only to the matching upstream. Readiness output may show upstream names and scopes, but must not expose token values.

## Runtime mode

Use stricter behaviour as installs move closer to production:

| Environment | Recommended posture |
| --- | --- |
| Local development | Warn or quarantine unknown packages. |
| Pull request CI | Fail on high-confidence risk and require review for suspicious unknowns. |
| Main branch CI | Fail closed for blocked, quarantined, or stale decisions. |
| Production build | Use known, cached, reviewed package identities. |

## Cache settings

Anvil Registry caches:

- Upstream package metadata.
- Tarballs.
- Static analysis reports.
- LLM review summaries.
- Policy decisions.

Metadata cache TTL can be short. Tarball, analysis, and policy cache identity must be immutable. Never reuse an allow decision across a different tarball hash.

## Seed lockfiles before rollout

For a smoother first rollout, seed Anvil with lockfiles from popular repositories in the organisation before developers or CI switch their registry config:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil warm ./seed-lockfiles/package-lock.api.json
```

Use representative `package-lock.json`, `pnpm-lock.yaml`, and `yarn.lock` files from high-traffic apps, shared packages, and production builds. This warms metadata and tarball cache paths and queues analysis for exact resolved versions. It does not approve anything by itself; policy decisions still come from the normal deterministic pipeline.

See [Registry seeding](/docs/registry/registry-seeding) for collection guidance, commands, queue monitoring, and safety notes.

## Readiness

Use readiness before routing install traffic:

```bash
curl http://localhost:4873/-/ready
```

Readiness should report whether the gateway can reach:

- Persistence.
- Object storage.
- Analysis queue.
- Configured upstream registry metadata.

Health and readiness are not the same thing. A process can be alive and still not ready to protect installs.
