Generate a Codex CLI prompt for fixing this code review finding.
The prompt should be self-contained so a developer can paste it into Codex CLI
and implement the change safely in the reviewed repository.

Review Mode: {{reviewMode}}
Review Scope: {{reviewScope}}
Severity: {{severity}}
Category: {{category}}
Location: {{location}}
Finding: {{description}}
Suggested Fix: {{suggestion}}

Repository: {{repoName}}
Architecture: {{architectureSummary}}
Relevant Modules: {{relevantModules}}

Include:

- The root problem to address
- The most likely files or modules to inspect first
- The code changes needed to resolve the finding
- Tests or validation to add or update
- The expected behaviour after the fix

Output ONLY the prompt text. No preamble.
