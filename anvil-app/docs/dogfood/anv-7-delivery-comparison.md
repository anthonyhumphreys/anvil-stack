# ANV-7 delivery comparison

Status: measurement protocol prepared; no baseline or connected-journey dogfood results recorded.

Use matched delivery tasks with comparable acceptance criteria, fixture size and risk. Keep the candidate commit, application build, machine, runner environment and scenario version with each record. Save the exported Change Review evidence pack alongside the record. Do not compare a trivial baseline task with a larger connected task.

| Record | Baseline journey | Connected journey |
| --- | --- | --- |
| Work item and task scope | Not recorded | Not recorded |
| Candidate commit and application build | Not recorded | Not recorded |
| Scenario and fixture versions | Not recorded | Not recorded |
| Journey start and first usable evidence timestamps | Not recorded | Not recorded |
| Full-journey active human minutes, measured separately | Not recorded | Not recorded |
| Foreground review interaction estimate from evidence export | Not recorded | Not recorded |
| First recorded comparison evidence from review creation | Not recorded | Not recorded |
| Scenario runs and additional replays | Not recorded | Not recorded |
| Repeated review work, with reason and duration | Not recorded | Not recorded |
| Interruptions requiring human action, with timestamps | Not recorded | Not recorded |
| Attributable input/output tokens and provider cost | Not recorded | Not recorded |
| Escaped regressions and observation window | Unknown | Unknown |
| Evidence export and reviewer | Not recorded | Not recorded |

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
