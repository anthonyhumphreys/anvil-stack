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

The generic and Cloudflare worker images install Codex for the initial launch.
Other providers remain available on enrolled desktops and BYO workers with
those runtimes configured. OpenAI and Azure use Codex app-server; LLMGateway uses the managed
Codex adapter. For Codex cloud runs, choose account sign-in on the destination or explicitly
choose your saved OpenAI API key. Account sign-in is the cloud default and uses Codex device-code login;
only its verification URL and public code appear in encrypted approval details.
Authentication must complete on the worker before a turn starts. The desktop's
OAuth cache is not copied. API keys use an encrypted grant pinned to the
executing attempt and fence; the worker waits for delivery before spawning.
API usage is separately billed. Each other provider needs its own destination
login. Repository cloning also requires access from the destination. Private
repository Git credentials are not automatically copied from Desktop. Image builds contain no provider credentials.
OpenAI documents [headless account sign-in](https://developers.openai.com/codex/auth#login-on-headless-devices)
and [maintaining refreshed account credentials on trusted CI runners](https://learn.chatgpt.com/docs/auth/ci-cd-auth).
API keys remain OpenAI's default recommendation for unattended CI automation.
See the [image runbook](../../../cloud/images/anvil-worker/README.md) for runtime
pins, bootstrap channels and vault-key handling.

Live acceptance remains required on two physical devices and the real cloud
image. Test every provider you intend to ship, including authentication,
approval, cancellation, follow-up and source restart during handoff. Record
the candidate commit and results in
[ANV-11](https://linear.app/anvil-stack/issue/ANV-11/run-hosted-sync-staging-acceptance-for-pr-91).

## Verification on 3 October 2026

- Desktop suite: 1,840 passed, 12 skipped; Node and renderer TypeScript, ESLint,
  Electron build and daemon build passed.
- Backend suite: 438 passed; backend TypeScript passed. Private encrypted job
  inputs allow 512 KiB for workspace/checkpoint context, while public inputs
  remain 32 KiB and encrypted results remain 64 KiB.
- Generic Linux arm64 and Cloudflare Linux amd64 worker images built with the
  final daemon. Container checks passed fresh vault setup, restart, missing-key
  refusal, key permissions, Codex 0.154.0, device-code schema support and optional
  API-provider configuration without ChatGPT account auth. No real provider
  credentials were used and no inference task ran.
- Regression coverage includes scoped handoff recovery, preserving destination
  edits after failed activation, native follow-ups, exact preparation pins,
  deferred submission/cancellation, late API-key grants and fresh task-scoped
  workspace installation without the account sync key.

Live account sign-in, two-device operation, cloud execution/teardown, private
repository access and interactive UI acceptance remain pending in ANV-11.
The staging backend deployment still requires the correctly scoped Cloudflare
D1 deployment token. These local checks do not clear those gates.
