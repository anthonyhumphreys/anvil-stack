# Remote chats and worker providers

Remote chats use the same provider choices as Desktop: Codex, OpenAI, Azure,
Cursor, Devin and LLMGateway. There is no standalone Claude provider. Choose
provider and model in the normal chat header, choose the access mode, then
open **Run on another device**. Select an enrolled, trusted device with remote
work enabled and submit a prompt. Provisioned cloud workers appear as devices
after enrollment. Approve the destination identity in Settings before launching.
A fresh cloud worker receives the selected portable workspace definition through
the task envelope. It does not receive the account-wide sync key.

The source first prepares the destination's pinned workspace, then starts the
provider turn there. The destination caps the requested permissions using its
own maximum. A lower maximum applies even when the source asks for full access.
Provider-specific access restrictions still apply; unsupported modes fail
explicitly instead of being broadened.

The remote-chat panel shows turn state, activity, approval details and the
finished response. Approve or deny exact actions there, or stop the current
run. A follow-up runs on the same device and checkout using its verified native
provider session handle. Follow-ups are accepted after the current turn
completes; mid-turn steering and interactive provider questions are not implemented.
If a provider asks a question during a turn, the attempt fails explicitly so
you can respond in a new task. Assistant responses are
bounded to 32,000 characters and a 36,000-byte JSON string budget. Unicode or
escaped text can reach the byte limit first. Task prompts, credentials and results travel in
the existing encrypted task envelopes, not plaintext activity frames.

The controller stores each exact sealed job request before submission and
replays it after reconnecting. Its records are bound to the originating
backend and account. A lost network response does not justify creating a new
turn or silently restarting a conversation.

**Move session** prepares the destination before stopping the source. After
quiescing it captures a checkpoint, transfers ownership and activates a remote
chat. The source panel exposes the resulting run and follow-up controls.
Cross-device continuation uses the checkpoint summary inside the encrypted task
envelope. Same-device follow-ups use native resume. If the first activation fails
after ownership transfers, **Retry on destination** starts a fresh provider turn
from the checkpoint and preserves destination edits. Recovery also retries
submission and chat adoption while connected and after restart.

The generic and Cloudflare worker images install pinned Codex, Cursor and Devin
CLIs. Managed cloud runs support all six Desktop providers when enabled in
Settings → Sync & Mesh → Cloud agents. Codex is enabled by default; the other
providers require an explicit opt-in. OpenAI and Azure use Codex app-server;
LLMGateway uses the managed Codex adapter. For Codex cloud runs, the default is **Use my Codex login from this device**.
Anvil reads the launching host's `auth.json` from `CODEX_HOME`, or from
`~/.codex` when that variable is unset. It validates an account-auth cache before
submitting a new remote chat and before stopping the source for cloud handoff.
The cache travels inside an encrypted credential grant bound to the selected
trusted worker, exact attempt, fence and lease. It is never a sync entity,
plaintext job input, environment variable, activity message or renderer value.
Credential envelopes allow 128 KiB; the account cache itself is bounded to 64 KiB.

The worker writes the cache to a protected, session-scoped Codex home outside
the repository checkout and forces file credential storage. Codex can refresh
its own copy. Later turns retain that home, refreshed credentials and native
session files; an older host snapshot never overwrites the worker's refreshed
same-account cache. A different account is rejected. Source credentials are
not overwritten or updated from the worker. The cloud copy remains for the
worker lifetime and is removed with environment teardown.

Destination device-code sign-in remains an explicit fallback when the host has
no portable account cache, including when its CLI uses OS keyring storage.
An explicitly selected saved OpenAI API key remains available with separate API
billing. Both host caches and API keys use encrypted grants; a worker waits for
the required grant before spawning. Image builds contain no login state.
Cursor uses a one-time browser connection in Cloud agent settings. The official
Cursor SDK mints a named user API key, with its default 90-day lifetime, that
Anvil stores encrypted using the same secure-storage/vault mechanism as saved
integrations. The key is passed only to the selected live worker attempt. This
uses the user's Cursor plan; standard usage limits and enabled overages apply.
Expired or revoked connections require reconnecting. Disconnect removes Anvil's
saved key; revoke it in Cursor's dashboard to invalidate copies already delivered.

