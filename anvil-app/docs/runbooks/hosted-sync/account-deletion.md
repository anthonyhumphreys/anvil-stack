# Account deletion — hosted sync

Historical packet reference: **BILL-06** operations. Deleting sync data, deleting the whole Anvil
account and canceling a subscription are separate, explicitly named actions.
This runbook covers full account deletion.

## Flow

Website account/data page → signed `POST /internal/hosted/delete-account` →
SessionCoordinator `/internal/delete-account-by-id` → tombstone + session
revocation + retryable purge inside the session object → billing row
`lifecycle` moves `active` → `deleting` → `deleted`.

Idempotent: a repeat while `deleting` re-drives the same flow and reports
current state; a fully `deleted` row denies with `account-deleted`. The
transition is audited (`account.delete-requested` in `billing_audit`).

## What happens to each piece

- **Sync data** — purged inside the account/session objects with retries.
  Signed `POST /internal/hosted/data-status` reports
  `{syncAccountId, tombstoned, deletion:{state, purgedRows}}` to the website.
- **Billing row** — `lifecycle='deleting'` then `'deleted'`. The row is
  kept: it prevents resurrection — late webhooks or the same WorkOS identity
  signing back in cannot recreate the deleted account or transfer its
  entitlement to a new account generation.
- **Subscription** — cancellation is expected to arrive via the website's
  delete flow and Stripe's webhook (`customer.subscription.deleted`), which
  lands on the mapped customer row and cannot relink it. Verify in the
  Stripe dashboard that the subscription reached `canceled` after a live
  deletion; if it didn't, cancel it manually in Stripe — do not delete the
  D1 rows.
- **Devices** — sessions are revoked during deletion. Enrolled devices lose
  access immediately; a returning user re-enrolls under a new account
  generation, never the old one.
- **WorkOS** — separate system. Anvil-side deletion does **not** delete the
  WorkOS user. When full identity removal is requested, delete the user in
  the WorkOS dashboard as a distinct step. The `lifecycle='deleted'` billing
  row means the same WorkOS user signing back in starts a fresh billing
  account.

## The 90-day recovery note — what it actually means

The launch plan proposes a 90-day hosted data recovery window after access
ends. That is a **policy decision, not a mechanism**: no automated cleanup or
expiry-deletion job exists, and none should be invented. Consequences:

- Do not promise users a guaranteed restore path — retention is a stated
  policy window, not a contracted SLA.
- Do not run destructive cleanup "to match" the window without an approved,
  implemented job.
- Distinct clock: the sync protocol's own 90-day change/receipt retention
  (journal compaction) is unrelated to account recovery. Same number,
  different thing.

## Operator checks

```sh
pnpm exec wrangler d1 execute anvil-hosted-billing --remote --config wrangler.hosted.jsonc \
  --command "SELECT id, lifecycle, sync_account_id FROM billing_accounts WHERE id = '<id>'"
```

Signed `/internal/hosted/data-status` returns live purge state. A row stuck
at `deleting` means the session-object purge is still retrying — re-drive it
by repeating the signed delete call; do not force `lifecycle='deleted'` by
hand while rows remain.
