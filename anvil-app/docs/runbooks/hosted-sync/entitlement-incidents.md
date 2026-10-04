# Free Sync and Mesh access incidents

Updated 3 October 2026 for the approved free Sync and Mesh offering. This describes the candidate
implementation, not evidence that the production backend has been deployed.

## Access decisions

An active account receives an active entitlement with `source: 'none'`, `reason: 'free'`, no plan or
funding source, no access expiry, and both `syncWrite` and `meshSubmit` enabled. A preview deadline,
canceled subscription, missing team seat, Stripe outage, or billing reconciliation failure must not
pause these free capabilities. Historical subscription records remain separate from current access.

Deleted or deleting accounts remain denied. Device session validity, local device trust, revocation,
account lifecycle, device limits, and operator fair-use restrictions are separate checks and must not
be bypassed to restore free access. The account coordinator still owns durable jobs and ownership.

The entitlement wire contract retains legacy state/source fields for compatibility. Do not infer
current permission from an old billing row or treat legacy `subscription-required`/`preview-ended`
responses as an instruction to sell a subscription.

## Investigating an unexpected pause

1. Record the backend/client versions, account scope, operation, HTTP status, and denial reason.
   Do not capture bearer tokens, provider keys, pairing secrets, or encrypted payloads.
2. Confirm the client and backend both implement the free entitlement contract, including `reason:
   'free'`. Old clients can reject an unknown reason or retain an old restricted entitlement cache.
3. Check whether the account is deleting/deleted or the device session has expired or been revoked.
   Reauthenticate through the normal account flow if appropriate. Never undo a deliberate revocation.
4. Inspect local trust/key-rotation state. Enabling free access does not make an untrusted device a
   trusted peer. Key-rotation failures must stop encrypted writes until resolved.
5. Check per-account device limits and operator fair-use restrictions. Explain the actual limit and
   supported recovery path. Subscription purchase is not a remedy.
6. For `subscription-required`, `preview-ended`, or a billing-only outage denial, treat it as a
   version/configuration regression. Verify the candidate's tests and roll forward through the
   selected-target deployment procedure. Do not alter subscription or preview flags to grant access.

Use [deploy.md](deploy.md) to select staging or production. Configuration must retain identity and
operator credentials and cannot enable development enrollment shortcuts in hosted production.

## Billing and historical subscriptions

New personal/team Sync checkout is disabled. Billing history, reconciliation, signed webhooks, and
portal/cancellation controls can remain for existing records. Stripe service health is not the free
Sync/Mesh authority. Never mark invoices paid, delete billing rows, cancel real subscriptions, or
issue refunds as an access repair.

Existing subscription cancellation/refund communication is a separate operator action. Test the
legacy portal path in staging if any existing subscribers need it. No production billing mutations
are included in this code rollout.

## Anvil Cloud Agents

`ANVIL_CLOUD_AGENTS_ENABLED` defaults to `'false'`. Only an exact `'true'` enables Anvil-operated
`anvil-managed` create/resume/bootstrap in the components that implement the flag. The backend and
provisioner must agree. The desktop exposes only its effective availability, not credentials.

Users' own machines, including machines in their cloud accounts, use free Mesh. BYO environment
providers retain their normal configuration requirements. Cloud Agent cleanup, suspension, deletion,
and status must remain available with the flag off. Do not enable paid execution merely to repair
Sync or pairing.

## Required regression evidence

Test free access after the former preview deadline, no subscription, canceled/unpaid legacy records,
and billing lookup failure. Also prove revoked sessions, deleted accounts, untrusted peers, operator
restrictions, and default-off Anvil Cloud Agent launch still deny the corresponding operation.
