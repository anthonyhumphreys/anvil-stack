# Managed staging transport evidence

Updated 6 October 2026. This record covers disposable synthetic-host transport
checks. It does not establish app sign-in, session authentication or physical
WAN acceptance.

## Staging configuration

Managed endpoints are enabled in staging for `anvilstack.dev`. Cloud Agents and
hosted checkout remain off; production managed endpoints remain off.

The Cloudflare account token is named `anvil-staging-managed-tunnels`. It is
stored as `CLOUDFLARE_TUNNEL_API_TOKEN` in the 1Password Anvil hosted staging
Environment and GitHub's protected `anvil-staging` environment. It expires
3 January 2027. Its permissions are **Cloudflare One Connector: cloudflared Write**
on the selected account and **DNS Write** on the selected `anvilstack.dev` zone.
Rotate it in both stores and redeploy staging before that expiry. The token
value is not recorded here.

Commit `a3a431d` fixed staging CI so it installs all six required runtime secrets:
three hosted identity/service secrets and three tunnel secrets. Commit `3a8353a`
fixed the Cloudflare native fetch receiver. Backend
[run 37413757753](https://github.com/anthonyhumphreys/anvil-stack/actions/runs/37413757753)
passed 42 test files with 442 tests and all six required runtime binding checks.

Commit `dedab943` fixed provider cleanup. SQLite `rowsWritten` includes index
maintenance, so it was not a reliable count of changed rows. Cleanup now uses
`UPDATE RETURNING`, with a regression test against real Durable Object SQLite.
Backend
[run 37414829188](https://github.com/anthonyhumphreys/anvil-stack/actions/runs/37414829188)
passed 42 test files and 443 tests.

## Smoke attempt on 6 October

On candidate `3a8353a`, the synthetic host allocated a managed endpoint, received
its connector token, started the connector and returned a marker over public
HTTPS. Those transport checks passed, but cleanup did not: SQLite
`cursor.rowsWritten` included index maintenance. Commit `dedab943` changed
cleanup to `UPDATE RETURNING` and added a real Durable Object SQLite regression
test. The first smoke after that fix verified provider cleanup, but public
marker ingress timed out.

A controlled repeat using temporary operator Node IPv4 flags passed allocation,
connector-token issuance, connector startup and public marker transport. Five
HTTP responses were observed (one 200, three 404s and one 530), with no network
errors. Release returned 200; the host advertisement was cleared, the synthetic
enrollment was revoked and the local token was removed.

The smoke script itself reported cleanup incomplete after direct Cloudflare DNS
and tunnel reads, and outer admin-token deletion, returned HTTP 429. After
refreshing the existing Wrangler authorization, independent checks confirmed
that the temporary `ENROLLMENT_ADMIN_TOKEN` was absent, the managed tunnel count
was zero (API status 200, pagination complete), and the authenticated DNS
dashboard showed zero host records. These independent checks verify provider
cleanup despite the script's raw rate-limited result. No further test allocation
is needed. This verifies synthetic transport and cleanup, not overall staging
acceptance.

The confirming staging deployment was `2824621c-0b24-4158-9c33-315b36c29b1c`,
version `46e7cd52-9ab6-47f2-a57d-65e75c431433`, after the temporary secret was
removed. Runtime inspection showed all six required bindings present, managed
endpoints enabled, Cloud Agents and checkout disabled, and the expected domain.
Physical two-WAN sessions, app sign-in/session authentication and device
recovery gates are still untested. Provider capacity, traffic terms and billed
cost also remain unverified.
