Generate a Codex CLI prompt for implementing this work item.
The prompt should be self-contained — a developer should be able to paste it
into Codex CLI and get a working implementation.

Work Item: {{title}}
Type: {{type}}
Description: {{description}}
Acceptance Criteria: {{acceptanceCriteria}}

Repository: {{repoName}}
Architecture: {{architectureSummary}}
Relevant Modules: {{relevantModules}}

Include:
- Clear description of what to change
- Specific files to modify
- Expected behaviour after the fix
- Test cases to verify

Output ONLY the prompt text. No preamble.
