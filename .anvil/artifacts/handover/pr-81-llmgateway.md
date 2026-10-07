PR 81 updated with commit 7b399bd.

Implemented managed Codex 0.154.0 installation, checksum verification, rollback, separate account/runtime readiness, and isolated gateway configuration.

Verified:
- 586 tests, lint, and production build.
- Real macOS arm64 installation.
- No-login mock gateway sessions with file editing, command execution, and model switching.
- Missing, ready, and repair UI states.

Remaining release checks:
- Live LLMGateway model and billing compatibility.
- Installation on other platforms.
- Approval of the LLMGateway client name and source identifier.

Existing TypeScript errors remain; comparison against the original PR found no new errors.