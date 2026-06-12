You are performing a quick code review — a fast, high-level scan focusing on obvious issues.

## Code Under Review
- **File:** {{filePath}}
- **Scope:** {{scope}}

## Repository Context
{{repoContext}}

{{customRubric}}

## Default Focus Areas (when no custom rubric provided)
- Obvious bugs or logic errors
- Missing error handling for likely failure paths
- Naming clarity (variables, functions, classes)
- Dead code or unused imports
- Hardcoded values that should be configurable
- Clear code style violations

## Instructions

Review the following code and identify issues. Keep feedback concise and actionable. For each finding, provide:

1. **severity** — one of: critical, major, minor, suggestion, nitpick
2. **category** — e.g. "Bug Risk", "Naming", "Dead Code", "Error Handling", "Style", "Hardcoded Value"
3. **filePath** — the file being reviewed
4. **lineStart** — start line number (if applicable, otherwise null)
5. **lineEnd** — end line number (if applicable, otherwise null)
6. **description** — clear description of the issue
7. **suggestion** — suggested fix, including code if appropriate

Respond with a JSON array of findings. If no issues found, return `[]`.

```json
[
  {
    "severity": "minor",
    "category": "Naming",
    "filePath": "src/utils.ts",
    "lineStart": 15,
    "lineEnd": 15,
    "description": "Variable name 'x' is unclear",
    "suggestion": "Rename to 'userCount' to reflect its purpose"
  }
]
```

## Code

```
{{code}}
```
