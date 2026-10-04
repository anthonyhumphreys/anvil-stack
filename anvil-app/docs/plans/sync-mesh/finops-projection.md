# Anvil FinOps projection

Prepared 4 October 2026. Forecast: 4 October 2026 to 30 September 2027. Product boundary: free Sync and Mesh; future paid Anvil Cloud Agents. PR91's Cloud Agents flag remains off.

## Decision

Free Sync and Mesh look financially manageable at modest adoption. The current model forecasts **$449/month of Cloudflare usage at 1,000 DAU**, plus **£60/month outside Cloudflare**. The model assumes **USD 10,000 startup credit, expiring 18 September 2027**. At a flat 1,000 DAU, expiry arrives before the balance is consumed. At 10,000 DAU, the current design burns it in approximately two months.

For the base growth path from 100 to 1,000 DAU, forecast Cloudflare credit usage is **$2,827**, leaving **$7,173 to expire**. External cash spend over the forecast is **£706**, including the modelled post-expiry September charges. Before credit, external service costs are **£2,826**. Including allocated operations, support and initial measurement work brings the total to **£18,242**. Founder time is a real cost even when it creates no incremental cash invoice.

At 10,000 DAU, the event-driven target saves roughly **$2,067/month** against the current increment.
The earlier transport-only hybrid saves another **$337/month before tunnels** under the same retained
storage assumptions. These comparisons remain useful baselines, but do not price the more extensive
[host-local implementation plan](host-local-sync-mesh-implementation-plan.md). That plan also moves
detailed history off the coordinator and compacts Sync, while preserving required hosted recovery.
It supersedes the earlier recommendation to limit work to polling and transport improvements.

The new plan illustrates a **$5/month broker and compact Sync subtotal at 1,000 DAU**, or about
**$38 at 10,000 DAU**. These exclude durable Mesh history, leases, additional trust refreshes,
recovery artifacts and tunnel fees. They are not comparable full-service totals. Core Cloudflare
targets are below $50 at 1,000 DAU and $250 at 10,000 DAU. Any tunnel supplier fee is additional
Anvil-side operating cost, not a paid Sync/Mesh feature. Measurement must establish whether these
targets preserve the current functionality, then include tunnels in the full-service total. The workbook
still contains only the four earlier scenarios. Add a fifth measured case before using the new
architecture for a credit burn-down or operational commitment.

## Deliverables and how to use the model

- [Editable financial workbook](outputs/finops-2026-10/anvil-finops-projection.xlsx).
- [Model inputs](finops-assumptions.json) and [reproducible calculation model](finops-model.mjs). Run `node anvil-app/docs/plans/sync-mesh/finops-model.mjs` from the repository root for the forecast inputs and results.
- [Product and implementation plan](mesh-access-and-monetisation-plan.md).

In the workbook, change the architecture selector in Assumptions, the monthly **DAU** row, the DAU/MAU ratio, connected hours, storage occupancy, credit balance or expiry. One forecast recalculates the results. Cloud Agents launch month is **0**, meaning disabled. Set it to 7 to explore the explicitly illustrative April 2027 launch. This changes the model only.

The report's scenario tables are calculated at the published assumptions as of this date. They do not update when the workbook changes. The workbook has one active forecast and no hidden parallel case models. Currency conversion uses **1 USD = 0.75 GBP**, an editable planning rate rather than a live FX quote. Taxes, FX settlement charges and actual invoice adjustments are excluded. The credit is an expense offset, not revenue or cash.

## Credit terms and expiry

