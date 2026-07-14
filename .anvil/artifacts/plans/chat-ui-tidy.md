# Chat UI tidy and isolation plan

## Outcome

Make chat workspace-safe, keep streamed assistant prose coherent around tool activity, and reduce visual clutter without weakening operational visibility.

## Plan

1. Harden workspace ownership
   - Add stale-request protection to active workspace loading.
   - Reset chat-visible state immediately when workspace or layout scope changes.
   - Filter returned threads against the requested workspace before rendering.
   - Refuse to load/select a thread whose workspace does not match the active workspace.
   - Add focused regression tests for cross-workspace lists and stale selection.

2. Compose each agent turn coherently
   - Introduce a pure turn-display grouper.
   - Collect tool calls, commands, reads, edits, approvals, plans, and goals into one activity group per assistant turn.
   - Merge assistant stream fragments across those operational events into one readable response while preserving persisted event evidence.
   - Add tests for text/tool/text streams, multiple commands, thinking, failures, and user-turn boundaries.

3. Distill the chat surface
   - Remove repeated thread-rail labels and reduce card-on-card styling.
   - Make thread rows compact list items with clearer selected/running states.
   - Constrain assistant prose width and give user prompts, activity, and final response distinct hierarchy.
   - Keep operational details collapsed by default, with failure and running states visible.

4. Harden and polish
   - Preserve keyboard access, focus visibility, long-title wrapping, reduced motion, and non-colour status cues.
   - Run focused Vitest coverage, full tests, lint, build, and the Impeccable audit fallback.
   - Re-launch the isolated Electron build for a final smoke test.