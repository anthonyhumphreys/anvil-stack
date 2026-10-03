# Cloud agent environments (ENV-01…ENV-09)

Status: contract, backend, all four provider adapters, the managed
tier, and the `anvil-worker` image build landed on
`feature/sync-mesh--foundations`. AWS Lambda MicroVM, Cloudflare
Sandbox, Vercel Sandbox, and `anvil-managed` all provision behind the
same contract; the reference Cloudflare provisioner lives at
`cloud/provisioner/` and doubles as the managed tier's runtime.

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
   opaque bootstrap channel (`runHookPayload` on AWS; the provisioner
   request body on Cloudflare; `ANVIL_BOOTSTRAP_JSON` on Vercel):

   ```json
   {
     "kind": "anvil.mesh-environment",
     "schemaVersion": "0.1",
     "environmentId": "env_…",
     "provider": "vercel-sandbox",
     "backendUrl": "https://sync.anvil.example",
     "pairing": "anvil-pair-…",
     "ttlSeconds": 1800,
     "networkPolicy": ["api.github.com"]
   }
   ```

   `provider` feeds `ANVIL_ENVIRONMENT_PROVIDER` so the worker's
   self-report and `provision:<provider>` capability line up with the
   record the provisioner created.

2. The image's run hook (`boot.mjs`, wrapped by `anvil-worker-boot`)
   parses the payload, scrubs `ANVIL_BOOTSTRAP_JSON` from its own
   environment, writes `ANVIL_ENVIRONMENT_ID` /
   `ANVIL_ENVIRONMENT_PROVIDER` for the daemon, redeems
   `anvil-daemon enroll --api-url $backendUrl --pair $pairing`, and runs
   `anvil-daemon run --worker` with the companion server disabled. The
   pairing code is consume-once so the payload is spent within seconds of
   enrollment.

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

Environments are requested and reaped headlessly the same way:

```sh
anvil-daemon env request anvil-managed --ttl 1800 --name ci-runner
anvil-daemon env request vercel-sandbox --ttl 3600 --connection <id>
anvil-daemon env list
anvil-daemon env terminate <environmentId>
```

`env request` mints the environment id, stages the source-side pairing
payload via `environment.bootstrap` for `anvil-managed`, and creates the
`provision-environment` job. `env terminate` records durable reap intent
— teardown lands wherever the provider lives.

A connection makes the host advertise `provision:<provider>` and become
eligible for `provision-environment` jobs via `kind:'auto'` placement.

`anvil-managed` needs no connection — the backend holds the provider
identity and claims the job itself.

Each adapter's `config`/`secret` surface:

- `aws-lambda-microvm` — config: `region`, `imageIdentifier`,
  `idlePolicy`, `logGroup`, subnets/security groups; secret:
  `{accessKeyId, secretAccessKey, sessionToken?}`. Provisions via the
  Lambda MicroVM API; bootstrap rides `runHookPayload`.
- `cloudflare-sandbox` — config: `url` (required, the deployed
  provisioner Worker); secret: `{token?}` sent as a bearer token. Calls
  a customer-deployed provisioner Worker over `POST/GET/DELETE
  /v1/environments[/:ref]`; the bootstrap payload rides in the create
  request body. The reference provisioner is `cloud/provisioner/`.
- `vercel-sandbox` — config: `image` (default image ref), `region?`,
  `teamId`, `projectId`; secret: `{token}`. Creates non-persistent
  `Sandbox`es via `@vercel/sandbox`; bootstrap rides
  `ANVIL_BOOTSTRAP_JSON` and the boot script is launched detached.

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

## Managed tier (ENV-09)

`anvil-managed` uses the identical contract; the provisioner identity is
Anvil-operated Cloudflare infrastructure. The backend owns the whole
lifecycle — no device-side provider connection is involved:

1. The source device calls `requestCloudEnvironment({ provider:
   'anvil-managed' })`, which mints an ephemeral pairing (code + sealed
   ADK, bound to the environment id) and stages it through
   `environment.bootstrap` — a consume-once, TTL'd channel keyed by
   `environment_id`. The backend never holds the sealed ADK; it only
   brokers the opaque payload.
2. `job.create { kind:'provision-environment', provider:'anvil-managed' }`
   is gated at the authoritative handler: the `MANAGED_PROVISIONER`
   service binding must exist (fail closed), hosted entitlement access
   must hold, `ttlSeconds` is clamped to the tier cap, and active
   managed environments + queued/running managed jobs must fit the
   concurrency cap. Idempotent replay returns the existing job before
   any cap check.
3. The account DO's managed claimer (kicked on create and on every
   sweep) claims the job internally, consumes the bootstrap payload,
   calls the provisioner service binding, records the environment
   handle, and journals lifecycle onto the job observers already watch.
4. The provisioner — the same `cloud/provisioner/` Worker a BYO
   customer deploys, bound via `MANAGED_PROVISIONER` — boots the
   environment. The env self-reports `enrolled` and joins the mesh.

Caps land through `hosted/enforcement.ts`:

| Tier | Cap |
| --- | --- |
| Free | hard `maxTtlSeconds` 30 min, concurrency 1, monthly minute quota |
| Paid | `maxTtlSeconds` 8 h, concurrency 4, Stripe metering |
| BYO provider | no Anvil cap — provider limits + `ttlSeconds` govern |

`null`/`active`/`grace` entitlements get paid caps; everything else gets
free caps. The reap sweep terminates managed environments through the
provisioner binding and expires staged bootstrap payloads that were
never consumed.

## The anvil-worker image

`cloud/images/anvil-worker/` builds the OCI image every provider boots:

- `Dockerfile` — generic `node:22-bookworm-slim` image: build
  prerequisites for `better-sqlite3`/`node-pty`, Git, the bundled
  daemon, `boot.mjs` + `anvil-worker-boot` on PATH. Used for Vercel VCR
  and generic OCI/AWS microVM environments.
- `Dockerfile.cloudflare` — same image plus the Cloudflare Sandbox
  container contract (the boot binary at the path the provisioner
  execs).
- `prepare.sh` — stages the daemon bundle + node_modules into the
  build context.
- `boot.mjs` — reads `ANVIL_BOOTSTRAP_JSON` (or a provider-delivered
  payload file), validates `kind:'anvil.mesh-environment'`, exports
  `ANVIL_ENVIRONMENT_ID`/`ANVIL_ENVIRONMENT_PROVIDER`, scrubs the
  bootstrap var, enrolls, and execs `anvil-daemon run --worker`.

The image intentionally disables the companion server — an ephemeral
environment exists to run jobs, not to serve UI.
