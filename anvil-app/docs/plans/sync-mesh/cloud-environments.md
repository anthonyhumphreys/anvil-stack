# Cloud agent environments (ENV-01…ENV-09)

Status: contract + backend + provisioner plumbing landed on
`feature/sync-mesh--foundations`. AWS Lambda MicroVM provisioning is
implemented; Cloudflare Sandbox, Vercel Sandbox, and the Anvil-managed
tier land behind the same contracts next.

A cloud environment is a remote machine that runs Anvil work on the
account's behalf: an AWS microVM, a Cloudflare Sandbox, a Vercel Sandbox,
or an Anvil-operated Cloudflare environment (`anvil-managed`). It is not a
new execution model — an environment boots the **anvil-worker** image,
redeems an ephemeral-class pairing payload, and then claims jobs through
the exact same `worker.connect` → `job.claim` → fenced attempt → artifact
path a desktop or daemon worker uses. Observation and control from any
device are free: the mesh journal, durable events, approvals, and activity
frames already cover every claim.

## Architecture

```txt
source device (desktop app)
  │  mints environmentId + creates provision-environment job
  │  requestedTarget: { kind:'auto', requirements:{ capabilities:['provision:aws-lambda-microvm'] } }
  ▼
provisioner device (desktop or anvil-daemon holding provider credentials)
  │  claims the job → mints ephemeral pairing (code + sealed ADK,
  │  bound to environmentId) → provider.create(pairing, backendUrl, ttl)
  │  reports lifecycle via environment.report
  ▼
provider (AWS Lambda MicroVMs · Cloudflare Sandbox · Vercel Sandbox · Anvil-managed)
  │  boots anvil-worker image with the pairing payload
  ▼
environment (ephemeral enrollment)
  │  anvil-daemon enroll --pair → device.policy.publish → worker.connect
  │  environment.report { state:'enrolled', enrollmentId:<self> }
  │  claims environment-targeted + auto jobs; pulls credential grants
  │  per attempt; terminates on TTL or reap intent
```

Provider credentials never leave the provisioner device. The backend
stores an opaque provider `handle` (microVM id, sandbox id) and sealed
credential-grant envelopes — it can fence and broker but never open them.

## Contract surface (`cloud/contract/environment.ts`)

- `EnvironmentProviderId`: `aws-lambda-microvm`, `cloudflare-sandbox`,
  `vercel-sandbox`, `anvil-managed`.
- `EnvironmentState`: `provisioning` → `enrolled` → `running` →
  (`suspended`) → `terminating` → `terminated`; `reap-requested`,
  `expired`, and `failed` are cleanup/audit states. `expired` marks TTL
  elapsed without a verified teardown.
- `environment.report` (worker role): upserts lifecycle state. The
  provisioner reports create/terminate progress; the environment
  self-reports `enrolled` (self-link is authorized by the
  `environment_id` bound into its enrollment code).
- `environment.get` / `environment.list` / `environment.reap`: reads and
  durable cleanup intent. Reap intent survives the creator going
  offline — any provisioner-capable device holding the handle completes
  termination and reports `terminated` (`reaped: true` when verified).
- `provision-environment` job kind: claimed by workers advertising
  `provision:<provider>` capability. The manifest `inputs` carries
  `ProvisionEnvironmentInputs` (environmentId, provider, ttlSeconds,
  optional imageRef/networkPolicy/resources/connectionId/displayName).
- `credential.deliver` (user role) / `credential.pull` (worker role):
  per-attempt sealed credential grants (ENV-06), bound to
  (job, attempt, fence, target enrollment) and fenced against stale
  incarnations.

## Ephemeral enrollment (ENV-01)

`EnrollmentClass` distinguishes `device` from `ephemeral`. An ephemeral
session:

- redeems only an `ephemeral`-class enrollment code — the class is bound
  into the code at issuance and can never widen to a device session;
- has a bounded lifetime (`enrollment_expires_at`; issuance clamps
  `sessionTtlSeconds` to backend bounds);
- runs under a restricted operation allowlist (`EPHEMERAL_ALLOWED_OPERATIONS`
  in `contract/operations.ts`): worker/job-claim/attempt/event/artifact/
  approval-read/environment/credential-pull ops only — no `job.create`,
  no code issuance, no `device.*`/`account.*` administration;
- is pinned on the account object's `enrollments` row at first sight, so
  a dropped class header cannot downgrade it;