You confirmed this is startup credit and supplied the expiry date. The model assumes a remaining **USD 10,000** balance today. Cloudflare's public startup terms describe a one-year validity period, R2 coverage capped at USD 10,000, and exclusions including Registrar and AI Gateway. The grant's account-specific terms take precedence. [Cloudflare startup programme](https://www.cloudflare.com/startups/).

Workers, account coordination, D1 and R2 charges are modelled as eligible. Observability, the shared Workers minimum and future Containers charges are also assumed eligible for arithmetic; confirm those items on your grant or first detailed invoice before relying on the paid-execution scenario. No account balance or invoice was retrieved. Confirm other applications sharing the credit account and enter their burn in Other Cloudflare USD/month, currently zero.

Expiry is modelled conservatively at **00:00 UTC on 18 September 2027**. September includes 17 credit-eligible days and 13 cash-funded days. The model prorates that month's eligible dollar usage by days; actual grant application can depend on billing-period and invoice rules. If September's invoice receives no credit, the base external cash estimate rises from £706 to £897. Confirm the time and invoice treatment. Credits already spent are never restored by expiry, and unused credit becomes zero after expiry.

To consume the grant evenly over the approximately 349 eligible days from today, average eligible burn would be about **$860 per 30 days**. Under the current mix and retention assumptions, roughly **1,838 sustained DAU** would use the full credit by expiry. This is a budget threshold, not a growth target. Productive experiments and measured load tests may be useful uses of excess credit; spending simply to exhaust it has no financial benefit.

## DAU, MAU and retained accounts

DAU means the average number of accounts active on a day. It does not mean concurrent devices. Default DAU/MAU is **25%**, so 1,000 DAU corresponds to 4,000 MAU. Five retained registered accounts per MAU gives 20,000 accounts retaining some hosted data. These are **accounts, not devices**. The fivefold factor assumes one monthly active account plus four dormant historical accounts retaining data, representing a conservative installed-base scenario from the first forecast month. It is not measured signup history, a device multiplier or a required storage allocation. Set it to 1 for an illustrative cohort with no dormant accounts, then replace it with actual retained stock. Applying the same average bytes to dormant accounts is conservative; artifact expiry may reduce their R2 occupancy.

Requests scale with active connected device-hours. Account awake time scales with connected account-hours, so three devices on one account do not create three account objects. Identity/support/website costs scale with MAU. Stored state scales with retained accounts. Closing retained stock never shrinks automatically when activity falls; removal requires an explicit deletion/retention policy. The model charges closing occupancy for the whole month, conservatively assuming new accounts arrive early.

| Active-day profile | Share of DAU | Connected hours/day | Devices online together | Device-hours/day |
| --- | ---: | ---: | ---: | ---: |
| Light | 60% | 0.4 | 1 | 0.4 |
| Regular | 25% | 2 | 2 | 4 |
| Heavy | 15% | 8 | 3 | 24 |

The weighted request load is **0.2017 heavy account equivalents per DAU**, and the account-hours weight is **0.2425**. “Connected” includes background traffic while Anvil stays open. Eight hours of human work followed by sixteen hours of background connectivity needs a higher setting. Occasional users are represented by DAU/MAU, rather than assuming every signup works every day. The light/regular profiles use proportional heavy-view traffic as a planning proxy; telemetry should replace that proxy.

## What the code actually stores and calls

Sync replicates portable workspace definitions, workflow templates, custom agents, selected settings and necessary key/control records. Repository files, credentials, machine-specific paths and chat transcripts are outside portable workspace Sync. Each destination clones through its own repository access. Mesh also stores job state, approvals, event metadata, result/artifact manifests and bounded encrypted payloads. Users' machine compute and provider token charges are paid by those users.

| Component | Current behaviour | Cost consequence and evidence |
| --- | --- | --- |
| Hosted Worker authentication | Each ordinary RPC validates a bearer, then calls its owning backend object | At least two backend-object calls per usual RPC; [Worker routing](../../../cloud/backend/src/index.ts), lines 71-134 |
| SessionCoordinator | One shared sessions object per deployed environment; indexed token lookup is read-only | Shared request/read cost and possible hot-object duration; [session validation](../../../cloud/backend/src/session-coordinator.ts), lines 1762-1790 |
| AccountCoordinator | Account-sharded SQLite journal, job state and hibernating socket support | Rows scanned/written, average retained bytes and awake time; [coordinator](../../../cloud/backend/src/account-coordinator.ts) |
| Healthy Sync fallback | Four calls per cycle: device roster, pull, recovery security view and dashboard requests | 60-second live fallback versus 5-second socket-down fallback; [Sync runtime](../../../src/main/services/sync-runtime.service.ts), lines 3292-3334 |
| Renderer resources | Shared 15-second roster and 5-second active-job fallback | Initial reduction is implemented; complete event invalidation remains future work; [shared poller](../../../src/renderer/utils/shared-polling-cache.ts) |
| Main-process remote chat | 2-second loop fetches active job state | About 432,000 HTTP calls per chat at 8h/day over 30 days; [remote chat](../../../src/main/services/remote-chat.service.ts), lines 1481-1485 |
| Mesh workers | 30-second lease tick and per-active-attempt job checks | Cost scales with active attempts; [Mesh worker](../../../src/main/services/mesh-worker.service.ts), lines 718-747 |
| Browser workspace grants | Approved unexpired grants claim commands every 1.5 seconds | About 576,000 extra calls/grant at 8h/day; no grant means the timer performs local work without claim traffic; [dashboard grants](../../../src/main/services/dashboard-grant.service.ts) |
| D1 | Hosted identity/admission, account/org operations and entitlement snapshots | D1 is not consulted on every ordinary RPC; [hosted enforcement](../../../cloud/backend/src/hosted/enforcement.ts) |
| R2 | Mesh and shared artifacts | Sync journal and scan pages primarily live in SQLite, not R2; [artifact handling](../../../cloud/backend/src/account-coordinator.ts) |

Current history/receipt/job-event sweep retention is 90 days. Intermediate job activity is bounded to 1 MiB per job. Mesh artifacts are at most 64 MiB each with default 7-day and maximum 30-day retention. Hosted aggregate artifact/history byte limits are **unset**, with operator fair use rather than an automatic fixed account byte ceiling. Shared artifacts are a separate system: 16 MiB/object, 256 MiB/account, default 30-day and maximum 365-day expiry. [Hosted policy](../../../cloud/backend/src/hosted/policy.ts), [account limits and sweep](../../../cloud/backend/src/account-coordinator.ts), [shared artifacts](../../../cloud/backend/src/session-coordinator.ts).

This means the forecast is not a guaranteed maximum bill. The 21 MB SQLite, 100 MB R2 and 2 MB D1 per retained account are occupancy assumptions. The SQLite allowance includes 20 MB account state plus a 1 MB allocation for shared session records. R2 covers artifacts rather than repository backup. No automatic deletion of existing user data is proposed by this report.

## Provider rates

One Workers Paid operator account is assumed for production and staging. Allowances are deducted **once from aggregated usage**, not once per user or environment. D1 and SQLite-object storage have separate product meters. Existing services sharing the account consume the same relevant product allowances.

| Meter | Monthly included usage | Excess USD rate |
| --- | --- | --- |
| Workers | $5 shared minimum, 10m requests, 30m CPU ms | $0.30/m requests, $0.02/m CPU ms |
| Backend objects | 1m requests, 400,000 GB-seconds | $0.15/m requests, $12.50/m GB-seconds |
| Object SQLite | 25bn reads, 50m writes, 5 GB-month | $0.001/m reads, $1/m writes, $0.20/GB-month |
| D1 | 25bn reads, 50m writes, 5 GB-month | $0.001/m reads, $1/m writes, $0.75/GB-month |
| R2 Standard | 10 GB-month, 1m class A, 10m class B | $0.015/GB-month, $4.50/m A, $0.36/m B |

Sources checked 4 October: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [backend objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/).

The model rounds excess object requests and duration to million-unit billing increments, and R2 operations/storage to their billing increments. A small duration excess can therefore add $12.50. SQLite/D1 rows remain proportional in the estimate. Incoming WebSocket messages use the 20:1 object-request billing factor; outgoing frames do not add request charges. Worker CPU uses an assumed 5 ms per HTTP invocation. [Object billing examples](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Logs are budgeted at 10% sampling, two 1 KB events per sampled HTTP call and seven-day retention. This is a proposed budget assumption; current Wrangler files do not establish that logging configuration. Through November, 20m events are included and excess costs $0.60/m. From 1 December 2026, the published model is 50 GB ingestion plus 12 GB-month storage included, then $0.25/GB and $0.10/GB-month. The forecast changes rates in December. [Current Workers logs](https://developers.cloudflare.com/workers/platform/pricing/), [announced Observability pricing](https://developers.cloudflare.com/observability/pricing/).

WorkOS AuthKit includes the first million active users. Enterprise SSO starts at $125/connection/month and a custom domain is $99/month. Both are zero in the baseline. Usage above one million MAU requires a separately verified identity price. Free org membership does not imply paid enterprise SSO or org-shared fleet functionality. [WorkOS pricing](https://workos.com/pricing).

Website budget assumes one $20/month Vercel Pro developer seat, plus an explicitly estimated $0.01/MAU usage reserve. The reserve is not a quoted per-user Vercel fee. Another $20/month covers domains, monitoring/email/CI or similar shared tools as a placeholder. Replace these with actual invoices. Vercel's published Hobby terms are personal/non-commercial. [Vercel pricing](https://vercel.com/pricing).

## Architecture coefficients and status

| Heavy account, 8h/day and three devices over 30 days | Original PR91 | Current polling increment | Event-driven target | Hybrid target |
| --- | ---: | ---: | ---: | ---: |
| Worker HTTP calls | 3,500,000 | 1,500,000 | 300,000 | 301,000 |
| Billable backend-object calls | 7,200,000 | 3,200,000 | 650,000 | 610,000 |
| SQLite read rows | 35,000,000 | 15,000,000 | 3,000,000 | 3,000,000 |
| SQLite write rows | 200,000 | 200,000 | 200,000 | 200,000 |
| Account awake share of connected hours | 10% | 10% | 10% | 1% |

The original and current coefficients budget the known UI/runtime pollers, an active remote-chat loop, leases and other traffic. The first plan's roughly 1m current HTTP budget omitted the surviving main-process chat poller, while its backend-object budget undercounted session validation. This projection adds those costs. It also has more complete retained-account and shared-service accounting, so its totals supersede the earlier plan's subtotal for budgeting.

These are budgets, not benchmarks. Reads/writes, CPU, retries and awake fraction need measurement. A quiet single device can be much cheaper than a heavy account with open views. The event and hybrid columns are future targets requiring further implementation. They have not been demonstrated by the renderer change. The common HTTP path sets a roughly 2:1 object-call floor. Extra mutation preflight, internal calls and incoming socket frames consume the small additional request budget; high-rate streams need a larger coefficient.

The model adds 10% production-like usage and storage for staging, plus two shared session objects assumed hot throughout the period. Hot sessions reflect sustained request arrivals, not socket connections on those objects. Sparse deployments may spend less. Account-object duration is shared per account; the 128 MB billing example allocation is independent of execution-container memory.

## Monthly costs at different adoption levels

The steady-state tables use 30 days, the mixed active-day profile, retained accounts equal to 20 times DAU, no paid execution and December-or-later log pricing. Cash invoices before grant application and economic costs are shown separately.

| DAU | MAU | Current CF/month USD | External spend GBP before credit | Allocated recurring total GBP | CF cash while fully covered |
| --- | --- | --- | --- | --- | --- |
| 100 | 400 | $49 | £70 | £870 | $0 |
| 1,000 | 4,000 | $449 | £397 | £1,917 | $0 |
| 10,000 | 40,000 | $4,926 | £4,024 | £12,744 | $0 |

At 1,000 DAU, total assumed external service spend is £397/month. While eligible credit covers the CF bill, cash spend is £60/month. Operator/incident allocation is £720/month and free-user support is £800/month at the default 4,000 MAU, giving £1,917 recurring economic cost. This excludes core product development, acquisition/marketing, company overhead and a Cloud Agents launch project.

### Detailed monthly allocation at 1,000 DAU

| Cost bucket at 1,000 DAU | USD/month | GBP/month | Credit treatment assumed |
| --- | --- | --- | --- |
| Workers minimum, HTTP and CPU | $135 | £101 | CF credit eligible |
| Backend-object requests | $106 | £80 | CF credit eligible |
| Backend-object awake duration | $50 | £38 | CF credit eligible |
| SQLite rows and storage | $91 | £69 | CF credit eligible |
| R2 operations and storage | $33 | £25 | CF credit eligible |
| D1 activity and storage | $29 | £22 | CF credit eligible |
| Logs | $4 | £3 | CF credit eligible |
| Website fixed fee and usage reserve | $60 | £45 | Cash outside CF |
| Other tools reserve | $20 | £15 | Cash outside CF |

The model uses 332.8m Worker requests, 709.9m backend-object requests, 3.33bn SQLite reads and 44.4m writes. Retained stock is 20,000 accounts, 462 GB SQLite, 2,200 GB R2 and 44 GB D1. The bytes are conservative allocations, not observed stored data. Provisioning an additional device does not immediately allocate 100 MB of R2.

### Comparable Cloudflare bills

| DAU | Original PR91 CF USD | Current increment CF USD | Event target CF USD | Hybrid CF USD before tunnels |
| --- | --- | --- | --- | --- |
| 100 | $80 | $49 | $31 | $31 |
| 1,000 | $784 | $449 | $253 | $214 |
| 10,000 | $8,318 | $4,926 | $2,859 | $2,522 |

Original PR91 is a reconstructed request budget, not a measured historical invoice. The current increment uses the changed polling cadences plus the remaining main-process chat loop; its SQL, CPU and duration budgets still require measurement. Event and hybrid columns are prospective targets.

The costs retain free hosted Sync, job acceptance, offline queues, lease fencing, approvals, cancellation and result recovery in every column. There is no paid gate on the user's own fleet or provider integrations. Tunnel costs are omitted only from the explicitly labelled hybrid subtotal; they remain an unknown input rather than a free-infrastructure claim.

## USD 10,000 credit burn-down

### Flat DAU

| Flat DAU | MAU at 25% ratio | CF/month USD, current | Credit-funded months if no expiry | Credit used before expiry USD | Unused credit expires USD | Exhaustion or expiry |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 40 | $19 | 533.9 | $216 | $9,784 | Expiry with credit unused |
| 100 | 400 | $49 | 203.6 | $570 | $9,430 | Expiry with credit unused |
| 1,000 | 4,000 | $449 | 22.3 | $5,229 | $4,771 | Expiry with credit unused |
| 2,500 | 10,000 | $1,184 | 8.4 | $10,000 | $0 | 2027-06-11 |
| 5,000 | 20,000 | $2,435 | 4.1 | $10,000 | $0 | 2027-02-01 |
| 10,000 | 40,000 | $4,926 | 2.0 | $10,000 | $0 | 2026-11-30 |
| 25,000 | 100,000 | $12,518 | 0.8 | $10,000 | $0 | 2026-10-26 |
| 100,000 | 400,000 | $50,463 | 0.2 | $10,000 | $0 | 2026-10-09 |

“Credit-funded months if no expiry” is a simple $10,000/monthly-cost ratio. It is not real runway beyond 18 September 2027. Dates are approximate straight-line consumption within each forecast period and can vary with invoice timing, traffic patterns and billing increments. Usage-based credit coverage is assumed. At 100,000 DAU the current singleton session path also needs a throughput test; a cheap calculated bill does not establish capacity.

### Effect of further architecture changes

| Flat DAU | Current credit exhaustion | Event target exhaustion | Hybrid exhaustion before tunnels |
| --- | --- | --- | --- |
| 1,000 | Expiry with credit unused | Expiry with credit unused | Expiry with credit unused |
| 2,500 | 2027-06-11 | Expiry with credit unused | Expiry with credit unused |
| 5,000 | 2027-02-01 | 2027-05-04 | 2027-06-04 |
| 10,000 | 2026-11-30 | 2027-01-15 | 2027-01-30 |

At the same DAU, the event target retains more credit and delays cash spend. A hybrid before tunnels can extend it further, but the difference is small against its engineering and operating effort. A charged tunnel product could consume credit or cash at a different rate and reverse that result.

### Base growth path

| Month | Average DAU | CF usage USD | Credit used USD | Credit balance USD | Outside-CF and post-credit cash GBP |
| --- | --- | --- | --- | --- | --- |
| Oct 2026 | 100 | $48 | $48 | $9,952 | £33 |
| Nov 2026 | 150 | $69 | $69 | $9,884 | £35 |
| Dec 2026 | 220 | $98 | $98 | $9,785 | £37 |
| Jan 2027 | 300 | $143 | $143 | $9,642 | £39 |
| Feb 2027 | 400 | $174 | $174 | $9,468 | £42 |
| Mar 2027 | 500 | $224 | $224 | $9,244 | £45 |
| Apr 2027 | 600 | $273 | $273 | $8,971 | £48 |
| May 2027 | 700 | $318 | $318 | $8,653 | £51 |
| Jun 2027 | 800 | $353 | $353 | $8,300 | £54 |
| Jul 2027 | 900 | $415 | $415 | $7,885 | £57 |
| Aug 2027 | 1,000 | $457 | $457 | $7,427 | £60 |
| Sept 2027 | 1,000 | $449 | $254 | $0 | £206 |

The September closing balance is zero because unused credit expires. Immediately before expiry, approximately $7,173 remains unused in this path. By 1 September, it has $7,427 remaining. $254 is used during the assumed eligible September portion, and the rest expires. September's external cash line includes the modelled post-expiry Cloudflare share and outside-CF services.

### Growth and cash budget

| Growth assumption | DAU at Sep-27 | CF credit consumed USD | Unused credit expired USD | External cost before credit GBP | External cash after credit GBP | Cost incl. allocated time GBP |
| --- | --- | --- | --- | --- | --- | --- |
| base | 1,000 | $2,827 | $7,173 | £2,826 | £706 | £18,242 |
| slow | 300 | $1,009 | $8,991 | £1,232 | £475 | £13,160 |
| fast | 10,000 | $10,000 | $0 | £19,918 | £12,418 | £69,198 |

Slow growth ends at 300 DAU, base at 1,000 and fast at 10,000. They are planning scenarios, not adoption predictions. Fast growth starts at 100 DAU and reaches 5,500 in May. Its credit exhaustion estimate is **2027-06-25**. Protect cash for the post-credit bill rather than planning around leftover credit in the base case.

For base growth, hold approximately **£3,533** as a full-price external-services budget with 25% contingency, even though forecast grant-adjusted cash is much lower. Credit cannot be renewed by assumption. If labour is paid externally, add the paid share of £15,416. No runway for the entire company is claimed because salaries, starting company cash, other liabilities and collections are unknown.

## Savings and alternate architecture

### 1. Complete event-driven polling reduction

Keep the hosted trust and job coordinator. Push roster/job/approval invalidations, consolidate refreshes across renderer and main process, stop completed/hidden-view polling where valid, and catch up after reconnect. Preserve bounded fallback, lease renewal, cancellation and revocation. The existing shared renderer cache is a useful first step; the 2-second remote-chat job loop and conditional 1.5-second grant loop are separate costs.

| Change | CF saving USD/month at 1k DAU | CF saving USD/month at 10k DAU | Engineering estimate GBP | Payback after credits at 1k / 10k DAU |
| --- | --- | --- | --- | --- |
| Current increment to event target | $196 | $2,067 | £2,400 (40h) | 16.3 months / 1.5 months |
| Event target to hybrid, tunnels excluded | $39 | $337 | £9,600 (160h) | 330.2 months / 38.0 months |

Engineering figures are rough opportunity-cost estimates, not commitments or supplier quotes. Payback is measured after credit at full provider prices. During a period where credits would otherwise expire unused, reducing CF consumption creates little immediate cash saving. At 1,000 DAU, measure first and combine these changes with product reliability work. At 10,000 DAU, event-driven work becomes financially compelling.

### 2. Private machine routes first

Send live output and approved workspace operations through an authenticated LAN/private route where available. Continue to persist accepted jobs, ownership, approvals and required results centrally. This avoids managed tunnel allocation for those connections and can improve latency. Users pay any personal private-network/VPS costs. A private route alone does not remove Sync catch-up, job leases or backend identity operations.

The current default-off endpoint prototype wakes coordinator-owned commands. It does not yet move all live traffic or prove the hybrid's 1% awake target. Count savings only after equal-workload measurement. Browser clients outside a private network still need a reachable HTTPS endpoint or existing fallback.

### 3. Connection broker plus machine endpoints

Separate connection admission and discovery from live host operations. The broker links devices,
authorises proof-bound bootstrap and manages endpoint allocation. Clients then use the host endpoint.
The execution host must be online for live work; durable hosted recovery serves its separate purpose.

Apply that split to Anvil while keeping hosted account coordination for cross-machine jobs and handoff. Application payload encryption, local execution authority, revocation, replay protection, generation-fenced tunnel allocation, cleanup and compatible fallback still need to work across every route. A public tunnel is a proxied network path; it is not a direct peer-to-peer connection.

Do not buy one tunnel for every viewer or every registered device. Allocate only exposed execution hosts, reclaim offline allocations safely, and support user-owned endpoints. The baseline allocates one host per MAU for sensitivity, giving 4,000 hosts at 1,000 DAU. Default published Cloudflare account limits are **1,000 tunnels** and **1,000 combined private routes**, with increases requiring an account discussion. Thousands of customer hostnames also need DNS/certificate capacity and product terms checked. [Cloudflare account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/).

No verified commercial per-host price for this Anvil deployment has been obtained. Under the default model, the hybrid saves **$39 monthly at 1,000 DAU** over the event target. Divided across 4,000 allocated hosts, break-even is just **$0.0097/host/month**. A hypothetical $0.10/host/month costs $400 at that adoption and erases the saving. Zero, $0.10 and $1 are sensitivities, not provider quotes. If ordinary tunnels are available without a separate usage charge under the agreed service terms, the remaining costs are broker calls, allocation operations, support and engineering.

These break-even figures apply only to the earlier transport-only hybrid. The new host-local plan
changes storage and coordination as well, and needs a separate complete cost case. Retain private
routes and compatible fallback; measure their use before assuming every user needs an allocated tunnel.

### 4. Retention and payload size

Profile materialised state versus journal history, job events, receipts, share objects and active Mesh artifacts separately. Keep required current entity state and authoritative job results. Use compaction/snapshot recovery for long-offline replicas before shortening historical journals. Do not delete active workspace definitions or checkpoints needed for recovery just to lower storage spend.

An illustrative occupancy change from 21 MB to 11 MB SQLite and from 100 MB to 25 MB R2 per retained account saves **$69/month at 1,000 DAU** and **$688/month at 10,000 DAU**. That is a sensitivity, not evidence that these bytes are currently wasted. An inactive account's retained storage remains billable, so MAU alone cannot predict it. Reducing the retained-account factor from five to one, holding all other assumptions fixed, lowers the current 1,000-DAU Cloudflare estimate from $449 to about $322/month. Make free hosted fair-use/storage policy explicit before offering unbounded retention.

### 5. Control retries, logs and write amplification

Use bounded backoff and jitter when sockets fail, distinguish a socket outage from a total network outage, coalesce status messages and avoid repeated writes of unchanged state. Auth SELECTs do not create write rows. Measure rows touched including indexes, deletes and alarm rescheduling rather than counting application mutations. Sample successful high-volume logs, retain errors/security events appropriately and avoid exporting identical datasets to multiple paid vendors.

For example, each always-connected idle device produces about 172,800 HTTP calls/month under 60-second fallback. A broken socket with successful 5-second HTTP fallback produces about 2,073,600 before reconnect work: twelve times as many. Reducing the retry cadence safely is cheaper to implement than replacing the whole coordinator.

### 6. Website on Cloudflare

Moving the Next.js website/account surface onto a compatible Cloudflare deployment could use the existing credit account and avoid the assumed $20 Vercel fixed fee. Static caching can reduce dynamic invocations. Estimate 16 engineering hours (£960) before inspecting compatibility, giving roughly 64 months' payback on the £15/month fixed fee alone. Real measured website overages could improve that case. The model's website reserve is a buffer and should not all be claimed as migration savings. No website migration is implemented here.

### 7. Fully peered or user-hosted coordination

A user-hosted coordinator shifts backend cost to the user and fits open-source Anvil. Pure peers can store their own Sync replicas and artifacts. Removing hosted coordination entirely changes all-machines-offline access, unattended queue acceptance, mobile/browser discovery and recovery. Preserving those functions requires an always-available peer or another server. There is no justified “same functionality for zero infrastructure” claim. Retain this as an optional deployment path rather than replacing hosted free service solely to save money.

## Sensitivities and failure cases

| One-factor sensitivity | CF USD/month at 1k DAU | External GBP/month at 1k DAU | CF USD/month at 10k DAU |
| --- | --- | --- | --- |
| Default mix and assumptions | $449 | £397 | $4,926 |
| Every DAU heavy: 8h/day, 3 devices | $1,752 | £1,374 | $18,199 |
| Account awake throughout online hours | $774 | £640 | $8,251 |
| Three times HTTP and backend requests | $964 | £783 | $10,148 |
| Ten times SQLite write rows | $843 | £692 | $8,919 |
| 100% logs sampled at 5 KB/event | $1,340 | £1,065 | $13,839 |
| Ten times retained SQLite and R2 bytes | $1,577 | £1,243 | $16,212 |
| USD costs 10% more GBP | $449 | £436 | $4,926 |

These change one factor at a time and are not a simultaneous worst case. A true socket outage adds known fallback/reconnect traffic to the active workload; the three-times row is only a generic traffic stress, not the twelve-times idle-cycle calculation. Large cohorts with duplicate chats, grants, continuous output, bulk scans and larger retained artifacts can exceed it. No probability distribution is inferred without real usage.

At 1,000 DAU, baseline SQLite writes are near the included allowance. Ten times writes is expensive, whereas indexed reads often remain within the much larger read allowance. Logs can become material after the December pricing change if sampling/size assumptions are wrong. Setting awake fraction to 100% tests a known account-duration risk. At tenfold stored data the forecast changes significantly because inactive accounts retain state too.

Credit exhaustion does not impose an automatic service cost ceiling. The hosted aggregate byte limits are unset and no general HTTP request rate limit was identified. Socket/frame limits and individual artifact limits protect certain paths. Fair-use restrictions require their existing notice/emergency rules. Forecast alerts must therefore lead to operational action rather than assuming the bill stops by itself. A preview-date dependency remains in the hosted device-limit preflight and should be reviewed separately; this projection does not alter product code.

## Future Anvil Cloud Agents unit economics

The code currently uses Cloudflare **standard-1: 0.5 vCPU, 4 GiB RAM and 8 GB disk**. It is disabled for Anvil-operated execution. CPU is charged on active use, while RAM and disk are provisioned while running. Container allowances are deducted once after aggregating all buyers, alongside the existing Worker/object usage. European/North American container egress has a separate published meter. [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/), [provisioner configuration](../../../cloud/provisioner/wrangler.jsonc).

At 25% CPU utilisation, raw standard-1 cost is **$0.0470/running hour** before allowances. At 100%, it is $0.0740. Warm idle at zero CPU is still $0.0380/hour. Add 25% running overhead for starts, warm idle and retries, plus control traffic, logs and egress. The marginal planning cost becomes about **£0.0535/billed hour**. Unknown snapshot/image costs and launch engineering are additional, so this is not a launch-approved cost floor.

Normal hosted idle handling checkpoints after five minutes. If the checkpoint path fails, the sandbox's own six-hour timeout and current managed TTL/cleanup need to limit orphan cost. Legacy configuration has a 20-instance cap and one live managed environment per account with a 30-minute TTL. Larger paid workloads need verified scheduling/concurrency capacity and metering before launch. Filesystem snapshots do not preserve running processes. Their retention has no separate rate in the public price table reviewed here; obtain confirmation. [Checkpointing sandbox](../../../cloud/provisioner/src/checkpointing-sandbox.ts), [managed idle handling](../../../cloud/backend/src/account-coordinator.ts).

Illustrative buyer model: 20 billed hours/month, £0.50/hour, 3% of MAU buying. This gives £10 revenue per buyer. The average payment batch is £20: the fixed card fee is allocated across consumed usage rather than charged for every job. UK standard card pricing is 1.5% + £0.20. A 0.7% Stripe Billing reserve is included conservatively, plus 2% refund/fraud reserve and £0.25 allocated support per buyer. Other card mixes, disputes, taxes or currency conversion can cost more. [Stripe UK pricing](https://stripe.com/gb/pricing).

| Illustrative hourly price | Revenue/buyer at 20h | Marginal contribution/buyer | Buyers to fund 1k DAU external costs | MAU conversion to fund 1k DAU recurring total |
| --- | --- | --- | --- | --- |
| £0.25 | £5 | £3.42 | 116 | 14.0% |
| £0.50 | £10 | £8.16 | 49 | 5.9% |
| £1.00 | £20 | £17.64 | 23 | 2.7% |

These are illustrative price sensitivities, not Anvil offers. At £0.50/hour, marginal contribution is about **£8.16/buyer/month**. At 1,000 DAU/4,000 MAU, roughly 49 buyers cover the full-price external-service bill. Roughly 235 cover the recurring total including allocated free-service time. Small-cohort invoice rounding and shared allowances can differ from the gross marginal calculation.

If the modelled April 2027 launch occurred, base-path execution revenue would be **£6,000**, incremental provider costs **£581**, and contribution **£4,957** across April-September. This would reduce full-price allocated cost from £18,242 to £13,285, before launch engineering and unquoted storage. It would also consume more CF credit, approximately $3,534 total instead of $2,827. The feature remains off, so the committed revenue forecast is **£0**.

The optional launch needs about 25 peak legacy-shape containers at 1,000 DAU under a 6× peak factor, above the existing 20-instance legacy cap. A 3% conversion assumption does not prove capacity or market demand. Do not use this case as a promise that the current disabled provisioner can serve that volume.

The provider/tool cash-after-credit line covers provider and tool invoices only; payment fees, refunds and paid labour need separate cash planning if execution launches. Payment allocation in the workbook is economic, not a credit-wallet cash roll-forward. Unused prepaid credits are not earned revenue. A real paid launch needs separately reconciled top-ups, usage consumption, refunds, tax, deferred balances and settlement timing. User-owned OpenRouter/LLMGateway/Foundry and other provider charges remain outside Anvil revenue and COGS unless Anvil later sells inference.

## Measurement, attribution and budgets

Before relying on any forecast, collect a seven-day sample on the current code: one quiet account, one heavy three-device account, one chat/handoff workload and a deliberate socket-down-but-HTTP-working case. Include normal active hours and overnight app-open periods. Extrapolate each by connected hours and cohort counts. Do not extrapolate from a test with development spike authentication because that bypasses real session validation.

Attribute usage by environment, anonymised account, release/version, operation and feature class: identity, Sync, Mesh control, Mesh live, shared artifacts, future hosted execution and operator/admin. Record HTTP invocations/CPU, object calls, account/session GB-seconds, SQLite/D1 rows and bytes, R2 A/B and GB-days, log events/bytes, container active CPU/provisioned RAM/disk and egress. Use service meter totals as the financial control and operation traces for attribution. Do not log payloads or tokens for cost analysis.

Track daily spend, projected end-of-month gross bill, projected credit exhaustion date and valid-credit days remaining. Alert at 50%, 75% and 90% of the monthly forecast, and at remaining credit of $5,000, $2,500 and $1,000. Separately alert 90, 60 and 30 days before **18 September 2027**, even with a healthy balance. Trigger investigation if request cost per DAU doubles for three days, reconnect/fallback traffic exceeds its budget, cleanup lags, or storage growth exceeds occupancy assumptions. These are proposed alerts, not configured production controls.

At 1,000 DAU, set an initial gross CF budget around **$560/month** (25% over the current $449 estimate) and keep the outside-CF **£60/month** line visible. At 10,000 DAU, that gross CF envelope is about **$6,160/month**. Budgets are not service guarantees. Reforecast after measured changes, compare actual vs budget by meter, and keep p50/p95 account costs plus high-percentile byte/attempt/grant counts. Stop redundant polling, retries and orphaned paid execution before considering changes to free feature access.

## Verification and open inputs

The JavaScript calculation model and workbook were reconciled for all four architecture selections, the optional launch and a zero-DAU final month. The workbook was recalculated, scanned for formula errors and rendered for inspection. Excel-native interactive recalculation has not been exercised. The source pricing pages were checked on 4 October 2026. No production bill, usage export, tunnel quote or benchmark was available.

Open inputs that materially change the projection:

1. Actual startup balance, grant coverage for Containers/logs/fixed charges, other CF account workloads and the final invoice's expiry handling.
2. Measured DAU/MAU, connected-device hours, retained-account stock and actual average/p95 hosted bytes.
3. CPU, object awake time, socket/reconnect/grant traffic, write amplification and main-process polling volumes.
4. Existing website/tool invoices and actual paid operator/support time.
5. Tunnel price/limits, endpoint implementation effort and measured before/after duration.
6. Paid runtime snapshot pricing, capacity, metering, payment mix, launch cost, customer demand and an approved customer price.

Use credit to fund measurement and validation now. Preserve the free product boundary. Make further architecture spend conditional on measured unit costs and product benefits, and fund the post-18-September bill at full prices.
