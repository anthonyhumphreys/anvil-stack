# Evidence-backed review

## Recommendation

Build a change review workflow that connects the existing Work Item, code review, browser and evidence capabilities.

The first release should let a developer open a change, inspect its acceptance criteria, compare one configured journey against base and candidate, flag a defect, request a fix, rerun the journey and accept the resulting snapshot.

Ship this through small, reviewable changes on `feature/review--evidence-backed-acceptance`, based on main at `01cea7e`. The isolated worktree is `/Users/anthonyhumphreys/Code/anvil-worktrees/evidence-backed-acceptance`.

## What the source review confirms

The supplied review identifies real implementation gaps.

| Finding | Source |
|---|---|
| Security and code-review gates use the latest completed result without binding it to the reviewed revision. Missing results in linked repositories can be skipped. | `anvil-app/src/main/services/gate-readiness.service.ts:24` |
| ADR readiness can pass on a repository summary; compliance readiness can pass on a repository record. | `anvil-app/src/main/services/gate-readiness.service.ts:100` |
| PR visualisation accepts model-supplied verification counts and verified status. | `anvil-app/src/main/services/pull-request-visualisation.service.ts:154` and `:219` |
| Browser annotations live in component state and are forwarded into chat. | `anvil-app/src/renderer/components/browser/BrowserPanel.tsx:69` and `:278` |
| The browser bridge handler exposes automation routes with wildcard CORS and no authentication check. | `anvil-app/src/main/services/browser.service.ts:127` |
| Chat evidence records provider events and identifies likely test commands with pattern matching. This does not establish independent runner observation or snapshot validity. | `anvil-app/src/main/services/chat-evidence.service.ts` |

These are source findings. The browser issue has not been tested as an exploit. Competitor claims and website positioning were not independently reviewed.

## Work Items own acceptance criteria

Do not introduce a separate acceptance-criteria editor with its own competing source of truth.

The existing `WorkItem` already includes `acceptanceCriteria`, provider and URL. Lifecycle items already link to a Work Item. Reuse these relationships.

There are gaps to address:

- `WorkItemProviderService` supports list, get, create and connection testing. It has no update or review-publication contract.
- ADO maps its acceptance-criteria field. Current Linear and Jira mappings do not populate it.
- The Work Item cache uses bare item IDs. Review references need to distinguish provider connections and their organisation or project scope.
- Existing reads can return cached data. Accepting a review needs an explicit freshness check.

Implement the following behaviour:

1. Open Review directly from a Work Item, carrying its connection, provider, item identity and URL. Branch and PR entry points can attach the same reference.
2. Read criteria through the provider abstraction. Use ADO's existing field, a configured Jira field or an explicit description section, and an explicit description section for Linear. Preserve rich-text meaning.
3. Treat ambiguous extraction as a proposal for the reviewer to confirm. Do not let a model invent authoritative criteria.
4. Store the exact imported text, source location, fetch time and provider revision where available. Otherwise use a content digest.
5. Give mapped criteria stable local identities within a versioned criteria set. Preserve historical versions.
6. Refresh before acceptance. Changed criteria require reconciliation; do not silently carry old decisions forward. Offline review remains usable, with freshness shown as unknown.
7. Show the same criteria and evidence status in Work Item detail and Review.
8. Add capability-aware provider operations for publishing a review summary and proposing criteria updates. Users deliberately publish; retries must avoid duplicate comments, and concurrent edits must not be overwritten.
9. Keep task completion separate from accepting a candidate. Passing checks must not automatically close the Work Item.

Local reviews without a provider remain useful. Their criteria are explicitly local and can later be mapped to a linked Work Item.

## Shared review record

Keep this model small and independent of chat sessions.

| Record | Purpose |
|---|---|
| Change | Workspace, repositories, base/candidate identities, optional PR and Work Item references |
| Source snapshot | Commit identity plus the actual reviewed content, including dirty changes and relevant untracked inputs |
| Criteria version | Exact provider or local expectations reviewed, with source references |
| Verification run | Snapshot, scenario/configuration, runner, environment, fixture and build identity, timestamps and results |
| Artifact | Capture, trace or output with content digest and run association |
| Review finding | Scenario, capture, locator or fallback coordinates, requested correction and resolution history |
| Decision | Reviewer, candidate snapshot, criteria version, evidence references and acceptance or rejection |

Keep provenance, outcome and freshness separate.

- Provenance describes agent-reported, runner-observed or human-recorded evidence.
- Outcome describes passed, failed, not run or inconclusive.
- Freshness describes whether it applies to the current candidate and criteria.
- Human acceptance is an explicit decision, not a stronger form of test success.