- may carry an `environment_id` binding (code issuance → session →
  forwarded `x-anvil-environment-id` → pinned on the enrollment row) —
  this is what lets the environment authorize its own `enrolled` report
  and prevents it from claiming other environments' records;
- has its own live-session quota separate from the device cap.

The pairing payload minted for an environment is an ordinary
`anvil-pair-…` string (enrollment code + sealed ADK delivery), produced
by `issueEnrollmentCode({ enrollmentClass:'ephemeral', provider,
sessionTtlSeconds, environmentId })`.

## The anvil-worker image contract

The environment's boot process is the only provider-specific surface —
and it is still a contract, not a per-provider fork:

1. The provisioner passes a JSON bootstrap payload through the provider's
   opaque bootstrap channel (`runHookPayload` on AWS; equivalent
   sandbox-start payloads on Cloudflare/Vercel):

   ```json
   {
     "kind": "anvil.mesh-environment",
     "schemaVersion": "0.1",
     "environmentId": "env_…",
     "backendUrl": "https://sync.anvil.example",
     "pairing": "anvil-pair-…",
     "ttlSeconds": 1800,
     "networkPolicy": ["api.github.com"]
   }
   ```

2. The image's run hook redeems it:
   `anvil-daemon enroll --api-url $backendUrl --pair $pairing --worker`,
   then `anvil-daemon run`. Equivalent flows are fine — the daemon
   commands are the reference implementation.

3. On boot the worker publishes `device.policy { worker.allowJobs: true }`
   and `worker.connect`, advertises the `ephemeral-env` capability plus
   any `grant:<name>` grant kinds it accepts, and reports
   `environment.report { state:'enrolled', enrollmentId:<self> }`.
   Queued `{ kind:'environment', environmentId }` jobs resolve onto the
   enrollment the moment the report lands (`job.available` fans out).

4. For each claimed attempt the worker calls
   `credential.pull { attemptId, fence }`, unseals each grant with its
   device key (`credentialGrantAssociatedData` AD), and injects the
   `env` vars into the provider spawn environment — in-memory only,
   discarded at attempt terminal. A new turn/fence means a new grant.

5. `ttlSeconds` is the hard cap: the provider enforces it
   (`maximumDurationInSeconds` on AWS), and the backend sweep converts
   elapsed TTL into `expired` + reap intent for provisioners to finish.
   Idle suspension/resume is provider-config (`idlePolicy` on AWS).

## Provider connections (provisioner side)

`cloud_provider_connections` (migration 84) stores, per (backend,
account): `provider`, `display_name`, `config_json` (non-secret — e.g.
AWS `region`, `imageIdentifier`, `idlePolicy` knobs, `logGroup`, network
connector ids), and `secret_blob` (safeStorage-encrypted credentials —
e.g. `{accessKeyId, secretAccessKey, sessionToken}`).

The daemon manages them headlessly:

```sh
anvil-daemon provider add aws-lambda-microvm \
  --name prod-aws \
  --config '{"region":"us-east-1","imageIdentifier":"<image-arn-or-id>"}' \
  --secret '{"accessKeyId":"…","secretAccessKey":"…"}'
anvil-daemon provider list
anvil-daemon provider remove <connectionId>
```

A connection makes the host advertise `provision:<provider>` and become
eligible for `provision-environment` jobs via `kind:'auto'` placement.

## Job targeting

`job.create` accepts `requestedTarget: { kind:'environment',
environmentId }`:

- missing record → `not-found`; reaped → `conflict`;
- already `enrolled` → resolves to the env's enrollment immediately;
- still `provisioning` → queues unresolved (`target_enrollment_id NULL`)
  until `environment.report { enrolled }` binds it — `queueDeadline`
  must therefore cover cold start + queue time.

`provision-environment` itself targets `kind:'auto'` with a
`provision:<provider>` requirement so any credentialed provisioner
claims it.

## Managed tier (ENV-09, next)

`anvil-managed` uses the identical contract; the provisioner identity is
Anvil-operated Cloudflare infrastructure. Caps land at the authoritative
handler through `hosted/enforcement.ts`:

| Tier | Cap |
| --- | --- |
| Free | hard `maxExecutionSeconds` (~30 min), concurrency 1, monthly minute quota |
| Paid | larger cap (~8 h), higher concurrency, Stripe metering |
| BYO provider | no Anvil cap — provider limits + `ttlSeconds` govern |
