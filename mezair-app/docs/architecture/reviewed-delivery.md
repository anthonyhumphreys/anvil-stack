# Reviewed delivery

The delivery controls keep reviewed code, verification evidence and repository
changes tied to exact revisions. They do not infer success from an agent report.

## Commit or open a pull request from chat

The turn's file list selects the scope. **Commit** and **Open PR** first show a
fresh Git diff of the current changes in those files. That diff can include
edits made since the turn ended; the dialog says so. The captured branch and
revision identify the source being reviewed. Unsupported or ambiguous file
scopes require a fresh review in the repository Git view.

Confirmation uses the captured candidate. If a selected file, its index entry,
HEAD or branch changes, review again. Unrelated staged files stay staged and
unrelated working files stay untouched. Normal Git hooks and configured commit
signing run in a temporary checkout. If hooks change the reviewed tree or
message, the action stops before advancing the source branch.

A pull request uses a dedicated `codex/turn-*` branch based on the pinned remote
base. Review shows its complete candidate diff. Mezair rejects changes that do
not apply to that base or escape the selected paths. It never pushes the user's
current branch through this action. If push or PR creation fails, the result
names the retained branch and explains what remains to do.

These controls complement the repository-wide Git commands, whose scope is the
whole repository. They do not turn provider edit logs into authoritative patches.

## Combine, verify and apply delegated code

Returned result refs are combined in retained integration checkouts. Before
running checks, the chat shows suggested and saved commands per repository.
Review or edit those suggestions. Commands still pass through the existing
permission and approval path, within the originating run's access ceiling.

**Combine without checks** records that checks did not run. Verification records
the actual command, outcome and tested commit/tree. A command that changes the
checkout invalidates its evidence. Retry runs only the saved verification
selection against the retained candidate; it does not rerun worker tasks or
merge result branches again.

Application is explicit and separate. Each verified repository can fast-forward
from its recorded base only while the mapped source checkout is clean and its
branch and HEAD match the preflight. Local changes or a moved source require
attention. Multi-repository application records each repository independently;
there is no cross-repository atomicity claim. Applying does not push or deploy.
Application holds Git's real index and ref/HEAD locks and saves its intended
branch, base and target before changing files. A retry can reconcile an exact
clean target after a crash; an ambiguous outcome remains visible for inspection.

## Review current tracked changes remotely

Plain chat delegation can select the committed source or a frozen current-tracked
candidate. The latter is limited to read-only remote tasks. Approval identifies
the included files and frozen source. The existing encrypted task-key transport
carries the candidate; ordinary job metadata contains no patch content.

Both the backend and destination worker must advertise support. Older deployments
remain usable for committed-source jobs. They cannot silently fall back to the
base commit for a current-tracked review. Approval freezes every selected
repository's base, including clean repositories, and the backend/account scope.
Submission and replay recheck that scope and backend support while preserving the
original sealed bytes. Candidate payloads are limited to
128 KiB in aggregate, with additional file and request bounds. Binary patches,
unrelated untracked files, secret paths and secret-bearing patch content are
rejected. Larger or unsupported work must stay local or use a committed source.

The worker verifies the source base, patch digest, candidate tree and commit
before starting the provider. Retries retain the approved bytes. Code-dependent
work should stay in one remote task: dependency edges still transfer reports,
not an upstream worker's code.

## Local measurements and verification

`pnpm activation:report` reads the local database without transmitting records.
It reports elapsed onboarding-to-composer, first change-summary view and first
kept-commit timings where scoped records exist. A rendered summary is not proof
of a newly generated change or of human reading. Human effort, interruptions,
usage and output quality require separate evidence. See the
[delivery comparison protocol](../dogfood/anv-7-delivery-comparison.md).

The standalone replay at `http://127.0.0.1:4179/?delivery` exercises production
components against explicitly synthetic responses. It verifies interaction and
layout, not Git mutation, provider delivery, device trust or a real cloud run.
Run the real-Git/service tests for those local boundaries and the hosted
acceptance runbook for physical-device evidence.

### Connected delivery fixture

The browser integration tests exercise real Chromium, Git worktrees and SQLite
with fixture Work Item, PR and acceptance inputs. They cover a failing mobile
scenario, finding, repair handoff, passing replay and persistence across database
reopens. They are skipped unless a Playwright installation is supplied.

From `mezair-app`, point to a directory containing `node_modules/playwright` and
its installed Chromium browser:

```sh
MEZAIR_REVIEW_PLAYWRIGHT_ROOT=/path/to/browser-fixture \
MEZAIR_REVIEW_QA_OUTPUT=/path/to/evidence-output \
pnpm exec vitest run --maxWorkers=2 \
  src/main/services/__tests__/change-review-runner.integration.test.ts \
  src/main/services/__tests__/change-review-delivery-journey.integration.test.ts
```

The connected fixture writes `connected-delivery-journey/evidence.json`, a
fixture database and browser artifacts. Review paths and local reviewer identity
before sharing those files. Fixture inputs do not establish live provider or
human acceptance.
