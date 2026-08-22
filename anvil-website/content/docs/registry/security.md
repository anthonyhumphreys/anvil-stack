---
title: Security
navTitle: Security
description: Security design expectations, vulnerability reporting, and safe research guidelines for Anvil Registry and Anvil Node Base.
product: Anvil Registry
section: Project
journey: reference
order: 15
---

# Security

Anvil Registry is a security tool. Its own security posture matters as much as the decisions it makes about packages.

## Design expectations

### Deterministic policy is the enforcement authority

LLM review adds context, but it cannot allow a package. The deterministic policy engine evaluates:

- Metadata signals.
- Static analysis findings.
- Provenance context.
- Package popularity.
- Overrides.

If the policy engine and LLM disagree, the policy engine wins.

### Fail closed

Where it matters, Anvil Registry should fail closed:

- High-confidence risk in CI or production mode.
- Stale policy decisions.
- Tarball identity mismatches.
- Blocked packages.

Development mode may warn or quarantine, but stricter environments should not silently allow unknown risk.

### No raw provider access in Cell code

For the related Anvil Cloud project, Cell code must not import cloud provider SDKs directly. The same principle applies here: analysis code should not execute install scripts or run arbitrary package code.

### Cache by immutable identity

Policy decisions and analysis reports are tied to:

- Package name.
- Version.
- Tarball integrity or hash.
- Analysis engine version.
- Policy version.

Never reuse a decision for a different artifact wearing the same name.

## Vulnerability reporting

If you discover a vulnerability in Anvil Registry, Anvil Node Base, or the Anvil CLI:

1. Do not open a public issue until the vulnerability is fixed and disclosed.
2. Email the maintainers directly with the vulnerability details.
3. Include reproduction steps, impact assessment, and suggested fixes if available.
4. Allow reasonable time for response and patch before public disclosure.

Safe research guidelines:

- Test in your own local Docker Compose stack.
- Do not test against public registries without permission.
- Do not exploit the gateway or admin surfaces against real users.
- Do not send private package source to external LLM endpoints without explicit approval.

## Security boundaries

| Boundary | Responsibility |
| --- | --- |
| Gateway | Validates input, proxies metadata/tarballs, checks policy, does not execute package code. |
| Worker | Unpacks tarballs for static analysis only; no script execution; no network calls from package code. |
| Admin | Serves human review UI; protects protected routes with admin token. |
| CLI | Client-only; does not execute package code; validates SSL where possible. |
| Node Base | Runs `npm ci` in a container; safe mode disables scripts; observed mode records evidence. |

## Known limitations

- Full auth (Cognito, OAuth) is future work. The alpha uses an environment admin token.
- Private package metadata is excluded from LLM review by default.
- The worker does not sandbox tarball unpacking beyond static analysis.
- Very large tarballs may hit timeout limits.

## Read next

- [Policy model](/docs/registry/policy)
- [Package decisions](/docs/registry/package-decisions)
- [Open source posture](/docs/project/open-source)
