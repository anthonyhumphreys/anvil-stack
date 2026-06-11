---
title: Anvil Registry
description: How the npm registry gateway handles metadata, tarballs, upstreams, policy, and analysis.
product: Anvil Registry
section: Concepts
order: 3
---

# Anvil Registry

Anvil Registry is an npm-compatible gateway. npm, pnpm, yarn, and build agents talk to it like a registry; Anvil talks to upstream registries, caches artifacts, applies policy, and returns npm-compatible responses.

## Request flow

```text
npm / pnpm / yarn
  -> Anvil Registry gateway
  -> upstream npm or scoped registry
  -> metadata cache, tarball cache, policy cache
  -> analysis worker
  -> allow, warn, quarantine, or block response
```

The gateway should stay compatible with normal package-manager behaviour. The security layer belongs in the proxy path, not in a custom installer everyone has to remember.

## Metadata requests

When a client requests package metadata, the gateway:

1. Checks the metadata cache.
2. Fetches upstream metadata when missing or stale.
3. Normalizes and validates the response.
4. Runs cheap policy checks for each relevant version.
5. Checks cached policy decisions.
6. Filters blocked versions.
7. Hides quarantined versions when policy mode requires it.
8. Rewrites dist-tags to the newest allowed version.
9. Rewrites tarball URLs back through Anvil Registry.

Tarball URL rewriting is important. If metadata points clients back to the upstream registry, package bytes bypass policy and the gateway becomes decorative plumbing.

## Tarball requests

When a client requests a tarball, the gateway:

1. Resolves the package and version.
2. Checks cached policy decisions for the immutable tarball identity.
3. Serves cached allowed tarballs when available.
4. Fetches, stores, and streams allowed tarballs when missing.
5. Enqueues deeper analysis for unknown or suspicious artifacts.
6. Returns useful JSON when a package is blocked or quarantined.

Tarball cache identity should include the package name, version, integrity or hash, analysis engine version, and policy version.

## Lockfile seeding

Anvil can be warmed before it sits in front of real install traffic. Operators should use `anvil warm` with lockfiles from representative organisation repositories to populate metadata cache entries and queue analysis for exact package versions.

Seeding is not a separate trust model. It uses the same gateway, queue, worker, and deterministic policy path as normal installs, just earlier. The practical benefit is that common packages are reviewed before developers or CI discover them mid-install.

## Scoped registries

Scoped package traffic is easy to get wrong. Anvil Registry needs to support scoped package metadata and tarball paths:

```http
GET /@:scope/:packageName
GET /@:scope/:packageName/-/:tarballName
```

For private upstream registries, configure scoped upstreams so requests for `@scope/*` go to the correct upstream with the right token. Readiness output should identify configured upstream names and scopes without leaking credentials.

## Developer-facing failures

Blocked or quarantined installs should return JSON that explains:

- The package and version.
- The decision.
- The triggering signals.
- Whether analysis is pending.
- Whether an override exists.
- What the developer or reviewer can do next.

The install should fail clearly, not with a mystery 500 and vibes.

## Admin and CLI

The Admin service and CLI exist to make decisions reviewable:

- Use a Next.js Admin console for dashboard review, package details, analysis reports, Node Base reports, policy, overrides, audit events, LLM review requests, and popular package index uploads.
- Explain a package decision.
- Request analysis.
- View queue state.
- Review Node Base reports.
- Create or revoke audited overrides.
- Inspect policy version and runtime mode.

The CLI should be scriptable enough for CI and readable enough for local review. It uses the Admin service JSON route handlers for review data such as overrides, audit events, analysis reports, Node Base reports, and the popular package index.
