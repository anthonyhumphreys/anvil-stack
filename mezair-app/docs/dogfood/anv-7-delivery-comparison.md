# ANV-7 delivery comparison

Status: measurement protocol prepared; no baseline or connected-journey dogfood results recorded.

Use matched delivery tasks with comparable acceptance criteria, fixture size and risk. Keep the candidate commit, application build, machine, runner environment and scenario version with each record. Save the exported Change Review evidence pack alongside the record. Do not compare a trivial baseline task with a larger connected task.

| Record                                                      | Baseline journey | Connected journey |
| ----------------------------------------------------------- | ---------------- | ----------------- |
| Work item and task scope                                    | Not recorded     | Not recorded      |
| Candidate commit and application build                      | Not recorded     | Not recorded      |
| Scenario and fixture versions                               | Not recorded     | Not recorded      |
| Journey start and first usable evidence timestamps          | Not recorded     | Not recorded      |
| Full-journey active human minutes, measured separately      | Not recorded     | Not recorded      |
| Foreground review interaction estimate from evidence export | Not recorded     | Not recorded      |
| First recorded comparison evidence from review creation     | Not recorded     | Not recorded      |
| Scenario runs and additional replays                        | Not recorded     | Not recorded      |
| Repeated review work, with reason and duration              | Not recorded     | Not recorded      |
| Interruptions requiring human action, with timestamps       | Not recorded     | Not recorded      |
| Attributable input/output tokens and provider cost          | Not recorded     | Not recorded      |
| Escaped regressions and observation window                  | Unknown          | Unknown           |
| Evidence export and reviewer                                | Not recorded     | Not recorded      |

## Collection rules

- Start the journey clock at the same event for both tasks. The built-in export starts at Change Review creation, so it cannot measure earlier implementation time.
- Record full-journey active human time separately, pausing for unattended execution and breaks. The built-in metric estimates only foreground interaction inside the Change Review panel. Trusted pointer, keyboard or scroll input starts observation; five-second heartbeats count adjacent intervals until 30 seconds without input. Leaving the view, hiding the window or losing focus pauses observation. Gaps longer than 15 seconds, including sleep or restart, add no time. Reading without input and work elsewhere are excluded. This estimate is not total human effort. Sessions retain the local OS username and server timestamps in the review JSON; exports include the aggregate. Reviews without observations retain an unknown value.
- Log each interruption when a person must stop other work to act. Workflow event counts and notifications do not establish interruption counts.
- Explain replays and repeated review work. A replay after an intentional code change is not automatically wasted effort.
- Use provider usage tied to the relevant run or thread. Do not allocate account totals or unrelated conversations to the task. Preserve unknown cost when pricing or attribution is missing.
- Distinguish recorded capture availability from usable evidence verified by the reviewer. Check that images and traces open and match the candidate, criteria and scenario before recording the usable-evidence milestone.
- Record post-merge regressions after a stated observation period, including severity and evidence. A passed pre-merge scenario cannot establish zero regressions.

## Decision record

After both runs, report the absolute measurements and differences with task-scope caveats. State whether human effort fell and whether quality held over the observation window. Leave the conclusion pending while either measurement or regression follow-up is missing.

Current conclusion: pending real runs. Existing records can derive review run counts, decision counts, recorded repair handoffs and elapsed time to paired capture records. New review sessions also persist a foreground interaction estimate. Full-journey active human time, interruptions, journey-attributable usage and escaped regressions still require separate evidence. No baseline or connected-journey measurements have been recorded.

## Local first-use activation records

The desktop app records a separate local-only activation stream in `activation_events`. It records onboarding steps, composer availability, blocked-chat displays, rendered change summaries, committed changes, confirmed PR openings and completed repository-index tiers. A summary observation means a completed turn summary was rendered in the transcript; it does not prove a person read it or that a new change was generated. The app-run ID identifies one Electron main-process lifetime. The journey ID starts at first-run onboarding and carries across app restarts until the first successful kept-change commit. It is not a person ID. Older rows without either ID remain visible as an unscoped count and do not enter journey timing denominators.

Run `pnpm activation:report` inside `mezair-app` to inspect the local database. Use `pnpm activation:report -- --json` to print a JSON summary or `pnpm activation:report -- --out /path/to/activation-report.json` to create a new JSON export. The command opens SQLite read-only and runs under Electron's Node runtime so it uses the same native SQLite ABI as the app. For a development profile, pass `--db /path/to/profile/mezair.db` or set `MEZAIR_DEV_USER_DATA_PATH`.

Pair two comparable tasks explicitly with `pnpm activation:report -- --compare <left-journey-id> <right-journey-id>`. The delta is right minus left. Use the existing task table above to retain the work item, commit, build, scenario and acceptance criteria beside each pair. The report has no task label or treatment assignment, so this selection is manual and does not establish causation.

The report calculates wall-clock elapsed time from `onboarding_started` to the first enabled composer, rendered change summary and successfully committed change. The summary-view event uses a hash of the thread and turn IDs to deduplicate saved-history remounts; the raw IDs are not stored in activation payloads. Historical `diff_proposed` rows came from the same summary-mount behavior and have no stable identity, so they are counted separately as untrusted legacy events and excluded from timing. Actual new-change generation is not instrumented. If a journey spans app restarts, elapsed time includes time while Mezair was closed. The report therefore labels interruption and active time as unknown. It marks onboarding complete only after the workspace completion event, which is written after a workspace exists. An incomplete journey means no completion event was observed; it may be drop-off, an interruption or missing capture. A PR is counted only from a `pull_request_opened` event returned with a real PR URL. A commit made through the PR flow remains a kept change if provider delivery does not create a PR.

Repository-index observations include the queue's reported duration and file count. Current queue timestamps have one-second precision, so treat short durations as approximate. Model use, active human time, interruption count and output quality are not recorded by this stream. Do not use the app's Sentry consent setting as a proxy for this local measurement; activation records remain on the device and this report does not transmit them.

No real baseline or connected-journey results have been collected. The report's counts and medians are descriptive only, and a synthetic fixture used to check the report is not dogfood evidence.
