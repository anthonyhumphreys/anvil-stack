Reviewed commit: 7b399bd
Recommendation: request changes.

1. **P1 — Conflicts with current main, including a migration collision.**
   GitHub reports CONFLICTING; a local merge-tree check confirms eight conflicting files across schema, agent execution, tests, and UI.
   `anvil-app/src/main/db/schema.ts:1827` adds migration 60, but main already reaches 66. Gateway columns need a new migration after main’s latest version; retaining migration 60 would skip them for existing installations.
   Resolve the integration conflicts, preserve main’s migrations and UI removals, and test upgrading a current-main database.

2. **P2 — Changing billing mode during browser login can restore the previous selection.**
   Billing buttons remain active while connecting. SettingsView.tsx:623–634 applies the original billing mode when login finishes, overwriting a newer selection. The service also reuses any active login regardless of requested mode (llm-gateway.service.ts:336–344).
   Disable mode changes during login, or cancel/restart explicitly; make the service reject conflicting login attempts. Add a regression test.

Verification:
- Current reported GitHub checks pass, but they cover CodeQL and Vercel—not the desktop test/build suite.
- Earlier validation of this exact head passed 586 tests, lint, and build. These were not rerun during this review and do not validate integration with current main.
- Real macOS arm64 installation and mock Codex tool execution were previously verified.
- Live gateway login, billing, and model/tool execution remain unverified.

Before merging:
Resolve both findings, rerun desktop checks on the integrated result, and complete a live gateway smoke test. Confirm the gateway client/source registration before release.