# Optional four-device rehearsal

Use this for deeper staging checks across two physical computers, a browser,
and an iPhone. The required deployed gates are in
[staging-acceptance.md](staging-acceptance.md). This rehearsal adds device
trust and companion policy checks; it does not replace those gates.

Use the same clean source commit and current candidate build on both computers
and every optional client. Confirm the backend advertises
`anvil-backend/1`, `sync/2`, and `mesh/2` before sign-in. Use a new disposable
staging account, fresh app data on Device B, and harmless named test data.
Never copy a working-tree archive, `.env`, database, recovery code, device
code, bearer token, or provider credential to another device or into the test
record. Device B checks out or maps its own repository.

## Device trust and recovery

1. On Device A, leave new-device trust set to require approval. Enroll B using
   the staging WorkOS device flow. On both devices, compare the short
   verification code through the UI and approve the matching code. Confirm B
   is trusted and receives the account key only after approval.
2. Enroll a fresh B profile while A is offline using the supported recovery
   flow. Unlock with the recovery code through the documented stdin prompt.
   Confirm existing encrypted account data arrives. A wrong code must fail
   without changing the new session.
3. Sign in with a disposable daemon profile, leave its Mesh worker disabled,
   and confirm companion access still works while it does not claim a Mesh
   job. Enable the worker explicitly, restart it, and confirm it can claim a
   harmless bounded job. Worker opt-in must not change companion access.

For exact enrollment and daemon commands, use the current
[headless daemon guide](headless-daemon.md). Keep each enrollment in its own
fresh data directory.

## Browser access

Use a fresh private browser profile and the same staging account. A dashboard
request must remain locked until a trusted device handles it. Deny one request
and confirm it stays locked. Request again, approve only read access, reload
that tab, and confirm it reconnects at the same scope. Revoke the active grant
from Device A and confirm the browser locks and stops requests. A newly
approved read-only grant must reconnect without reviving the revoked grant.

## iPhone companion

Build or install the companion from the candidate source. Pair it to the same
disposable account and host. Exercise one secure private route at a time, such
as the same trusted Wi-Fi or the account's Tailscale route. Do not port-forward
the companion listener.

Set the account-connected phone policy to `observe`. Confirm reads work but
approval and steering requests fail. Change it to `approve`; approval actions
should work while chat or workflow steering remains denied. Change it to
`steer` and confirm the permitted steering action works. Set the policy to
`denied` or forget the phone, then confirm requests fail closed. A denial or
lower policy must not fall back to another endpoint. Re-enrollment must create
a fresh pending policy.

After revoking a phone or host, allow at most 60 seconds for the documented
attestation cache to expire. Confirm hosted access ends while local desktop
data remains available.

The native mobile WebSocket implementation may assemble an inbound frame
before JavaScript receives it. A controlled staging pass records product
behavior with the current source; it does not establish a native pre-assembly
size cap or clear the public rollout gate.

## Raycast

Use the extension built from the same candidate source. Connect in
account-connected mode to the disposable staging account, then open Overview,
review a pending approval, and run a harmless bounded workflow. Confirm the
approval scope and result match the desktop, and reconnect after closing and
reopening Raycast. Do not use a production account or reuse a revoked grant.

Record each scenario as `PASS`, `FAIL`, or `BLOCKED`, with the source SHA,
device/client build, network path, and sanitized result. Keep tokens, user
content, recovery material, and full logs out of the record.