A historical passing result stays historically passed when a new patch makes it stale.

Snapshot capture must define tracked, untracked, ignored, submodule and external inputs. Unknown inputs must be visible. Run against a frozen candidate where possible; source mutation during a run makes its binding inconclusive.

## Delivery sequence

### 1. Correct existing trust claims

Start with fixes that can ship independently.

- Require suitable evidence for every repository required by a gate.
- Check actual ADR and compliance artifacts, using existing discovery services where possible.
- Make application code determine verified status and counts.
- Handle existing cached visualisations so old model-generated claims cannot remain verified.
- Preserve legacy results as historical evidence with unknown binding.
- Add authenticated browser sessions, origin restrictions and workspace/target binding.
- Update `scripts/chrome-mcp-server.mjs` alongside the bridge. Rotate credentials, restrict discovery-file access and reject stale sessions.
- Bind each request to its authorised target before asynchronous work, so switching targets cannot redirect an in-flight command.

Completion evidence: regression tests cover missing repository results, nonexistent documents, fabricated verification claims, unauthenticated requests and cross-target access.

### 2. Add snapshot-bound evidence and Work Item criteria

- Add the shared records through incremental SQLite migrations.
- Extend shared types, services, IPC and preload together.
- Scope Work Item references and cache access by connection.
- Implement criteria mapping and refresh for the existing providers.
- Bind newly produced code-review and security results to source snapshots.
- Make readiness consume the same validity rules as Review.
- Keep provider-reported command events useful without promoting them to runner-observed test receipts.

Completion evidence: a dirty edit invalidates current evidence; changing provider criteria invalidates acceptance; identical item IDs in different connections stay separate; historical records remain readable.

### 3. Complete one visual review journey

Use one explicitly configured web repository, two isolated worktrees, one seeded journey and desktop/mobile viewports.

- Reuse existing browser and PR review components in one change-focused workspace.
- Run Playwright scenarios against base and candidate with separately reset backing state.
- Record build identity, scenario version, fixtures, browser and viewport.
- Show side-by-side captures, actions, assertions and unexercised conditions.
- Persist annotations with capture, scenario and source references.
- Route a fix request into an existing coding workflow with the linked Work Item criteria and reproduction context.
- Move agent-reported fixes to `ready_for_recheck`.
- Attach a fresh replay before human acceptance.
- Preserve previous decisions and explain what the next candidate invalidated.

An arbitrary localhost preview remains inspectable, but cannot establish revision-bound verification without build identity.

Completion evidence: seed a mobile defect, flag it, fix it, rerun and accept the new snapshot. A subsequent edit must make that acceptance visibly stale. The journey must also work for code produced outside Anvil chat.

### 4. Finish provider publication and portable evidence

- Publish an explicitly selected review summary through the linked Work Item provider.
- Include criterion outcomes, candidate identity and unresolved findings.
- Export Markdown and JSON evidence packs with a redaction preview.
- Keep local paths and private artifacts out of public links.
- Show failed publication separately from a saved local acceptance decision.

Completion evidence: provider tests cover supported operations, missing capabilities, concurrent edits, offline failures and retry deduplication.

## Next increment

After the complete journey works, add mechanically grounded detection of changed checks.

Start with added skips, removed test cases, changed snapshot baselines, reduced discovery and disabled lint rules. Link every finding to a diff. More complex claims about assertion strength or broader mocks need language-aware analysis and explicit uncertainty.

Changed expectations require a decision; legitimate test changes are not automatic failures.

Defer broad behavioural inference, combined-agent candidates, automatic scenario discovery, extra providers and website repositioning. They should build on a proven review workflow.

## Verification and release decision

Run focused service, migration, parser, provider and bridge tests during implementation, followed by the existing `pnpm test` suite. Run lint and build for the completed desktop change. Exercise the visual journey in Electron with controlled fixture data.

Test the failure paths as carefully as the successful demo:

- Interrupted runs and missing artifacts.
- Source changes during execution.
- Unidentified served builds.
- Provider criteria changes while reviewing.
- Old evidence after migration.
- Agent claims of completion without a replay.

Compare review with and without the workflow using seeded defects. Measure setup time, active review time, missed defects and false alarms. Automated accessibility checks should report their scope; keyboard and visual judgement remain explicit review tasks.

The release is ready when a reviewer can trace a Work Item criterion to evidence for the exact candidate, resolve a visual finding and see precisely what remains unchecked.