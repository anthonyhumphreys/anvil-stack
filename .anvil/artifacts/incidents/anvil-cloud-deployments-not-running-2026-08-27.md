# Anvil Cloud deployment incident escalation pack

Prepared: 2026-08-27 21:26 BST  
Record type: Incident  
Service: Anvil Cloud  
Status: Unverified, diagnosis pending  
Priority: Not assigned. Impact and urgency data are incomplete.

## Summary

The reporter states that Anvil Cloud deployments have not been running since last week and that rerunning was attempted.

No command output, error code, deployment identifier, provider, environment, or monitoring evidence was supplied. There is not yet enough evidence to determine whether deployments fail during build, review, provisioning, or runtime startup.

No resolution, ticket update, or escalation action is claimed.

## Classification

Incident, based on a reported unplanned loss of deployment capability.

This classification may change if:

- Cloudflare deployment was attempted. Cloudflare is plan-only at the normal CLI boundary, so blocked deployment is a documented alpha limitation.
- Only a new deployment or access approval is pending.
- The command completed successfully but an application handler or scheduled workload did not start.

## Impact and urgency

### User report

- Deployments are “not running.”
- The problem “started last week.”
- Rerunning was attempted.

### Missing impact information

Obtain before assigning priority:

1. Which Cell or application is affected?
2. Which adapter is in use: AWS, Cloudflare, or another target?
3. Which stage is affected: preview, development, or production?
4. Are all deployments affected or only one repository, branch, or Cell?
5. How many teams or users are blocked?
6. Are existing deployments still serving traffic?
7. Is there a working local or previously deployed version?
8. Is a release, customer commitment, or recovery deadline at risk?
9. Is there any suspected data loss, security exposure, or unintended infrastructure change?

### Urgency assessment

Urgency is not confirmed. “Deployments not running” could represent a broad release blocker, but scope and deadline evidence are absent.

Do not assign a severity from the current intake alone.

## Timeline

| Time | Entry | Evidence status |
|---|---|---|
| 2026-08-17 to 2026-08-23 | Possible onset window if “last week” means the previous calendar week in Europe/London. | Assumption only |
| Exact time unknown | Deployments stopped running. | User report |
| Exact time unknown | Reporter tried rerunning. Command and target were not supplied. | User report |
| Result unknown | No output or explicit result from the rerun was supplied. | Not established |
| 2026-08-27 21:26 BST | Escalation pack prepared from the intake and repository documentation. | Confirmed |

## Evidence

### Confirmed evidence

- The intake identifies Anvil Cloud as the affected service.
- The requested record type is incident.
- Anvil Cloud provides JSON-capable deploy, inspect, logs, and rollback commands.
- `anvil-cloud doctor --json` is the documented read-only preflight.
- AWS preview deployment can return stable provisioning error codes and failure details.
- Cloudflare deploy and remove operations are intentionally blocked at the normal CLI boundary.

There is no confirmed incident telemetry yet.

### User reports

- Deployments are not running.
- The issue began last week.
- Rerunning was attempted.

### Assumptions

- “Last week” may mean 2026-08-17 through 2026-08-23.
- The failed action may be an Anvil Cloud CLI deployment.
- The rerun may have failed to restore deployment capability.

None of these assumptions should be used as evidence.

### Hypotheses

These are routing possibilities, not findings:

- The build output is absent or stale.
- A Guardian error or approval gate blocks deployment.
- AWS preview provisioning is not configured.
- AWS CloudFormation failed or timed out.
- Provisioning succeeded but the remote runtime did not become healthy.
- The reporter attempted Cloudflare deployment, which the alpha CLI intentionally blocks.
- “Not running” refers to a service handler. Exact Cell service execution in the AWS Fargate preview path is documented as unfinished alpha work.

## Actions tried

| Action | Actor | Time | Result |
|---|---|---|---|
| Reran deployment | Reporter | Unknown | Not supplied |

Do not record the rerun as failed until its exit code or output is available.

## Safe next checks

These checks are read-only or generate local diagnostic output. Do not rerun deployment again until the failed phase is identified.

1. Preserve the most recent failed job or terminal output. Record:

   - exact command or CI job name;
   - timestamp and timezone;
   - exit code;
   - complete JSON error response;
   - Cell, stage, adapter, branch, and commit;
   - Anvil Cloud CLI version.

2. From the affected Cell project, run: