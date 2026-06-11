# AGENTS.md

## Project

This repo implements two related security tools for the Node/npm ecosystem:

- **Anvil Registry:** a TypeScript npm registry gateway that proxies package metadata and tarballs, caches artefacts, analyses package risk, and enforces deterministic dependency policy before installs reach developers or CI.
- **Anvil Node Base:** a hardened Node devcontainer base image that makes dependency installation safer with non-root defaults, `ignore-scripts`, lifecycle-script detection, observed install mode, and local install security reports.

The source specifications are:

- `docs/anvil-registry-spec.md`
- `docs/anvil-node-base-spec.md`

Treat those docs as product intent. If implementation details conflict with the docs, prefer the docs unless the code proves the docs are stale. If the docs are vague, make the smallest reasonable choice and state the assumption.

This repo is the first public version of Anvil and should be treated as a rough alpha release. Do not describe the project as mature, production-hardened, or complete unless the code and docs genuinely support that claim. Alpha does not mean sloppy; it means be explicit about what is working, what is still sharp, and what should be piloted before broad rollout.

## Goal-Driven Working Style

The user does **not** want milestone theatre. Do not stop after carving the work into phases unless explicitly asked for planning only.

Default behaviour:

- Start from the user's goal.
- Read the relevant docs and current code.
- Identify the next useful slice that moves the goal forward.
- Implement it.
- Validate it.
- Report what is done, what is still blocked or unbuilt, and the next concrete task.

Keep grinding until the goal is genuinely advanced or you hit a real blocker. A "real blocker" is missing information, missing credentials, an unavailable service, a failing external dependency, or a user decision that cannot be safely guessed. "This is a bit large" is not a blocker. That is just software being software.

When a task spans many pieces, maintain a working checklist internally or in the response, but do not frame it as a product roadmap unless asked. Prefer "next useful step" over "Phase N".

## Core Product Rules

### Anvil Registry

- It must act as a drop-in npm registry proxy.
- It must support metadata and tarball proxying for scoped and unscoped packages.
- It must rewrite tarball URLs so package traffic stays inside the proxy.
- It must cache package metadata, tarballs, analysis reports, and policy decisions.
- It must provide clear developer-facing block/quarantine explanations.
- It must support local Docker Compose and AWS deployment via SST.

### Anvil Node Base

- It is a local safety harness, not a replacement for Anvil Registry.
- It must run as a non-root user by default.
- It must default npm toward safer installs.
- It must provide safe mode with `npm ci --ignore-scripts`.
- It must provide observed mode for packages that require lifecycle scripts.
- It must write install/security reports under `.anvil/reports` or the configured report directory.

## Architecture Rules

- Use TypeScript for application and package code.
- Use Node.js 22 LTS.
- Use pnpm workspaces.
- Use Turborepo.
- Keep `gateway`, `worker`, `admin`, and `cli` as separate apps.
- Prefer small, testable packages under `packages/`.
- Keep provider-specific infrastructure behind adapters or interfaces.
- Do not add unnecessary dependencies.
- Use Fastify for the gateway.
- Use Zod for validation.
- Use Pino for logging.
- Use Vitest for tests.
- Use Postgres with Drizzle for persistence.
- Use MinIO/S3 behind an object-store abstraction.
- Use BullMQ locally and SQS on AWS behind a queue abstraction.
- Use Docker Compose for local deployment.
- Use SST for AWS deployment.
- Keep the standalone public docs site in sibling repo `../anvil-website` aligned with product behaviour.

Recommended package boundaries from the spec:

- `packages/config`
- `packages/logger`
- `packages/shared`
- `packages/npm-registry`
- `packages/policy-engine`
- `packages/package-analysis`
- `packages/name-squatting`
- `packages/llm-risk-review`
- `packages/persistence`
- `packages/object-store`
- `packages/queue`

## Security And Policy Rules

- The deterministic policy engine is the enforcement authority.
- LLM review may explain, summarise, or add structured risk context, but must never be the sole reason a package is allowed.
- Do not introduce LLM review in the MVP; stub the interface only if needed.
- Do not send private package source to an LLM unless explicitly enabled.
- Validate all LLM-shaped output with Zod when LLM review eventually exists.
- Fail closed where it matters, especially CI and production modes.
- Development mode may warn or quarantine depending on config.
- Cache analysis and policy decisions by immutable identity: package name, version, tarball integrity/hash, analysis engine version, and policy version.
- Never execute dependency install scripts unless explicitly approved.
- Do not implement auth until explicitly asked.
- The admin MVP may use an environment admin token when requested by the docs or task, but do not build full auth early.
- Approved overrides must be explicit, audited, reasoned, and preferably expiring.

