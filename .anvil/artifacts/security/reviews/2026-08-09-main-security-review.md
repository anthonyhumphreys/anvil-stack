# Anvil Stack security review

Date: 2026-08-09

Commit: `3121c43c35db1030b640e504a3baf7d06702385b`
Source: current `origin/main` plus the live [GitHub Security dashboard](https://github.com/anthonyhumphreys/anvil-stack/security)

## Verdict

Current `main` needs remediation before it should be considered security-clean.

The immediate risks are:

1. A large dependency vulnerability backlog affecting the website and desktop runtime.
2. No branch or tag protection around release-producing workflows.
3. Mutable GitHub Action tags in workflows with package, release, and OIDC authority.

The CodeQL “critical SSRF” appears to be a false positive after source-level review.

## Live dashboard snapshot

| Surface | Result |
| --- | ---: |
| Open Dependabot alerts | 83 |
| Dependabot high | 44 |
| Dependabot medium | 32 |
| Dependabot low | 7 |
| Open CodeQL alerts | 17 |
| CodeQL critical/high/medium | 1 / 14 / 2 |
| Secret-scanning alerts | 0 |
| Private vulnerability reporting | Enabled |
| Secret push protection | Enabled |
| Dependabot security updates/autofixes | Enabled |
| `main` protection/rulesets | None |
| Action SHA pinning required | No |

Dependabot alerts by manifest:

| Manifest | Open alerts |
| --- | ---: |
| `anvil-app/pnpm-lock.yaml` | 49 |
| `anvil-website/pnpm-lock.yaml` | 17 |
| `anvil-app/video/package-lock.json` | 8 |
| `anvil-app/raycast/anvil/package-lock.json` | 7 |
| `anvil-cloud/pnpm-lock.yaml` | 2 |
| `anvil-registry/pnpm-lock.yaml` | 0 |

## Findings

### 1. High — Release-relevant dependency backlog

The desktop package deliberately overrides several dependencies to vulnerable versions in `anvil-app/package.json`, including `brace-expansion@5` 5.0.6, `js-yaml` 4.2.0, `postcss` 8.5.14, and `shell-quote` 1.8.4.

Production-only local audits reported:

| Workspace | High | Moderate | Low |
| --- | ---: | ---: | ---: |
| Anvil App | 11 | 9 | 2 |
| Anvil Website | 9 | 6 | 0 |
| Anvil Registry | 0 | 0 | 0 |

Highest-priority packages:

- Electron 39.8.5 has three high, ten medium, and two low alerts. Electron is classified as a development dependency but is the shipped desktop runtime. Version 39.8.10 is the smallest same-major version covering all currently reported Electron alerts.
- The website uses vulnerable Next.js 15.5.18 and `js-yaml` 4.2.0. Next.js 15.5.21 and `js-yaml` 4.3.1 address the reported direct advisories.
- Mermaid 11.15.0 renders repository, agent, and user-controlled diagrams. Upgrade to 11.16.1.
- DOMPurify 3.4.11 should move to 3.4.13.
- Website PostCSS must reach at least 8.5.23; current overrides force 8.5.15.
- Website Sharp must reach at least 0.35.0.
- React Router requires 7.18.x for the complete current advisory set, which needs an explicit major-version migration rather than an automated blind bump.

### 2. High — Do not merge Dependabot PR #60 as-is

[PR #60](https://github.com/anthonyhumphreys/anvil-stack/pull/60) is green and mergeable, but it changes React Router from 6.30.4 to 7.0.0.

Auditing its head increased the app result from 11 high vulnerabilities to 20 high vulnerabilities because React Router 7.0.0 is affected by numerous additional advisories. Green build/test checks did not catch this security regression.

The PR improves the website from 9 high/6 moderate to 4 high/1 moderate, but still leaves Sharp, PostCSS, and Nano ID findings.

Recommended approach:

- Split the updates by workspace and dependency family.
- Patch DOMPurify independently.
- Upgrade React Router directly to the current patched 7.18.x line with migration testing.
- Patch Next.js and `js-yaml`, then explicitly resolve Sharp, PostCSS, and Nano ID.
- Update Electron independently to 39.8.10.
- Regenerate each workspace’s lockfile with its own configured pnpm version.

PR #59 covers more packages, but its Cloud CI currently fails because its pnpm overrides and lockfile configuration disagree.

### 3. High — `main` and release tags are unprotected

The GitHub API reports no branch protection and no repository rulesets.

This matters because tag and main pushes can create or publish:

- Desktop release assets with `contents: write`.
- Registry images with `packages: write`.
- Node Base images.
- npm packages using OIDC trusted publishing.

Recommended controls:

- Require pull requests for `main`.
- Require the path-relevant CI and CodeQL checks.
- Require conversation resolution and prevent force pushes/deletion.
- Apply the rules to administrators where practical.
- Protect `app-v*`, `cloud-cli-v*`, `registry-cli-v*`, `cli-v*`, `registry-v*`, and `node-base-v*`.
- Put release jobs behind protected GitHub environments with approval where they publish user-consumed artifacts.

### 4. Medium/High — Mutable Actions in privileged workflows

Repository Actions are permitted from any source, and SHA pinning is not required. Workflows use mutable tags such as `actions/checkout@v4`, `actions/setup-node@v7`, and `docker/build-push-action@v7`.

The exposure is more important in:

- The app release workflow, which has `contents: write`, can receive Apple notarization secrets, and runs dependency lifecycle scripts.
- Registry image workflows with `packages: write`.
- npm workflows with `id-token: write`.
- The Cloud npm workflow, which installs `npm@latest` and runs an unrestricted pnpm install before publishing.

Recommended controls:

- Pin every third-party action to a reviewed full commit SHA.
- Enable repository action SHA-pinning enforcement.
- Pin the npm CLI used for trusted publishing.
- Use `--ignore-scripts` in privileged jobs unless scripts are demonstrably required.
- Where scripts are required, build/test in a read-only job and pass reviewed artifacts into the protected publishing job.

### 5. CodeQL critical SSRF is probably a false positive

[CodeQL alert #15](https://github.com/anthonyhumphreys/anvil-stack/security/code-scanning/15) identifies the local client proxy’s `fetch(target)`.

Source review shows:

- The request URL is parsed against localhost.
- Only normalized paths beginning `/_anvil/` or `/api/` reach the proxy.
- The target origin comes from the server-created `runtimeUrl`.
- Attacker input contributes the path and query, not the host.

That prevents protocol-relative and arbitrary-origin URLs from reaching the fetch call through the reported flow.

Recommended resolution:

- Add focused tests for `//host`, encoded separators, traversal, and absolute URL-shaped paths.
- Optionally construct the target by assigning only `pathname` and `search` onto `new URL(runtimeUrl)` so CodeQL can recognize the boundary.
- Dismiss the current alert only with that recorded justification.

Most other open CodeQL findings appear lower priority:

- HTML “sanitization” findings feed React text or prompts rather than an HTML execution sink.
- Several ReDoS findings operate on configuration, fixed strings, or bounded headers.
- The stack-trace finding is in the local LLM mock.
- Mermaid label escaping deserves defense-in-depth hardening, but rendered SVG passes through DOMPurify.

Each alert should still be individually resolved or dismissed so genuine future findings are visible.

## Positive controls

- Private vulnerability reporting is enabled and documented in `SECURITY.md`.
- Secret scanning and push protection are enabled, with no open secret alerts.
- Dependabot security updates and automated fixes are active.
- Default workflow token permissions are read-only.
- CI workflows generally declare narrow permissions.
- The Electron main window enables sandboxing and context isolation and disables Node integration.
- Anvil Registry’s production dependency audit is clean.

## Recommended execution order

1. Block PR #60 from merging as currently written.
2. Patch Electron to 39.8.10.
3. Land a focused website security update: Next.js, `js-yaml`, PostCSS, Sharp, and Nano ID.
4. Upgrade Mermaid and DOMPurify.
5. Perform the React Router 7.18.x migration separately.
6. Clear vulnerable dependency overrides and update transitive Expo/Metro dependencies.
7. Add `main` and release-tag rules.
8. Pin Actions and harden publishing jobs.
9. Triage and close the existing CodeQL backlog.
10. Once the baseline is clean, add high-severity production audits to each workspace’s CI.

## Verification performed

- Refreshed `origin/main` and created a detached worktree.
- Queried Dependabot, CodeQL, secret scanning, advisory, repository-security, Actions, branch-protection, ruleset, and environment APIs.
- Ran `pnpm audit --prod --json` in all four workspaces.
- Audited the head of PR #60 separately.
- Inspected security-sensitive source and release workflow paths.
- Confirmed both review worktrees remained unchanged; the temporary PR worktree was removed.

No test suite was run because this was a read-only review. No alerts were dismissed and no repository or GitHub settings were changed.

## Scope limits

This was a dashboard-led dependency, CodeQL, configuration, and focused source review—not a penetration test. It did not dynamically test deployed services, inspect production secrets, scan published container layers, or re-verify the earlier mobile-companion transport assessment.