Devin Connect reuses a bounded, validated host CLI `credentials.toml`, or starts
`devin auth login` on the launching host if no login exists. Anvil saves the
connection encrypted. If the CLI cannot finish browser login, the user can run
the documented manual-token flow locally and connect again. Workers use a
protected session data home outside the checkout; the host file is never changed.
Disconnect prevents subsequent grants without signing out the host CLI.

OpenAI, Azure and LLMGateway reuse the saved provider keys after explicit cloud
opt-in. Azure also receives endpoint, deployment and API-version configuration;
LLMGateway retains the chosen devpass/payg catalog mode. Provider grants carry
only the selected provider's credentials, remain encrypted and are bound to the
trusted target, job, attempt, fence and lease. Workers wait for the grant before
spawning. Existing running processes retain credentials already delivered;
disabling a provider prevents new launches and new grants.

Desktop/BYO destinations retain destination-local provider setup. Private repository Git
credentials are not automatically copied from Desktop.

OpenAI documents [copying the account auth cache to headless workers](https://developers.openai.com/codex/auth#fallback-authenticate-locally-and-copy-your-auth-cache)
and [preserving refreshed account credentials on trusted CI runners](https://learn.chatgpt.com/docs/auth/ci-cd-auth).
This launch-host cache flow is the agreed cloud default and supersedes the
initial destination-device-code default recorded earlier on 3 October.
See the [image runbook](../../../cloud/images/anvil-worker/README.md) for runtime
pins, bootstrap channels and vault-key handling.

Live acceptance remains required on two physical devices and the real cloud
image. Test every provider you intend to ship, including authentication,
approval, cancellation, follow-up and source restart during handoff. Record
the candidate commit and results in
[ANV-11](https://linear.app/anvil-stack/issue/ANV-11/run-hosted-sync-staging-acceptance-for-pr-91).

## Verification on 3 October 2026

- Desktop suite: 1,892 passed, 12 skipped; Node and renderer TypeScript, ESLint,
  Electron build and daemon build passed.
- Backend suite: 440 passed; backend TypeScript passed. Private encrypted job
  inputs allow 512 KiB for workspace/checkpoint context, while public inputs
  remain 32 KiB and encrypted results remain 64 KiB.
- Generic Linux arm64 and Cloudflare Linux amd64 worker images built with the
  final daemon. Container checks passed fresh vault setup, restart, missing-key
  refusal, key permissions, Codex 0.154.0, host-cache account reads with optional account IDs, device-code schema support
  and optional API-provider configuration without ChatGPT account auth. Cursor
  2026.09.10-fd3934a and Devin 3000.11.3 passed version and ACP help checks
  from fresh homes with networking disabled. No real provider
  credentials were used and no inference task ran.
- Regression coverage includes scoped handoff recovery, preserving destination
  edits after failed activation, native follow-ups, exact preparation pins,
  deferred submission/cancellation, late API-key grants and fresh task-scoped
  workspace installation without the account sync key, host-cache grant binding,
  refreshed-cache preservation, different-user rejection, and explicit headless
  fallback for new chats and handoff, provider opt-in/disable checks, cancelled
  and expired Cursor connections, locked credential storage, provider-specific
  grant binding, Devin private cache reuse, and fresh-worker LLMGateway auth
  and billing-mode configuration.

Live host-cache authentication and refresh, fallback account sign-in, two-device operation, cloud execution/teardown, private
repository access and interactive UI acceptance remain pending in ANV-11.
The staging backend deployment still requires the correctly scoped Cloudflare
D1 deployment token. These local checks do not clear those gates.