## Documentation Rules

The repository documentation surface includes:

- `README.md` for top-level orientation, alpha status, setup, local stack, CLI, policy, smokes, Node Base, and deployment.
- `CONTRIBUTING.md` for contributor workflow and review expectations.
- `SECURITY.md` for vulnerability reporting and security design expectations.
- `docs/README.md` for the documentation map.
- `docs/anvil-registry-spec.md` and `docs/anvil-node-base-spec.md` as product intent.
- `../anvil-website/content/docs/registry/*.md` and `../anvil-website/content/docs/node-base/*.md` for public operator/user docs.
- `apps/cli/README.md` and `devcontainer-base/README.md` for component-specific command references.

When behaviour changes, update the relevant docs in the same task. Keep docs extensive enough for alpha users to run the stack, configure clients, understand policy decisions, use the CLI, use Node Base, review reports, seed caches, troubleshoot failures, and understand known limitations.

Documentation must be operational and concrete: commands, endpoints, environment variables, policy decisions, report names, failure modes, and validation steps. Avoid vague launch copy, unsupported security guarantees, and the sort of "enterprise-ready" language that tends to arrive wearing a borrowed blazer.

## npm Registry Behaviour

Test route handling against real npm-compatible patterns where possible. Scoped package paths are quirky because apparently one level of package naming pain was not enough.

Gateway routes from the spec include:

- `GET /-/health`
- `GET /-/ready`
- `GET /:packageName`
- `GET /@:scope/:packageName`
- `GET /:packageName/-/:tarballName`
- `GET /@:scope/:packageName/-/:tarballName`
- `POST /-/anvil/explain`
- `POST /-/anvil/override`
- `GET /-/anvil/policy`

When metadata is requested:

- Fetch or use cached upstream metadata.
- Run cheap metadata policy checks.
- Check cached version decisions.
- Filter blocked versions.
- Hide quarantined versions when policy mode requires it.
- Rewrite `dist-tags` to the newest allowed version.
- Rewrite tarball URLs through Anvil.

When tarballs are requested:

- Resolve package and version.
- Check policy decision cache.
- Serve cached allowed tarballs where possible.
- Fetch, cache, and stream allowed tarballs.
- Enqueue analysis for unknown or suspicious packages.
- Return useful JSON for blocked or quarantined packages.

## Analysis Rules

Worker analysis should happen outside the install request path.

Static analysis should be deterministic and should compare the target package version against the previous three versions by default. It should detect:

- New or changed lifecycle scripts.
- Manifest changes.
- Dependency changes.
- Dependency additions in patch versions.
- Repository, license, maintainer, `bin`, and `files` changes where available.
- Suspicious install-path code patterns.
- Obfuscation, encoded blobs, unexpected binaries, executable files, hidden files, unusual paths, and credential-looking files.

Name-squatting analysis should combine similarity with adoption signals. Low downloads alone can warn; low downloads plus strong similarity should block according to policy.

## Devcontainer Rules

For `devcontainer-base` work:

- Base on a Node 22 devcontainer-compatible image unless there is a specific reason not to.
- Install only the tools needed by the spec.
- Keep `tcpdump` and `tshark` optional because they may require extra container capabilities.
- Provide:
  - `anvil-npm-ci-safe`
  - `anvil-npm-ci-observed`
  - `anvil-dep-report`
  - `anvil-scan-lifecycle-scripts`
  - `anvil-scan-install-logs`
  - `anvil-network-monitor`
- Default to `ignore-scripts=true`.
- Make observed mode an explicit opt-in.

## Validation

After each change, run the most relevant checks available:

- `pnpm install`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `docker compose config`

Do not run dependency install scripts unless explicitly approved.

If a command is not available yet, add a sensible script when that is part of the current task. Otherwise explain why it is not applicable. Validation should match the blast radius of the change; do not pretend a docs edit needs a full production deployment rehearsal.

## Output Expectations

For each task, report:

- What changed.
- Files added or edited.
- Commands run.
- Test/build status.
- Known gaps or blockers.
- Suggested next concrete task.

Keep the report concise and grounded. Do not invent completeness. If only the next slice is done, say that. If something is still a stub, call it a stub.

## Review Priorities

When reviewing code, start with:

- Correctness.
- Security.
- Auth and access control, when auth exists.
- Data integrity.
- Accessibility for UI work.
- Production risk.

Then cover:

- Maintainability.
- Readability.
- Performance.
- Developer experience.

Prefer concrete fixes over decorative commentary. Suspicious abstractions should justify their existence or be escorted out politely.
